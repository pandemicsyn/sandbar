import { NativeScope, type NativeRef, type ProviderDriver, type DriverResult, type InvocationIdentity } from "@sandbar/provider-spi";
import { normalizeCreate, normalizeExec, correlateDriverResult, sameNativeScope, sameNativeRef, captureBoundedOutput } from "@sandbar/core";
import { Image, SandbarError, OutcomeUnknownError, checkExec, execOutput, newInvocationKey, sameRef, validateReference, waitDelay, type CreateInput, type ExecInput, type ExecOutput, type OperationHandle, type RecoveryReference, type SandboxHandle, type SandbarClient } from "./resource";

export { Image, SandbarError, OutcomeUnknownError, NonzeroExitError, outputText } from "./resource";
export type { CreateInput, ExecInput, ExecOutput, OperationHandle, RecoveryReference, SandboxHandle } from "./resource";

export type DirectProvider = { driver: ProviderDriver; scope: NativeScope };
export type DirectOptions = { provider: DirectProvider };
type MutationKind = RecoveryReference["kind"];

function identity(): InvocationIdentity {
  const id = () => `sdk_${crypto.randomUUID().replaceAll("-", "")}`;
  return { projectId: "direct", operationId: id(), invocationKey: newInvocationKey(), submissionId: id() };
}

class DirectOperation<T> implements OperationHandle<T> {
  readonly durability = "process" as const;
  private first?: DriverResult;
  constructor(readonly reference: RecoveryReference, private readonly driver: ProviderDriver, private readonly decode: (result: DriverResult) => T, first?: DriverResult) { this.first = first; }
  async observe(): Promise<T | null> {
    const raw = this.first ?? await this.driver.observe({ scope: this.reference.scope!, submissionId: this.reference.submissionId! });
    this.first = undefined;
    if (!raw) throw new OutcomeUnknownError(this.reference, "Provider has no observation for this submission; resubmission is unsafe");
    let result: DriverResult;
    try {
      result = correlateDriverResult(raw, { submissionId: this.reference.submissionId!, kind: this.reference.kind, scope: this.reference.scope!, sandbox: this.reference.sandbox, file: this.reference.file });
    } catch { throw new OutcomeUnknownError(this.reference, "Provider result failed identity or scope validation; observe without replay"); }
    if (result.status === "rejected") throw new SandbarError(result.error.code.toUpperCase(), result.error.message, "none");
    if (result.status === "unknown") throw new OutcomeUnknownError(this.reference);
    if (result.status !== "completed") return null;
    return this.decode(result);
  }
  async wait(options: { signal?: AbortSignal; pollMs?: number } = {}): Promise<T> {
    const pollMs = options.pollMs ?? 500;
    if (!Number.isSafeInteger(pollMs) || pollMs < 50 || pollMs > 60_000) throw new RangeError("Invalid pollMs");
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      const result = await this.observe();
      if (result !== null) return result;
      await waitDelay(pollMs, options.signal);
    }
  }
}

