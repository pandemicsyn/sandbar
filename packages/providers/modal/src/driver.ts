import { DriverCapabilities, DriverResult, NativeRef, NativeScope, ProviderReadError, SandboxObservation, type InvocationIdentity, type ProviderDriver } from "@sandbar/provider-spi";
import type { ExecCommand } from "@sandbar/contracts";
import { z } from "zod";
import type { ModalSandboxRecord, ModalTransport } from "./transport";

const TAG_SUBMISSION = "sandbar_submission";
const TAG_OPERATION = "sandbar_operation";
const MAX_FILE_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 1_048_576;
const ModalRecord = z.object({ id: z.string().min(1).max(128), tags: z.record(z.string(), z.string()), running: z.boolean() });

type ModalAppScope = NativeScope & { resourceScope: { kind: "app"; id: string } };

function modalAppId(scope: NativeScope): string {
  const value = (scope as Partial<ModalAppScope>).resourceScope;
  if (!value || value.kind !== "app" || !/^ap-[A-Za-z0-9_-]+$/.test(value.id)) throw new Error("Modal requires a verified native app scope");
  return value.id;
}
function rejected(code: "unsupported" | "invalid" | "not_found" | "unavailable", message: string): DriverResult {
  return { status: "rejected", effect: "none", error: { code, message, effect: "none", retry: "never" } };
}
function unknown(submissionId: string, reason: string): DriverResult {
  return { status: "unknown", effect: "possible", submissionId, reason };
}
function observation(scope: NativeScope, record: ModalSandboxRecord): SandboxObservation {
  const parsed = ModalRecord.parse(record);
  return SandboxObservation.parse({ ref: { scope, nativeId: parsed.id, kind: "sandbox" }, state: parsed.running ? "running" : "unknown", observedAt: new Date().toISOString() });
}
function isOwned(record: ModalSandboxRecord, identity: InvocationIdentity): boolean {
  return record.tags[TAG_SUBMISSION] === identity.submissionId && record.tags[TAG_OPERATION] === identity.operationId;
}

/** Modal's safe 0.10.1 subset. Unsupported mutations fail before provider effects. */
export class ModalProviderDriver implements ProviderDriver {
  readonly name = "modal";
  constructor(
    readonly scope: ModalAppScope,
    private readonly appName: string,
    private readonly environment: string,
    private readonly timeoutMs: number,
    private readonly transport: ModalTransport,
  ) { modalAppId(scope); }

