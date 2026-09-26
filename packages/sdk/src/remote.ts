import { AcceptedExecution, AcceptedOperation, CreateSandboxRequest, ErrorResponse, Execution, FileReceipt, Id, Operation, Sandbox, type ExecRequest } from "@sandbar/contracts";
import type { z } from "zod";
import { Image, SandbarError, OutcomeUnknownError, checkExec, execOutput, newInvocationKey, validateReference, waitDelay, type CreateInput, type ExecInput, type ExecOutput, type OperationHandle, type RecoveryReference, type SandboxHandle, type SandbarClient } from "./resource";

export { Image, SandbarError, OutcomeUnknownError, NonzeroExitError, outputText } from "./resource";
export type { CreateInput, ExecInput, ExecOutput, OperationHandle, RecoveryReference, SandboxHandle } from "./resource";

export type RemoteOptions = { url: string; token: string; projectId: string; fetch?: typeof fetch };
type Kind = RecoveryReference["kind"];

function base64Bytes(value?: string, maxBytes = 1_048_576): Uint8Array {
  if (!value) return new Uint8Array();
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new SandbarError("INVALID_RESPONSE", "Service output exceeds requested bound", "unknown");
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (bytes.length > maxBytes) throw new SandbarError("INVALID_RESPONSE", "Service output exceeds requested bound", "unknown");
  return bytes;
}

