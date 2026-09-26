import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { ExecCommand } from "@sandbar/contracts";
import { DriverResult, type NativeRef, type NativeScope, type InvocationIdentity } from "@sandbar/provider-spi";

const CommandFixture = z.strictObject({ command: ExecCommand, exitCode: z.number().int(), stdoutBase64: z.base64().default(""), stderrBase64: z.base64().default("") });
export const FakeScenario = z.strictObject({
  submissionId: z.string().min(1), action: z.enum(["create", "exec", "destroy"]),
  behavior: z.enum(["normal", "lost_after_effect", "reject", "ambiguous_before_effect"]).default("normal"),
  delayObservations: z.number().int().min(0).max(100).default(0),
  rejectCode: z.enum(["capacity", "unsupported", "conflict"]).default("capacity"),
  nativeIdempotency: z.boolean().default(true),
  discoveryBySubmission: z.boolean().default(true),
  command: CommandFixture.optional(),
});
export type FakeScenario = z.infer<typeof FakeScenario>;
type Resource = { ref: NativeRef; state: "running" | "destroyed"; image: string; networkPolicy: string; files: Record<string, string>; sequence: number };
type LedgerEntry = { submissionId: string; action: FakeScenario["action"]; result: z.infer<typeof DriverResult>; remaining: number; discoverable: boolean };
export const FakeProfile = z.strictObject({ nativeIdempotency: z.strictObject({ create: z.boolean(), exec: z.boolean(), destroy: z.boolean() }), discoveryBySubmission: z.boolean() });
type State = { version: 1; nextId: number; tick: number; profile: z.infer<typeof FakeProfile>; resources: Resource[]; ledger: LedgerEntry[]; scenarios: FakeScenario[]; invocations: { submissionId: string; action: string }[] };
const empty = (): State => ({ version: 1, nextId: 1, tick: 0, profile: { nativeIdempotency: { create: true, exec: true, destroy: true }, discoveryBySubmission: true }, resources: [], ledger: [], scenarios: [], invocations: [] });
const MAX_RESOURCES = 128, MAX_LEDGER = 512, MAX_FILE_BYTES = 1024 * 1024, MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const scopeKey = (scope: NativeScope) => `${scope.provider}\0${scope.connectionId}\0${scope.accountId}\0${scope.region ?? ""}`;
const sameScope = (a: NativeScope, b: NativeScope) => scopeKey(a) === scopeKey(b);
const iso = (tick: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
const bytesLength = (b64: string) => Buffer.from(b64, "base64").length;

export class FakeProviderEngine {
  private state: State = empty();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly statePath: string, readonly testMode: boolean) {}

  async load(): Promise<void> {
    try { this.state = JSON.parse(await readFile(this.statePath, "utf8")) as State; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (this.state.version !== 1) throw new Error("Unsupported fake provider state version");
  }
  private async save(): Promise<void> {
    const json = JSON.stringify(this.state);
    if (Buffer.byteLength(json) > MAX_TOTAL_BYTES) throw new Error("Fake provider state limit reached");
    const temp = `${this.statePath}.tmp`;
    await writeFile(temp, json, { mode: 0o600 });
    await rename(temp, this.statePath);
  }
  private async mutate<T>(fn: () => T): Promise<T> {
    const work = this.pending.then(async () => { const previous = structuredClone(this.state); try { const value = fn(); await this.save(); return value; } catch (error) { this.state = previous; throw error; } });
    this.pending = work.catch(() => undefined);
    return work;
  }
  private scenario(submissionId: string, action: FakeScenario["action"]): FakeScenario {
    return this.state.scenarios.find(x => x.submissionId === submissionId && x.action === action) ?? FakeScenario.parse({ submissionId, action });
  }
  private ref(scope: NativeScope, kind: "sandbox" | "execution"): NativeRef {
    return { scope, kind, nativeId: `fake_${kind}_${this.state.nextId++}` };
  }
  private find(ref: NativeRef): Resource | undefined {
    return this.state.resources.find(x => sameScope(x.ref.scope, ref.scope) && x.ref.nativeId === ref.nativeId && ref.kind === "sandbox");
  }
  private rejection(code: "capacity" | "unsupported" | "conflict"): z.infer<typeof DriverResult> {
    return { status: "rejected", effect: "none", error: { code, message: `Fake fixture rejected ${code}`, effect: "none", retry: "never" } };
  }
  async reset(): Promise<void> { if (!this.testMode) throw new Error("Test mode required"); await this.mutate(() => { this.state = empty(); }); }
  async seed(scenario: unknown): Promise<void> {
    if (!this.testMode) throw new Error("Test mode required");
    const parsed = FakeScenario.parse(scenario);
    await this.mutate(() => { this.state.scenarios = this.state.scenarios.filter(x => !(x.submissionId === parsed.submissionId && x.action === parsed.action)); this.state.scenarios.push(parsed); });
  }
  async setProfile(profile: unknown): Promise<void> {
    if (!this.testMode) throw new Error("Test mode required");
    const parsed = FakeProfile.parse(profile);
    await this.mutate(() => { this.state.profile = parsed; });
  }
  profile() { return structuredClone(this.state.profile); }
  snapshot(): Omit<State, "scenarios"> {
    if (!this.testMode) throw new Error("Test mode required");
    const { scenarios: _scenarios, ...rest } = this.state;
    return structuredClone(rest);
  }
  async create(input: { scope: NativeScope; identity: InvocationIdentity; image: string; networkPolicy: string }): Promise<{ result: z.infer<typeof DriverResult>; loseResponse: boolean }> {
    return this.mutate(() => {
      const { submissionId } = input.identity;
      const prior = this.state.ledger.find(x => x.submissionId === submissionId);
      const scenario = this.scenario(submissionId, "create");
      if (prior) return { result: this.state.profile.nativeIdempotency.create && scenario.nativeIdempotency ? prior.result : this.rejection("conflict"), loseResponse: false };
      this.state.invocations.push({ submissionId, action: "create" });
      if (scenario.behavior === "reject") return { result: this.rejection(scenario.rejectCode), loseResponse: false };
      if (scenario.behavior === "ambiguous_before_effect") return { result: { status: "unknown", effect: "possible", submissionId, reason: "Submission acknowledgement lost" } as const, loseResponse: true };
      if (this.state.resources.length >= MAX_RESOURCES) return { result: this.rejection("capacity"), loseResponse: false };
      const ref = this.ref(input.scope, "sandbox");
      this.state.resources.push({ ref, state: "running", image: input.image, networkPolicy: input.networkPolicy, files: {}, sequence: 1 });
      const result: z.infer<typeof DriverResult> = { status: "completed", effect: "applied", value: { kind: "sandbox", observation: { ref, state: "running", observedAt: iso(this.state.tick++), sourceSequence: 1 } } };
      if (this.state.ledger.length >= MAX_LEDGER) throw new Error("Fake ledger limit reached");
      this.state.ledger.push({ submissionId, action: "create", result, remaining: scenario.delayObservations, discoverable: this.state.profile.discoveryBySubmission && scenario.discoveryBySubmission });
      return { result: scenario.delayObservations ? { status: "pending", effect: "possible", submissionId, observeAfterMs: 0 } as const : result, loseResponse: scenario.behavior === "lost_after_effect" };
    });
  }
  async exec(input: { sandbox: NativeRef; identity: InvocationIdentity; command: z.infer<typeof ExecCommand>; maxOutputBytes: number }): Promise<{ result: z.infer<typeof DriverResult>; loseResponse: boolean }> {
    return this.mutate(() => {
      const { submissionId } = input.identity;
      const prior = this.state.ledger.find(x => x.submissionId === submissionId);
      const scenario = this.scenario(submissionId, "exec");
      if (prior) return { result: this.state.profile.nativeIdempotency.exec && scenario.nativeIdempotency ? prior.result : this.rejection("conflict"), loseResponse: false };
      this.state.invocations.push({ submissionId, action: "exec" });
      if (scenario.behavior === "reject") return { result: this.rejection(scenario.rejectCode), loseResponse: false };
      if (scenario.behavior === "ambiguous_before_effect") return { result: { status: "unknown", effect: "possible", submissionId, reason: "Submission acknowledgement lost" } as const, loseResponse: true };
      const resource = this.find(input.sandbox);
      if (!resource || resource.state !== "running") return { result: { status: "rejected", effect: "none", error: { code: "not_found", message: "Fake sandbox not found", effect: "none", retry: "never" } } as const, loseResponse: false };
      const fixture = scenario.command;
      if (!fixture || JSON.stringify(fixture.command) !== JSON.stringify(input.command)) return { result: this.rejection("unsupported"), loseResponse: false };
      const stdout = Buffer.from(fixture.stdoutBase64, "base64"), stderr = Buffer.from(fixture.stderrBase64, "base64");
      const cap = Math.min(input.maxOutputBytes, 1048576);
      const stdoutKept = stdout.subarray(0, cap), stderrKept = stderr.subarray(0, Math.max(0, cap - stdoutKept.length));
      const ref = this.ref(input.sandbox.scope, "execution");
      const result: z.infer<typeof DriverResult> = { status: "completed", effect: "applied", value: { kind: "execution", observation: { ref, sandbox: input.sandbox, completed: true, exitCode: fixture.exitCode, stdoutBase64: stdoutKept.toString("base64"), stderrBase64: stderrKept.toString("base64"), truncated: stdoutKept.length < stdout.length || stderrKept.length < stderr.length, observedAt: iso(this.state.tick++) } } };
      if (this.state.ledger.length >= MAX_LEDGER) return { result: this.rejection("capacity"), loseResponse: false };
      this.state.ledger.push({ submissionId, action: "exec", result, remaining: scenario.delayObservations, discoverable: this.state.profile.discoveryBySubmission && scenario.discoveryBySubmission });
      return { result: scenario.delayObservations ? { status: "pending", effect: "possible", submissionId, observeAfterMs: 0 } as const : result, loseResponse: scenario.behavior === "lost_after_effect" };
    });
  }
  async destroy(input: { sandbox: NativeRef; identity: InvocationIdentity }): Promise<{ result: z.infer<typeof DriverResult>; loseResponse: boolean }> {
    return this.mutate(() => {
      const { submissionId } = input.identity;
      const prior = this.state.ledger.find(x => x.submissionId === submissionId);
      const scenario = this.scenario(submissionId, "destroy");
      if (prior) return { result: this.state.profile.nativeIdempotency.destroy && scenario.nativeIdempotency ? prior.result : this.rejection("conflict"), loseResponse: false };
      this.state.invocations.push({ submissionId, action: "destroy" });
      if (scenario.behavior === "reject") return { result: this.rejection(scenario.rejectCode), loseResponse: false };
      if (scenario.behavior === "ambiguous_before_effect") return { result: { status: "unknown", effect: "possible", submissionId, reason: "Submission acknowledgement lost" } as const, loseResponse: true };
      const resource = this.find(input.sandbox);
      if (!resource) return { result: { status: "rejected", effect: "none", error: { code: "not_found", message: "Fake sandbox not found", effect: "none", retry: "never" } } as const, loseResponse: false };
      resource.state = "destroyed"; resource.sequence++;
      const result: z.infer<typeof DriverResult> = { status: "completed", effect: "applied", value: { kind: "destroy", observation: { sandbox: input.sandbox, computeStopped: true, retainedResources: [] } } };
      if (this.state.ledger.length >= MAX_LEDGER) throw new Error("Fake ledger limit reached");
      this.state.ledger.push({ submissionId, action: "destroy", result, remaining: scenario.delayObservations, discoverable: this.state.profile.discoveryBySubmission && scenario.discoveryBySubmission });
      return { result: scenario.delayObservations ? { status: "pending", effect: "possible", submissionId, observeAfterMs: 0 } as const : result, loseResponse: scenario.behavior === "lost_after_effect" };
    });
  }
  async observe(scope: NativeScope, submissionId: string): Promise<z.infer<typeof DriverResult> | null> {
    return this.mutate(() => {
      const entry = this.state.ledger.find(x => x.submissionId === submissionId && x.discoverable);
      if (!entry) return null;
      const ref = entry.result.status === "completed" ? entry.result.value.kind === "sandbox" ? entry.result.value.observation.ref : entry.result.value.kind === "execution" ? entry.result.value.observation.sandbox : entry.result.value.observation.sandbox : undefined;
      if (!ref || !sameScope(ref.scope, scope)) return null;
      if (entry.remaining-- > 0) return { status: "pending", effect: "possible", submissionId, observeAfterMs: 0 } as const;
      return entry.result;
    });
  }
  inspect(ref: NativeRef) { const r = this.find(ref); return r ? { ref: r.ref, state: r.state, observedAt: iso(this.state.tick), sourceSequence: r.sequence } : null; }
  inventory(scope: NativeScope, cursor: string | undefined, limit: number) {
    const start = cursor ? Number(cursor) : 0;
    const resources = this.state.resources.filter(x => sameScope(x.ref.scope, scope));
    const items = resources.slice(start, start + limit).map(x => ({ ref: x.ref, state: x.state, observedAt: iso(this.state.tick), sourceSequence: x.sequence }));
    return { items, nextCursor: start + limit < resources.length ? String(start + limit) : undefined };
  }
  readFile(ref: NativeRef, path: string): string | null { return this.find(ref)?.files[path] ?? null; }
  async writeFile(ref: NativeRef, path: string, bytesBase64: string, overwrite: boolean): Promise<z.infer<typeof DriverResult>> {
    return this.mutate(() => {
      const resource = this.find(ref);
      if (!resource || resource.state !== "running") return { status: "rejected", effect: "none", error: { code: "not_found", message: "Fake sandbox not found", effect: "none", retry: "never" } } as const;
      if (!overwrite && path in resource.files) return this.rejection("conflict");
      if (bytesLength(bytesBase64) > MAX_FILE_BYTES) return this.rejection("capacity");
      resource.files[path] = bytesBase64;
      return { status: "completed", effect: "applied", value: { kind: "file_write", observation: { sandbox: ref, path, bytesWritten: bytesLength(bytesBase64), complete: true } } } as const;
    });
  }
}