  private matches(scope: NativeScope): boolean {
    return scope.provider === this.scope.provider && scope.connectionId === this.scope.connectionId && ("endpoint" in scope ? scope.endpoint : undefined) === ("endpoint" in this.scope ? this.scope.endpoint : undefined) && scope.region === this.scope.region && modalAppId(scope) === modalAppId(this.scope);
  }
  private async verify(): Promise<void> {
    const appId = await this.transport.lookupApp(this.appName, this.environment);
    if (appId !== modalAppId(this.scope)) throw new Error("Modal native app scope changed");
  }
  private async find(ref: NativeRef): Promise<ModalSandboxRecord | null> {
    if (ref.kind !== "sandbox" || !this.matches(ref.scope)) throw new ProviderReadError("INVALID_RESPONSE", "Modal sandbox scope mismatch");
    await this.verify();
    for await (const record of this.transport.list(modalAppId(this.scope))) {
      if (record.id === ref.nativeId) return record;
    }
    return null;
  }
  async capabilities(scope: NativeScope) {
    if (!this.matches(scope)) throw new ProviderReadError("INVALID_RESPONSE", "Modal scope mismatch");
    await this.verify();
    return DriverCapabilities.parse({
      provider: this.name,
      nativeIdempotency: { create: false, exec: false, destroy: false, writeFile: false },
      discoveryBySubmission: false,
      supports: { argv: false, shell: false, fileBytes: false, inventory: true },
      maxFileBytes: MAX_FILE_BYTES,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      networkPolicies: ["blocked"],
    });
  }
  async prepare(input: { scope: NativeScope; image: { kind: "prepared" | "oci"; value: string }; networkPolicy: string; region?: string }) {
    if (!this.matches(input.scope)) return { supported: false, reason: "Modal scope mismatch" };
    if (input.networkPolicy !== "blocked") return { supported: false, reason: "Modal adapter requires blocked outbound network" };
    if (input.image.kind !== "prepared" || !/^im-[A-Za-z0-9_-]+$/.test(input.image.value)) return { supported: false, reason: "Use an existing Modal image ID; OCI imports require a separate paid preparation operation" };
    if (input.region !== undefined && input.region !== this.scope.region) return { supported: false, reason: "Modal region differs from configured native region" };
    await this.verify();
    return await this.transport.imageExists(input.image.value)
      ? { supported: true, effectiveImage: input.image.value }
      : { supported: false, reason: "Modal image ID was not found in this credential scope" };
  }
  async create(input: { scope: NativeScope; identity: InvocationIdentity; image: string; networkPolicy: string; labels?: Record<string, string> }): Promise<DriverResult> {
    if (!this.matches(input.scope) || input.networkPolicy !== "blocked" || !/^im-[A-Za-z0-9_-]+$/.test(input.image)) return rejected("unsupported", "Modal create scope, network policy or prepared image is unsupported");
    if (input.identity.submissionId.length >= 64) return rejected("invalid", "Modal sandbox name exceeds native limit");
    const labels = input.labels ?? {};
    if (Object.keys(labels).some(key => key.startsWith("sandbar_"))) return rejected("invalid", "Reserved Modal tag prefix");
    try { await this.verify(); }
    catch { return rejected("invalid", "Modal native app scope could not be verified before create"); }
    try { if (!(await this.transport.imageExists(input.image))) return rejected("not_found", "Modal image was not found before create"); }
    catch { return rejected("unavailable", "Modal image could not be verified before create"); }
    const tags = { ...labels, [TAG_SUBMISSION]: input.identity.submissionId, [TAG_OPERATION]: input.identity.operationId };
    try {
      const id = await this.transport.create({ appId: modalAppId(this.scope), imageId: input.image, name: input.identity.submissionId, tags, timeoutMs: this.timeoutMs, ...(this.scope.region ? { regions: [this.scope.region] } : {}) });
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return unknown(input.identity.submissionId, "Modal create response lacked a valid sandbox ID");
      const record = await this.transport.findByName(this.appName, this.environment, input.identity.submissionId);
      if (!record || record.id !== id || !isOwned(record, input.identity)) return unknown(input.identity.submissionId, "Modal create identity could not be correlated");
      return DriverResult.parse({ status: "completed", effect: "applied", submissionId: input.identity.submissionId, value: { kind: "sandbox", observation: observation(this.scope, record) } });
    } catch {
      return unknown(input.identity.submissionId, "Modal create response unavailable; observe by native name without replay");
    }
  }
  async inspect(ref: NativeRef): Promise<SandboxObservation | null> {
    const record = await this.find(ref);
    return record ? observation(this.scope, record) : null;
  }
  async inventory(input: { scope: NativeScope; cursor?: string; limit: number }) {
    if (!this.matches(input.scope)) throw new ProviderReadError("INVALID_RESPONSE", "Modal inventory scope mismatch");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new RangeError("Invalid inventory limit");
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Invalid inventory cursor");
    await this.verify();
    const items: SandboxObservation[] = [];
    let position = 0;
    for await (const record of this.transport.list(modalAppId(this.scope))) {
      if (position++ < offset) continue;
      items.push(observation(this.scope, record));
      if (items.length > input.limit) break;
    }
    return { items: items.slice(0, input.limit), ...(items.length > input.limit ? { nextCursor: String(offset + input.limit) } : {}) };
  }
  async exec(_input: { sandbox: NativeRef; identity: InvocationIdentity; command: ExecCommand; cwd?: string; env?: Record<string, string>; deadlineSeconds: number; maxOutputBytes: number }): Promise<DriverResult> {
    return rejected("unsupported", "Modal SDK task-router exec retries uncertain starts; safe execution transport is not yet available");
  }
  async readFile(input: { sandbox: NativeRef; path: string }): Promise<Uint8Array> {
    if (!await this.find(input.sandbox)) throw new ProviderReadError("NOT_FOUND", "Modal sandbox not found in verified app");
    try { return await this.transport.readBytes(input.sandbox.nativeId, input.path, MAX_FILE_BYTES); }
    catch (error) { if (error instanceof ProviderReadError) throw error; throw new ProviderReadError("INVALID_RESPONSE", "Modal file read unavailable or exceeded byte limit"); }
  }
  async writeFile(_input: { sandbox: NativeRef; identity: InvocationIdentity; path: string; bytes: Uint8Array; overwrite: boolean }): Promise<DriverResult> {
    return rejected("unsupported", "Modal SDK filesystem writes retry uncertain effects and cannot enforce no-clobber");
  }
  async destroy(input: { sandbox: NativeRef; identity: InvocationIdentity }): Promise<DriverResult> {
    let record: ModalSandboxRecord | null;
    try { record = await this.find(input.sandbox); }
    catch { return rejected("invalid", "Modal sandbox scope could not be verified before destroy"); }
    if (!record) return rejected("not_found", "Modal sandbox not found in verified app");
    try {
      const stopped = await this.transport.terminate(record.id);
      if (!stopped) return unknown(input.identity.submissionId, "Modal termination was not observed");
      return DriverResult.parse({ status: "completed", effect: "applied", submissionId: input.identity.submissionId, value: { kind: "destroy", observation: { sandbox: input.sandbox, computeStopped: true, retainedResources: [] } } });
    } catch { return unknown(input.identity.submissionId, "Modal termination response unavailable; do not replay"); }
  }
  async observe(input: { scope: NativeScope; submissionId: string }): Promise<DriverResult | null> {
    if (!this.matches(input.scope)) throw new ProviderReadError("INVALID_RESPONSE", "Modal observation scope mismatch");
    await this.verify();
    const record = await this.transport.findByName(this.appName, this.environment, input.submissionId);
    if (!record || record.tags[TAG_SUBMISSION] !== input.submissionId || !record.tags[TAG_OPERATION]) return null;
    return DriverResult.parse({ status: "completed", effect: "applied", submissionId: input.submissionId, value: { kind: "sandbox", observation: observation(this.scope, record) } });
  }
  close() { this.transport.close(); }
}
