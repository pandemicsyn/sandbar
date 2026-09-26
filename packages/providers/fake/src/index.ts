import { DriverCapabilities, DriverResult, SandboxObservation, NativeScope, type ProviderDriver, type NativeRef, type InvocationIdentity } from "@sandbar/provider-spi";
import type { ExecCommand } from "@sandbar/contracts";
import { FakeAction } from "./protocol";
import { FakeEvent } from "./engine";

export class FakeProviderDriver implements ProviderDriver {
  readonly name = "fake";
  constructor(private readonly options: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    const endpoint = new URL(options.baseUrl);
    if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "[::1]") || endpoint.username || endpoint.password) {
      throw new Error("Fake provider driver requires a loopback HTTP endpoint");
    }
  }

  private async call(action: FakeAction): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(new URL("/v1/action", this.options.baseUrl), { method: "POST", headers: { Authorization: `Bearer ${this.options.token}`, "Content-Type": "application/json" }, body: JSON.stringify(action) });
    if (!response.ok) throw new FakeTransportError(response.status);
    return response.json();
  }
  private async mutation(action: FakeAction, submissionId: string): Promise<DriverResult> {
    try { return DriverResult.parse(await this.call(action)); }
    catch (error) {
      if (error instanceof FakeTransportError && [400, 401, 403, 404, 413].includes(error.status)) {
        const code = error.status === 401 || error.status === 403 ? "unauthorized" : error.status === 404 ? "not_found" : error.status === 413 ? "capacity" : "invalid";
        return { status: "rejected", effect: "none", error: { code, message: `Fake provider rejected request before dispatch (${error.status})`, effect: "none", retry: "never" } };
      }
      return { status: "unknown", effect: "possible", submissionId, reason: "Fake provider submission response unavailable or invalid; observe without replay" };
    }
  }
  async capabilities(scope: NativeScope) { return DriverCapabilities.parse(await this.call({ kind: "capabilities", scope })); }
  async prepare(input: { scope: NativeScope; image: { kind: "prepared" | "oci"; value: string }; networkPolicy: string; region?: string }) {
    const cap = await this.capabilities(input.scope);
    const supported = input.image.kind === "prepared" && input.image.value === "fake-starter" && input.networkPolicy === "blocked" && (!input.region || input.region === "local") && cap.networkPolicies.includes("blocked");
    return supported ? { supported: true, effectiveImage: "fake-starter" } : { supported: false, reason: "Fake provider only supports prepared fake-starter, local region, blocked network" };
  }
  async create(input: { scope: NativeScope; identity: InvocationIdentity; image: string; networkPolicy: string; labels?: Record<string, string> }) {
    return this.mutation({ kind: "create", scope: input.scope, identity: input.identity, image: input.image, networkPolicy: input.networkPolicy, labels: input.labels }, input.identity.submissionId);
  }
  async inspect(ref: NativeRef) { const value = await this.call({ kind: "inspect", ref }); return value === null ? null : SandboxObservation.parse(value); }
  async inventory(input: { scope: NativeScope; cursor?: string; limit: number }) {
    const value = await this.call({ kind: "inventory", ...input }) as { items: unknown[]; nextCursor?: string };
    return { items: value.items.map(x => SandboxObservation.parse(x)), nextCursor: value.nextCursor };
  }
  async exec(input: { sandbox: NativeRef; identity: InvocationIdentity; command: ExecCommand; cwd?: string; env?: Record<string, string>; deadlineSeconds: number; maxOutputBytes: number }): Promise<DriverResult> {
    return this.mutation({ kind: "exec", sandbox: input.sandbox, identity: input.identity, command: input.command, cwd: input.cwd, env: input.env, deadlineSeconds: input.deadlineSeconds, maxOutputBytes: input.maxOutputBytes }, input.identity.submissionId);
  }
  async readFile(input: { sandbox: NativeRef; path: string }): Promise<Uint8Array> {
    const value = await this.call({ kind: "readFile", ...input }) as { bytesBase64: string | null };
    if (value.bytesBase64 === null) throw new Error("Fake file not found");
    return Uint8Array.from(Buffer.from(value.bytesBase64, "base64"));
  }
  async writeFile(input: { sandbox: NativeRef; identity: InvocationIdentity; path: string; bytes: Uint8Array; overwrite: boolean }): Promise<DriverResult> {
    return this.mutation({ kind: "writeFile", sandbox: input.sandbox, identity: input.identity, path: input.path, bytesBase64: Buffer.from(input.bytes).toString("base64"), overwrite: input.overwrite }, input.identity.submissionId);
  }
  async destroy(input: { sandbox: NativeRef; identity: InvocationIdentity }) { return this.mutation({ kind: "destroy", ...input }, input.identity.submissionId); }
  async observe(input: { scope: NativeScope; submissionId: string }) { const value = await this.call({ kind: "observe", ...input }); return value === null ? null : DriverResult.parse(value); }
  async events(scope: NativeScope) { const value = await this.call({ kind: "events", scope }); return FakeEvent.array().parse(value); }
}

export { FakeScenario, FakeProfile, FakeEvent } from "./engine";
export { startFakeProviderServer } from "./server";

class FakeTransportError extends Error { constructor(readonly status: number) { super(`Fake provider transport status ${status}`); } }
