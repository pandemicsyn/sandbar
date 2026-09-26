import type { ProviderDriver, NativeRef, NativeScope, DriverResult, InvocationIdentity } from "@sandbar/provider-spi";
import { validateDriverResult } from "@sandbar/provider-spi";
import type { CreateSandboxRequest, ExecRequest } from "@sandbar/contracts";
import { ControlStore, type Claimed, type OperationRow, type SandboxRow, type ConnectionRow } from "@sandbar/store";
import { SecretBox } from "./crypto";

export interface RunnerOptions { store: ControlStore; driver: ProviderDriver; secrets: SecretBox; pollMs?: number; owner?: string }
export class DurableRunner {
  readonly owner: string;
  private timer?: ReturnType<typeof setInterval>;
  private active = false;
  constructor(private readonly options: RunnerOptions) { this.owner = options.owner ?? `runner_${crypto.randomUUID()}`; }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 500);
    void this.tick();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async tick(): Promise<boolean> {
    if (this.active) return false;
    this.active = true;
    try {
      const claim = await this.options.store.claimDue(this.owner);
      if (!claim) return false;
      await this.process(claim);
      return true;
    } finally { this.active = false; }
  }

  private scope(connection: ConnectionRow): NativeScope {
    if (connection.provider !== this.options.driver.name || connection.status !== "verified" || !connection.scope) throw new Error("Provider connection is unavailable");
    return { provider: connection.provider, connectionId: connection.id, accountId: connection.scope, region: "local" };
  }
  private async process(claim: Claimed): Promise<void> {
    const { store, driver } = this.options;
    const op = claim.operation;
    try {
      const connection = await store.getConnection(op.project_id, op.connection_id);
      if (!connection) throw new Error("Provider connection vanished");
      const scope = this.scope(connection);
      if (claim.observeOnly) {
        // This path is read only even when the claim follows a process crash.
        const result = await driver.observe({ scope, submissionId: op.provider_token });
        if (result) await this.handleResult(claim, validateDriverResult(result), scope);
        else await store.reschedule(claim, "outcome_unknown", 5_000, "NO_OBSERVATION");
        return;
      }
      const key = await store.getInvocationKey(op.id);
      if (!key) throw new Error("Durable invocation identity is missing");
      const identity: InvocationIdentity = { projectId: op.project_id, operationId: op.id, invocationKey: key, submissionId: op.provider_token };
      const box = await store.getSandbox(op.project_id, op.sandbox_id);
      if (!box) throw new Error("Sandbox record vanished");

      if (op.kind === "create") {
        const request = JSON.parse(op.request_json) as CreateSandboxRequest;
        const image = request.environment.kind === "prepared"
          ? { kind: "prepared" as const, value: request.environment.imageId }
          : { kind: "oci" as const, value: request.environment.reference };
        const networkPolicy = request.network?.policy ?? "blocked";
        const preparation = await driver.prepare({ scope, image, networkPolicy, region: request.region });
        if (!preparation.supported || !preparation.effectiveImage) {
          await store.failWithoutEffect(claim, { code: "UNSUPPORTED", message: preparation.reason ?? "Provider cannot prepare this input", effect: "none", retry: "never" });
          return;
        }
        if (!await store.beginSubmission(claim)) return;
        const result = await driver.create({ scope, identity, image: preparation.effectiveImage, networkPolicy, labels: request.labels });
        await this.handleResult(claim, validateDriverResult(result), scope);
      } else if (op.kind === "exec") {
        if (!box.native_id) { await store.reschedule(claim, "waiting_for_sandbox", 2_000); return; }
        const request = JSON.parse(op.request_json) as ExecRequest;
        const ref = this.ref(scope, box);
        if (!await store.beginSubmission(claim)) return;
        const result = await driver.exec({ sandbox: ref, identity, command: request.command, cwd: request.cwd, env: request.env, deadlineSeconds: request.deadlineSeconds ?? 300, maxOutputBytes: request.output?.capture === "none" ? 0 : request.output?.maxBytes ?? 1_048_576 });
        await this.handleResult(claim, validateDriverResult(result), scope);
      } else {
        if (!box.native_id) { await store.reschedule(claim, "waiting_for_native_identity", 5_000); return; }
        if (!await store.beginSubmission(claim)) return;
        const result = await driver.destroy({ sandbox: this.ref(scope, box), identity });
        await this.handleResult(claim, validateDriverResult(result), scope);
      }
    } catch {
      // Errors after possible submission are ambiguous. Never infer no effect from a thrown transport/decoder error.
      await store.reschedule(claim, "outcome_unknown", 5_000, "DRIVER_ERROR");
    }
  }
  private ref(scope: NativeScope, box: SandboxRow): NativeRef {
    if (!box.native_id) throw new Error("Native identity unavailable");
    return { scope, nativeId: box.native_id, kind: "sandbox" };
  }
  private async handleResult(claim: Claimed, result: DriverResult, scope: NativeScope): Promise<void> {
    const { store, secrets } = this.options;
    if (result.status === "pending") { await store.reschedule(claim, "awaiting_observation", Math.max(500, result.observeAfterMs)); return; }
    if (result.status === "unknown") { await store.reschedule(claim, "outcome_unknown", 5_000, "PROVIDER_UNKNOWN"); return; }
    if (result.status === "rejected") {
      const error = { code: result.error.code === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE", message: result.error.message, effect: "none", retry: "never" };
      await store.failWithoutEffect(claim, error, true);
      return;
    }
    const value = result.value;
    if ((claim.operation.kind === "create" && value.kind !== "sandbox") || (claim.operation.kind === "exec" && value.kind !== "execution") || (claim.operation.kind === "destroy" && value.kind !== "destroy")) throw new Error("Provider result kind mismatch");
    if (value.kind === "sandbox" && (value.observation.ref.scope.connectionId !== scope.connectionId || value.observation.ref.scope.accountId !== scope.accountId)) throw new Error("Provider result scope mismatch");
    if (value.kind === "execution") {
      if (value.observation.sandbox.scope.connectionId !== scope.connectionId) throw new Error("Execution scope mismatch");
      const output = this.captureOutput(value.observation.stdoutBase64, value.observation.stderrBase64, claim.operation);
      const encryptedOutput = output.bytes ? await secrets.seal("execution-output", claim.operation.execution_id!, JSON.stringify(output.payload)) : undefined;
      await store.complete(claim, { effect: result.effect, value, observedAt: Date.parse(value.observation.observedAt), encryptedOutput, outputBytes: output.bytes, outputTruncated: output.truncated || !!value.observation.truncated });
    } else {
      await store.complete(claim, { effect: result.effect, value, observedAt: value.kind === "sandbox" ? Date.parse(value.observation.observedAt) : undefined });
    }
  }
  private captureOutput(stdoutBase64: string | undefined, stderrBase64: string | undefined, op: OperationRow): { payload: { stdoutBase64: string; stderrBase64: string }; bytes: number; truncated: boolean } {
    const request = JSON.parse(op.request_json) as ExecRequest;
    const max = request.output?.capture === "none" ? 0 : request.output?.maxBytes ?? 1_048_576;
    const stdout = stdoutBase64 ? Buffer.from(stdoutBase64, "base64") : Buffer.alloc(0);
    const stderr = stderrBase64 ? Buffer.from(stderrBase64, "base64") : Buffer.alloc(0);
    const out = stdout.subarray(0, max);
    const err = stderr.subarray(0, Math.max(0, max - out.length));
    return { payload: { stdoutBase64: out.toString("base64"), stderrBase64: err.toString("base64") }, bytes: out.length + err.length, truncated: stdout.length + stderr.length > max };
  }
}