class RemoteOperation<T> implements OperationHandle<T> {
  readonly durability = "service" as const;
  constructor(readonly reference: RecoveryReference, private readonly client: RemoteClient, private readonly decode: (op: z.infer<typeof Operation>) => Promise<T>) {}
  async observe(): Promise<T | null> {
    const operation = await this.client.operationFor(this.reference);
    if (operation.status === "unknown") throw new OutcomeUnknownError(this.reference, "Service recorded an unknown provider outcome; use service reconciliation");
    if (operation.status === "failed") throw new SandbarError(operation.error?.code ?? "OPERATION_FAILED", operation.error?.message ?? "Operation failed", operation.effect);
    if (operation.status !== "succeeded") return null;
    return this.decode(operation);
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

class RemoteSandbox implements SandboxHandle {
  constructor(private readonly client: RemoteClient, readonly id: string) {}
  async inspect() {
    const box = await this.client.request(`sandboxes/${encodeURIComponent(this.id)}`, Sandbox);
    if (box.projectId !== this.client.projectId || box.id !== this.id) throw new SandbarError("INVALID_RESPONSE", "Service returned a different sandbox", "unknown");
    return { state: box.observedState, observedAt: box.observedAt };
  }
  async submitExec(input: ExecInput): Promise<OperationHandle<ExecOutput>> {
    const body: ExecRequest = { command: input.command, cwd: input.cwd, env: input.env, deadlineSeconds: input.deadlineSeconds, output: { capture: "bounded", maxBytes: input.maxOutputBytes ?? 1_048_576 } };
    const path = `sandboxes/${encodeURIComponent(this.id)}/executions`;
    const { operation, reference } = await this.client.mutate("exec", this.id, path, "POST", JSON.stringify(body), AcceptedExecution);
    return new RemoteOperation({ ...reference, operationId: operation.id }, this.client, async op => {
      if (op.result?.kind !== "exec" || op.sandboxId !== this.id) throw new OutcomeUnknownError(reference, "Execution operation result mismatched sandbox");
      const value = await this.client.request(`executions/${encodeURIComponent(op.result.executionId)}`, Execution);
      if (value.id !== op.result.executionId || value.projectId !== this.client.projectId || value.sandboxId !== this.id || value.operationId !== op.id || value.status !== "completed") throw new OutcomeUnknownError(reference, "Execution response is incomplete or mismatched");
      if (value.outputAvailability !== "captured" && value.outputAvailability !== "truncated") throw new SandbarError("OUTPUT_UNAVAILABLE", `Output is ${value.outputAvailability}`, "applied");
      if (value.exitCode === undefined) throw new OutcomeUnknownError(reference, "Execution has no exit code");
      const stdout = base64Bytes(value.stdoutBase64, input.maxOutputBytes ?? 1_048_576);
      const stderr = base64Bytes(value.stderrBase64, (input.maxOutputBytes ?? 1_048_576) - stdout.length);
      return checkExec(execOutput(value.exitCode, stdout, stderr, value.outputAvailability === "truncated"));
    });
  }
  async exec(input: ExecInput, options: { signal?: AbortSignal } = {}) { return (await this.submitExec(input)).wait(options); }
  async readFile(path: string): Promise<Uint8Array> {
    const url = `sandboxes/${encodeURIComponent(this.id)}/files?path=${encodeURIComponent(path)}`;
    const response = await this.client.raw(url, { method: "GET" });
    if (!response.ok) await this.client.throwResponse(response);
    if (response.headers.get("content-type")?.split(";")[0] !== "application/octet-stream") throw new SandbarError("INVALID_RESPONSE", "Expected binary file response", "unknown");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 1_048_576) throw new SandbarError("OUTPUT_CAPACITY", "File exceeds SDK read limit", "unknown");
    return bytes;
  }
  async writeFile(path: string, bytes: Uint8Array, options: { overwrite?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    if (!(bytes instanceof Uint8Array)) throw new SandbarError("INVALID_ARGUMENT", "Expected Uint8Array bytes");
    const query = new URLSearchParams({ path, overwrite: String(options.overwrite ?? false) });
    const route = `sandboxes/${encodeURIComponent(this.id)}/files?${query}`;
    const { operation, reference } = await this.client.mutate("file_write", this.id, route, "PUT", bytes, undefined);
    const op = new RemoteOperation({ ...reference, operationId: operation.id }, this.client, async current => {
      if (current.result?.kind !== "file_write" || current.sandboxId !== this.id || current.result.receipt.path !== path || !current.result.receipt.complete || current.result.receipt.bytesWritten !== bytes.length) throw new OutcomeUnknownError(reference, "File write receipt is incomplete or mismatched");
    });
    await op.wait(options);
  }
  async destroy(options: { signal?: AbortSignal } = {}): Promise<void> {
    const { operation, reference } = await this.client.mutate("destroy", this.id, `sandboxes/${encodeURIComponent(this.id)}`, "DELETE", undefined, AcceptedOperation);
    const op = new RemoteOperation({ ...reference, operationId: operation.id }, this.client, async current => {
      if (current.result?.kind !== "destroy" || current.sandboxId !== this.id || !current.result.computeStopped) throw new OutcomeUnknownError(reference, "Compute stop has not been confirmed");
    });
    await op.wait(options);
  }
}

export class RemoteClient implements SandbarClient {
  readonly projectId: string;
  readonly sandboxes = { create: (input: CreateInput, options: { signal?: AbortSignal } = {}) => this.create(input, options), submitCreate: (input: CreateInput) => this.submitCreate(input) };
  private readonly endpoint: URL;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private closed = false;
  constructor(options: RemoteOptions) {
    this.endpoint = new URL(options.url);
    const loopback = this.endpoint.hostname === "127.0.0.1" || this.endpoint.hostname === "[::1]";
    if ((this.endpoint.protocol !== "https:" && !(this.endpoint.protocol === "http:" && loopback)) || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) throw new SandbarError("INVALID_ARGUMENT", "Service URL must use HTTPS or loopback HTTP");
    this.projectId = Id.parse(options.projectId);
    if (!options.token) throw new SandbarError("INVALID_ARGUMENT", "Service token is required");
    this.token = options.token;
    this.fetcher = options.fetch ?? fetch;
  }
  private ensureOpen() { if (this.closed) throw new SandbarError("CLIENT_CLOSED", "Client is closed"); }
  private url(path: string) { return new URL(`v1/projects/${encodeURIComponent(this.projectId)}/${path}`, this.endpoint.href.endsWith("/") ? this.endpoint : `${this.endpoint.href}/`); }
  async raw(path: string, init: RequestInit): Promise<Response> {
    this.ensureOpen();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    return this.fetcher(this.url(path), { ...init, headers, redirect: "error" });
  }
  async throwResponse(response: Response): Promise<never> {
    const raw: unknown = await response.json().catch(() => undefined);
    const parsed = ErrorResponse.safeParse(raw);
    if (parsed.success) throw new SandbarError(parsed.data.error.code, parsed.data.error.message, parsed.data.error.effect);
    throw new SandbarError("HTTP_ERROR", `Service request failed (${response.status})`, "unknown");
  }
  async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const response = await this.raw(path, init);
    if (!response.ok) await this.throwResponse(response);
    const raw: unknown = await response.json();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new SandbarError("INVALID_RESPONSE", "Service returned invalid response", "unknown");
    return parsed.data;
  }
  private reference(kind: Kind, key: string, resourceId?: string): RecoveryReference { return { version: 1, mode: "remote", kind, invocationKey: key, resourceId, service: { url: this.endpoint.href, projectId: this.projectId } }; }
  async operationFor(reference: RecoveryReference): Promise<z.infer<typeof Operation>> {
    validateReference(reference);
    if (reference.mode !== "remote") throw new SandbarError("INVALID_ARGUMENT", "Expected remote recovery reference");
    if (reference.service?.url !== this.endpoint.href || reference.service.projectId !== this.projectId) throw new SandbarError("FORBIDDEN", "Recovery service scope does not match configured client");
    const op = reference.operationId
      ? await this.request(`operations/${encodeURIComponent(reference.operationId)}`, Operation)
      : await this.request(`invocations/${encodeURIComponent(reference.invocationKey)}?${new URLSearchParams({ kind: reference.kind, ...(reference.resourceId ? { sandboxId: reference.resourceId } : {}) })}`, Operation);
    if (op.projectId !== this.projectId || op.kind !== reference.kind || (reference.resourceId && op.sandboxId !== reference.resourceId) || (reference.operationId && op.id !== reference.operationId)) throw new SandbarError("INVALID_RESPONSE", "Service operation identity mismatch", "unknown");
    return op;
  }
  async mutate<T extends { operation: z.infer<typeof Operation> }>(kind: Kind, resourceId: string | undefined, path: string, method: string, body: string | Uint8Array | undefined, schema?: z.ZodType<T>): Promise<{ operation: z.infer<typeof Operation>; reference: RecoveryReference }> {
    const key = newInvocationKey();
    const reference = this.reference(kind, key, resourceId);
    let operation: z.infer<typeof Operation> | undefined;
    try {
      const headers = new Headers({ "Idempotency-Key": key });
      if (typeof body === "string") headers.set("Content-Type", "application/json");
      const response = await this.raw(path, { method, headers, body: body as BodyInit | undefined });
      if (response.ok) {
        const raw: unknown = await response.json();
        if (schema) {
          const parsed = schema.safeParse(raw);
          if (parsed.success) operation = parsed.data.operation;
        } else {
          const accepted = AcceptedOperation.safeParse(raw);
          if (accepted.success) operation = accepted.data.operation;
          else if (FileReceipt.safeParse(raw).success) operation = await this.operationFor(reference);
        }
      } else if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 409 && response.status !== 429) {
        await this.throwResponse(response);
      }
    } catch (error) {
      if (error instanceof SandbarError && error.effect === "none") throw error;
    }
    if (!operation) {
      try { operation = await this.operationFor(reference); }
      catch { throw new OutcomeUnknownError(reference, "Service admission could not be verified; inspect the invocation without resubmitting"); }
    }
    if (operation.projectId !== this.projectId || operation.kind !== kind || (resourceId && operation.sandboxId !== resourceId)) throw new OutcomeUnknownError(reference, "Service admitted a mismatched operation");
    return { operation, reference };
  }
  async submitCreate(input: CreateInput): Promise<OperationHandle<SandboxHandle>> {
    const body = CreateSandboxRequest.parse({ environment: input.environment.kind === "prepared" ? { kind: "prepared", imageId: input.environment.value } : { kind: "oci", reference: input.environment.value }, region: input.region, network: { policy: input.networkPolicy ?? "blocked" }, labels: input.labels });
    const { operation, reference } = await this.mutate("create", undefined, "sandboxes", "POST", JSON.stringify(body), AcceptedOperation);
    return new RemoteOperation({ ...reference, operationId: operation.id }, this, async current => {
      if (current.result?.kind !== "create") throw new OutcomeUnknownError(reference, "Create operation lacks sandbox identity");
      const box = new RemoteSandbox(this, current.result.sandboxId);
      await box.inspect();
      return box;
    });
  }
  async create(input: CreateInput, options: { signal?: AbortSignal } = {}) { return (await this.submitCreate(input)).wait(options); }
  async recover(reference: RecoveryReference): Promise<OperationHandle<unknown>> {
    this.ensureOpen();
    validateReference(reference);
    if (reference.mode !== "remote") throw new SandbarError("INVALID_ARGUMENT", "Expected remote reference");
    await this.operationFor(reference);
    return new RemoteOperation(reference, this, async op => {
      if (op.result?.kind === "create") return new RemoteSandbox(this, op.result.sandboxId);
      if (op.result?.kind === "exec") {
        const value = await this.request(`executions/${encodeURIComponent(op.result.executionId)}`, Execution);
        if (value.id !== op.result.executionId || value.projectId !== this.projectId || value.operationId !== op.id || value.sandboxId !== op.sandboxId || value.status !== "completed") throw new OutcomeUnknownError(reference, "Recovered execution identity or completion is unverified");
        if (value.outputAvailability !== "captured" && value.outputAvailability !== "truncated") throw new SandbarError("OUTPUT_UNAVAILABLE", `Output is ${value.outputAvailability}`, "applied");
        if (value.exitCode === undefined) throw new OutcomeUnknownError(reference, "Execution has no exit code");
        const stdout = base64Bytes(value.stdoutBase64);
        const stderr = base64Bytes(value.stderrBase64, 1_048_576 - stdout.length);
        return checkExec(execOutput(value.exitCode, stdout, stderr, value.outputAvailability === "truncated"));
      }
      return op.result;
    });
  }
  async close() { this.closed = true; }
}

export const Sandbar = { connect(options: RemoteOptions): RemoteClient { return new RemoteClient(options); } };