class DirectSandbox implements SandboxHandle {
  readonly id: string;
  constructor(private readonly client: DirectClient, readonly ref: NativeRef) { this.id = ref.nativeId; }
  async inspect() {
    this.client.ensureOpen();
    const observation = await this.client.driver.inspect(this.ref);
    if (!observation) throw new SandbarError("NOT_FOUND", "Sandbox not found");
    if (!sameNativeRef(observation.ref, this.ref)) throw new SandbarError("OUTCOME_UNKNOWN", "Provider returned a different sandbox", "unknown");
    return { state: observation.state, observedAt: observation.observedAt };
  }
  async submitExec(input: ExecInput): Promise<OperationHandle<ExecOutput>> {
    this.client.ensureOpen();
    const request = normalizeExec({ command: input.command, cwd: input.cwd, env: input.env, deadlineSeconds: input.deadlineSeconds, output: { capture: "bounded", maxBytes: input.maxOutputBytes ?? 1_048_576 } });
    const invocation = identity();
    const reference = { ...this.client.reference("exec", invocation, this.ref), maxOutputBytes: request.maxOutputBytes };
    let first: DriverResult | undefined;
    try { first = await this.client.driver.exec({ sandbox: this.ref, identity: invocation, ...request }); }
    catch { /* A thrown response after submission cannot prove absence of effect. */ }
    return new DirectOperation(reference, this.client.driver, result => {
      if (result.status !== "completed" || result.value.kind !== "execution") throw new OutcomeUnknownError(reference);
      const observation = result.value.observation;
      if (!observation.completed || observation.exitCode === undefined) throw new OutcomeUnknownError(reference, "Execution has no completed outcome");
      const bounded = captureBoundedOutput(observation.stdoutBase64, observation.stderrBase64, request.maxOutputBytes);
      return checkExec(execOutput(observation.exitCode, decodeBase64(bounded.payload.stdoutBase64), decodeBase64(bounded.payload.stderrBase64), (observation.truncated ?? false) || bounded.truncated));
    }, first);
  }
  async exec(input: ExecInput, options: { signal?: AbortSignal } = {}) { return (await this.submitExec(input)).wait(options); }
  async readFile(path: string): Promise<Uint8Array> {
    this.client.ensureOpen();
    if (!path || !path.startsWith("/")) throw new SandbarError("INVALID_ARGUMENT", "Expected an absolute path");
    const bytes = await this.client.driver.readFile({ sandbox: this.ref, path });
    if (!(bytes instanceof Uint8Array)) throw new SandbarError("INVALID_RESPONSE", "Provider returned invalid file bytes", "unknown");
    if (bytes.length > 1_048_576) throw new SandbarError("OUTPUT_CAPACITY", "File exceeds SDK read limit", "unknown");
    return bytes;
  }
  async writeFile(path: string, bytes: Uint8Array, options: { overwrite?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    this.client.ensureOpen();
    if (!path?.startsWith("/") || !(bytes instanceof Uint8Array)) throw new SandbarError("INVALID_ARGUMENT", "Expected an absolute path and Uint8Array bytes");
    const invocation = identity();
    const reference = { ...this.client.reference("file_write", invocation, this.ref), file: { path, bytes: bytes.length } };
    let first: DriverResult | undefined;
    try { first = await this.client.driver.writeFile({ sandbox: this.ref, identity: invocation, path, bytes, overwrite: options.overwrite ?? false }); } catch { /* uncertain */ }
    const op = new DirectOperation(reference, this.client.driver, result => {
      if (result.status !== "completed" || result.value.kind !== "file_write" || !sameRef(result.value.observation.sandbox, this.ref) || result.value.observation.path !== path || !result.value.observation.complete || result.value.observation.bytesWritten !== bytes.length) throw new OutcomeUnknownError(reference, "File write receipt is incomplete or mismatched");
    }, first);
    await op.wait(options);
  }
  async destroy(options: { signal?: AbortSignal } = {}): Promise<void> {
    this.client.ensureOpen();
    const invocation = identity();
    const reference = this.client.reference("destroy", invocation, this.ref);
    let first: DriverResult | undefined;
    try { first = await this.client.driver.destroy({ sandbox: this.ref, identity: invocation }); } catch { /* uncertain */ }
    const op = new DirectOperation(reference, this.client.driver, result => {
      if (result.status !== "completed" || result.value.kind !== "destroy" || !sameRef(result.value.observation.sandbox, this.ref) || !result.value.observation.computeStopped) throw new OutcomeUnknownError(reference, "Compute stop has not been confirmed");
    }, first);
    await op.wait(options);
  }
}

function decodeBase64(value?: string): Uint8Array {
  if (!value) return new Uint8Array();
  const binary = atob(value);
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

export class DirectClient implements SandbarClient {
  private closed = false;
  readonly driver: ProviderDriver;
  readonly scope: NativeScope;
  readonly sandboxes = { create: (input: CreateInput, options: { signal?: AbortSignal } = {}) => this.create(input, options), submitCreate: (input: CreateInput) => this.submitCreate(input) };
  constructor(options: DirectOptions) {
    this.driver = options.provider.driver;
    this.scope = NativeScope.parse(options.provider.scope);
    if (this.driver.name !== this.scope.provider) throw new SandbarError("INVALID_ARGUMENT", "Provider name and scope mismatch");
  }
  ensureOpen() { if (this.closed) throw new SandbarError("CLIENT_CLOSED", "Client is closed"); }
  reference(kind: MutationKind, invocation: InvocationIdentity, sandbox?: NativeRef): RecoveryReference {
    return { version: 1, mode: "direct", kind, invocationKey: invocation.invocationKey, submissionId: invocation.submissionId, operationId: invocation.operationId, scope: this.scope, ...(sandbox ? { sandbox } : {}) };
  }
  private async verified() {
    const caps = await this.driver.capabilities(this.scope);
    if (caps.provider !== this.scope.provider) throw new SandbarError("INVALID_RESPONSE", "Provider capability identity mismatch");
    return caps;
  }
  async submitCreate(input: CreateInput): Promise<OperationHandle<SandboxHandle>> {
    this.ensureOpen();
    await this.verified();
    const request = normalizeCreate({ environment: input.environment.kind === "prepared" ? { kind: "prepared", imageId: input.environment.value } : { kind: "oci", reference: input.environment.value }, region: input.region, network: { policy: input.networkPolicy ?? "blocked" }, labels: input.labels });
    const preparation = await this.driver.prepare({ scope: this.scope, image: request.image, networkPolicy: request.networkPolicy, region: request.region });
    if (!preparation.supported || !preparation.effectiveImage) throw new SandbarError("UNSUPPORTED", preparation.reason ?? "Provider cannot prepare image");
    const invocation = identity();
    const reference = this.reference("create", invocation);
    let first: DriverResult | undefined;
    try { first = await this.driver.create({ scope: this.scope, identity: invocation, image: preparation.effectiveImage, networkPolicy: request.networkPolicy, labels: request.labels }); }
    catch { /* uncertain */ }
    return new DirectOperation(reference, this.driver, result => {
      if (result.status !== "completed" || result.value.kind !== "sandbox") throw new OutcomeUnknownError(reference);
      return new DirectSandbox(this, result.value.observation.ref);
    }, first);
  }
  async create(input: CreateInput, options: { signal?: AbortSignal } = {}) { return (await this.submitCreate(input)).wait(options); }
  async recover(reference: RecoveryReference): Promise<OperationHandle<unknown>> {
    this.ensureOpen();
    validateReference(reference);
    if (reference.mode !== "direct" || !sameNativeScope(reference.scope!, this.scope)) throw new SandbarError("FORBIDDEN", "Recovery scope does not match configured provider");
    await this.verified();
    return new DirectOperation(reference, this.driver, result => {
      if (result.status !== "completed") throw new OutcomeUnknownError(reference);
      if (result.value.kind === "sandbox") return new DirectSandbox(this, result.value.observation.ref);
      if (result.value.kind === "execution") {
        const value = result.value.observation;
        if (!value.completed || value.exitCode === undefined) throw new OutcomeUnknownError(reference);
        const bounded = captureBoundedOutput(value.stdoutBase64, value.stderrBase64, reference.maxOutputBytes ?? 1_048_576);
        return checkExec(execOutput(value.exitCode, decodeBase64(bounded.payload.stdoutBase64), decodeBase64(bounded.payload.stderrBase64), (value.truncated ?? false) || bounded.truncated));
      }
      return result.value.observation;
    });
  }
  async close() { this.closed = true; }
}

export const Sandbar = { direct(options: DirectOptions): DirectClient { return new DirectClient(options); } };
