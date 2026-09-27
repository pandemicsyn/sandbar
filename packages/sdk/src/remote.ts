import {
  AcceptedExecution,
  AcceptedOperation,
  CreateSandboxRequest,
  ErrorResponse,
  ExecRequest,
  Execution,
  FileReceipt,
  Id,
  Operation,
  Sandbox,
} from "@sandbar/contracts";
import type { z } from "zod";
import {
  SandbarError,
  OutcomeUnknownError,
  NoExitCodeError,
  NonzeroExitError,
  awaitSubmission,
  checkExec,
  execOutput,
  newInvocationKey,
  raceAbort,
  rethrowCloseWithReference,
  sealedReference,
  throwIfAborted,
  validateCreate,
  validateExec,
  validateFilePath,
  validateReference,
  waitDelay,
  type CreateInput,
  type ExecInput,
  type ExecOutput,
  type OperationHandle,
  type RecoveryReference,
  type SandboxHandle,
  type SandbarClient,
} from "./resource";

export {
  Image,
  SandbarError,
  OutcomeUnknownError,
  WaitAbortedError,
  NonzeroExitError,
  NoExitCodeError,
  outputText,
} from "./resource";

export type {
  CreateInput,
  ExecInput,
  ExecOutput,
  OperationHandle,
  RecoveryReference,
  SandboxHandle,
} from "./resource";

export type RemoteOptions = { url: string; token: string; projectId: string; fetch?: typeof fetch };

type Kind = RecoveryReference["kind"];

const mutateOperation = Symbol("Sandbar remote mutation");

function base64Bytes(value?: string, maxBytes = 1_048_576): Uint8Array {
  if (!value) return new Uint8Array();

  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4)
    throw new SandbarError("INVALID_RESPONSE", "Service output exceeds requested bound", "unknown");
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

  if (bytes.length > maxBytes)
    throw new SandbarError("INVALID_RESPONSE", "Service output exceeds requested bound", "unknown");

  return bytes;
}

class RemoteOperation<T> implements OperationHandle<T> {
  readonly durability = "service" as const;
  readonly reference: RecoveryReference;
  constructor(
    reference: RecoveryReference,
    private readonly client: RemoteClient,
    private readonly decode: (op: z.infer<typeof Operation>) => Promise<T>,
  ) {
    this.reference = sealedReference(reference);
  }
  async observe(): Promise<T | null> {
    let operation: z.infer<typeof Operation>;

    try {
      operation = await this.client.operationFor(this.reference);
    } catch {
      throw new OutcomeUnknownError(
        this.reference,
        "Service operation observation failed after admission; recover with this reference",
      );
    }

    if (operation.status === "unknown")
      throw new OutcomeUnknownError(
        this.reference,
        "Service recorded an unknown provider outcome; use service reconciliation",
      );

    if (operation.status === "failed")
      throw new SandbarError(
        operation.error?.code ?? "OPERATION_FAILED",
        operation.error?.message ?? "Operation failed",
        operation.effect,
      );

    if (operation.status !== "succeeded") return null;

    try {
      return await this.decode(operation);
    } catch (error) {
      if (
        error instanceof NonzeroExitError ||
        error instanceof NoExitCodeError ||
        (error instanceof SandbarError &&
          error.code === "OUTPUT_UNAVAILABLE" &&
          error.effect === "applied")
      )
        throw error;
      throw new OutcomeUnknownError(
        this.reference,
        "Service result read failed after admission; recover with this reference",
      );
    }
  }
  async wait(options: { signal?: AbortSignal; pollMs?: number } = {}): Promise<T> {
    const pollMs = options.pollMs ?? 500;

    if (!Number.isSafeInteger(pollMs) || pollMs < 50 || pollMs > 60_000)
      throw new RangeError("Invalid pollMs");

    const signal = options.signal
      ? AbortSignal.any([options.signal, this.client.closedSignal])
      : this.client.closedSignal;

    for (;;) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");

      if (options.signal?.aborted)
        throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      const result = await raceAbort(this.observe(), signal);

      if (result !== null) return result;
      await waitDelay(pollMs, signal);
    }
  }
}

class RemoteSandbox implements SandboxHandle {
  constructor(
    private readonly client: RemoteClient,
    readonly id: string,
  ) {}
  async inspect() {
    const box = await this.client.request(`sandboxes/${encodeURIComponent(this.id)}`, Sandbox);

    if (box.projectId !== this.client.projectId || box.id !== this.id)
      throw new SandbarError("INVALID_RESPONSE", "Service returned a different sandbox", "unknown");

    return { state: box.observedState, observedAt: box.observedAt };
  }
  async submitExec(
    input: ExecInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<OperationHandle<ExecOutput>> {
    throwIfAborted(options.signal);

    input = validateExec(input);

    const body = ExecRequest.parse({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      deadlineSeconds: input.deadlineSeconds,
      output: { capture: "bounded", maxBytes: input.maxOutputBytes ?? 1_048_576 },
    });

    const maxOutputBytes = body.output?.maxBytes ?? 1_048_576;

    const path = `sandboxes/${encodeURIComponent(this.id)}/executions`;
    let dispatched: RecoveryReference | undefined;

    const { operation, reference } = await awaitSubmission(
      this.client[mutateOperation](
        "exec",
        this.id,
        path,
        "POST",
        JSON.stringify(body),
        AcceptedExecution,
        undefined,
        (value) => {
          dispatched = value;
        },
      ),
      this.client.closedSignal,
      options.signal,
      () => dispatched,
    );

    return new RemoteOperation(
      { ...reference, operationId: operation.id },
      this.client,
      async (op) => {
        if (op.result?.kind !== "exec" || op.sandboxId !== this.id)
          throw new OutcomeUnknownError(reference, "Execution operation result mismatched sandbox");

        const value = await this.client.request(
          `executions/${encodeURIComponent(op.result.executionId)}`,
          Execution,
        );

        if (
          value.id !== op.result.executionId ||
          value.projectId !== this.client.projectId ||
          value.sandboxId !== this.id ||
          value.operationId !== op.id ||
          value.status !== "completed"
        )
          throw new OutcomeUnknownError(
            reference,
            "Execution response is incomplete or mismatched",
          );

        if (value.outputAvailability !== "captured" && value.outputAvailability !== "truncated")
          throw new SandbarError(
            "OUTPUT_UNAVAILABLE",
            `Output is ${value.outputAvailability}`,
            "applied",
          );

        if (value.exitCode === undefined)
          throw new OutcomeUnknownError(reference, "Execution has no exit code");
        const stdout = base64Bytes(value.stdoutBase64, maxOutputBytes);

        const stderr = base64Bytes(value.stderrBase64, maxOutputBytes - stdout.length);

        return checkExec(
          execOutput(value.exitCode, stdout, stderr, value.outputAvailability === "truncated"),
        );
      },
    );
  }
  async exec(input: ExecInput, options: { signal?: AbortSignal } = {}) {
    throwIfAborted(options.signal);
    const operation = await this.submitExec(input, options);

    try {
      return await operation.wait(options);
    } catch (error) {
      return rethrowCloseWithReference(
        error instanceof Error ? error : new Error("Operation failed", { cause: error }),
        operation.reference,
        options.signal,
      );
    }
  }
  async readFile(path: string): Promise<Uint8Array> {
    validateFilePath(path);
    const url = `sandboxes/${encodeURIComponent(this.id)}/files?path=${encodeURIComponent(path)}`;
    const response = await this.client.raw(url, { method: "GET" });

    if (!response.ok) await this.client.throwResponse(response);

    if (response.headers.get("content-type")?.split(";")[0] !== "application/octet-stream") {
      await response.body?.cancel().catch(() => undefined);
      throw new SandbarError("INVALID_RESPONSE", "Expected binary file response", "unknown");
    }

    const declared = response.headers.get("content-length");

    if (
      declared !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(Number(declared)))
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new SandbarError("INVALID_RESPONSE", "Invalid file length", "unknown");
    }

    if (declared !== null && Number(declared) > 1_048_576) {
      await response.body?.cancel().catch(() => undefined);
      throw new SandbarError("OUTPUT_CAPACITY", "File exceeds SDK read limit", "unknown");
    }

    const reader = response.body?.getReader();

    if (!reader) {
      if (declared !== null && Number(declared) !== 0)
        throw new SandbarError("INVALID_RESPONSE", "File response is incomplete", "unknown");

      return new Uint8Array();
    }

    const chunks: Uint8Array[] = [];
    let length = 0;

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      length += value.byteLength;

      if (length > 1_048_576) {
        await reader.cancel().catch(() => undefined);
        throw new SandbarError("OUTPUT_CAPACITY", "File exceeds SDK read limit", "unknown");
      }

      chunks.push(value);
    }

    if (declared !== null && length !== Number(declared))
      throw new SandbarError("INVALID_RESPONSE", "File response is incomplete", "unknown");
    const bytes = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return bytes;
  }
  async writeFile(
    path: string,
    bytes: Uint8Array,
    options: { overwrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    throwIfAborted(options.signal);
    validateFilePath(path);

    if (!(bytes instanceof Uint8Array))
      throw new SandbarError("INVALID_ARGUMENT", "Expected Uint8Array bytes");

    if (bytes.length > 1_048_576)
      throw new SandbarError("OUTPUT_CAPACITY", "File exceeds SDK write limit");

    const payload = Uint8Array.from(bytes);
    const payloadLength = payload.length;
    const query = new URLSearchParams({ path, overwrite: String(options.overwrite ?? false) });
    const route = `sandboxes/${encodeURIComponent(this.id)}/files?${query}`;
    let dispatched: RecoveryReference | undefined;

    const { operation, reference } = await awaitSubmission(
      this.client[mutateOperation](
        "file_write",
        this.id,
        route,
        "PUT",
        payload.buffer,
        undefined,
        { path, bytes: payloadLength },
        (value) => {
          dispatched = value;
        },
      ),
      this.client.closedSignal,
      options.signal,
      () => dispatched,
    );

    const op = new RemoteOperation(
      { ...reference, operationId: operation.id },
      this.client,
      async (current) => {
        if (
          current.result?.kind !== "file_write" ||
          current.sandboxId !== this.id ||
          current.result.receipt.path !== path ||
          !current.result.receipt.complete ||
          current.result.receipt.bytesWritten !== payloadLength
        )
          throw new OutcomeUnknownError(
            reference,
            "File write receipt is incomplete or mismatched",
          );
      },
    );

    try {
      await op.wait(options);
    } catch (error) {
      rethrowCloseWithReference(
        error instanceof Error ? error : new Error("Operation failed", { cause: error }),
        op.reference,
        options.signal,
      );
    }
  }
  async destroy(options: { signal?: AbortSignal } = {}): Promise<void> {
    throwIfAborted(options.signal);
    let dispatched: RecoveryReference | undefined;

    const { operation, reference } = await awaitSubmission(
      this.client[mutateOperation](
        "destroy",
        this.id,
        `sandboxes/${encodeURIComponent(this.id)}`,
        "DELETE",
        undefined,
        AcceptedOperation,
        undefined,
        (value) => {
          dispatched = value;
        },
      ),
      this.client.closedSignal,
      options.signal,
      () => dispatched,
    );

    const op = new RemoteOperation(
      { ...reference, operationId: operation.id },
      this.client,
      async (current) => {
        if (
          current.result?.kind !== "destroy" ||
          current.sandboxId !== this.id ||
          !current.result.computeStopped
        )
          throw new OutcomeUnknownError(reference, "Compute stop has not been confirmed");
      },
    );

    try {
      await op.wait(options);
    } catch (error) {
      rethrowCloseWithReference(
        error instanceof Error ? error : new Error("Operation failed", { cause: error }),
        op.reference,
        options.signal,
      );
    }
  }
}

export class RemoteClient implements SandbarClient {
  readonly projectId: string;
  readonly sandboxes = {
    create: (input: CreateInput, options: { signal?: AbortSignal } = {}) =>
      this.create(input, options),
    submitCreate: (input: CreateInput, options: { signal?: AbortSignal } = {}) =>
      this.submitCreate(input, options),
  };
  private readonly endpoint: URL;
  readonly #token: string;
  private readonly fetcher: typeof fetch;
  private closed = false;
  private readonly closeController = new AbortController();
  get closedSignal(): AbortSignal {
    return this.closeController.signal;
  }
  constructor(options: RemoteOptions) {
    try {
      this.endpoint = new URL(options.url);
    } catch {
      throw new SandbarError("INVALID_ARGUMENT", "Invalid service URL");
    }

    const loopback = this.endpoint.hostname === "127.0.0.1" || this.endpoint.hostname === "[::1]";

    if (
      (this.endpoint.protocol !== "https:" && !(this.endpoint.protocol === "http:" && loopback)) ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash
    )
      throw new SandbarError("INVALID_ARGUMENT", "Service URL must use HTTPS or loopback HTTP");
    this.endpoint.search = "";
    this.endpoint.hash = "";

    if (!this.endpoint.pathname.endsWith("/")) this.endpoint.pathname += "/";
    const projectId = Id.safeParse(options.projectId);

    if (!projectId.success) throw new SandbarError("INVALID_ARGUMENT", "Invalid project ID");
    this.projectId = projectId.data;

    if (!options.token) throw new SandbarError("INVALID_ARGUMENT", "Service token is required");
    this.#token = options.token;
    this.fetcher = options.fetch ?? fetch;
  }
  private ensureOpen() {
    if (this.closed) throw new SandbarError("CLIENT_CLOSED", "Client is closed");
  }
  private url(path: string) {
    const base = new URL(`v1/projects/${encodeURIComponent(this.projectId)}/`, this.endpoint);

    const target = new URL(path, base);

    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname))
      throw new SandbarError(
        "INVALID_ARGUMENT",
        "Service route must remain inside the configured project",
      );

    return target;
  }
  async raw(path: string, init: RequestInit): Promise<Response> {
    this.ensureOpen();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.#token}`);

    const signal = init.signal
      ? AbortSignal.any([init.signal, this.closedSignal])
      : this.closedSignal;

    return this.fetcher(this.url(path), { ...init, headers, signal, redirect: "error" });
  }
  async throwResponse(response: Response): Promise<never> {
    const raw: unknown = await response.json().catch(() => undefined);
    const parsed = ErrorResponse.safeParse(raw);

    if (parsed.success)
      throw new SandbarError(
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.effect,
      );
    throw new SandbarError("HTTP_ERROR", `Service request failed (${response.status})`, "unknown");
  }
  async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const response = await this.raw(path, init);

    if (!response.ok) await this.throwResponse(response);
    let raw: unknown;

    try {
      raw = await response.json();
    } catch (error) {
      this.ensureOpen();
      throwIfAborted(init.signal ?? undefined);

      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new SandbarError("INVALID_RESPONSE", "Service returned invalid response", "unknown");
    }

    const parsed = schema.safeParse(raw);

    if (!parsed.success)
      throw new SandbarError("INVALID_RESPONSE", "Service returned invalid response", "unknown");

    return parsed.data;
  }
  private reference(kind: Kind, key: string, resourceId?: string): RecoveryReference {
    return {
      version: 1,
      mode: "remote",
      kind,
      invocationKey: key,
      resourceId,
      service: { url: this.endpoint.href, projectId: this.projectId },
    };
  }
  async operationFor(reference: RecoveryReference): Promise<z.infer<typeof Operation>> {
    reference = validateReference(reference);

    if (reference.mode !== "remote")
      throw new SandbarError("INVALID_ARGUMENT", "Expected remote recovery reference");

    if (
      reference.service?.url !== this.endpoint.href ||
      reference.service.projectId !== this.projectId
    )
      throw new SandbarError(
        "FORBIDDEN",
        "Recovery service scope does not match configured client",
      );

    const query = new URLSearchParams({ kind: reference.kind });

    if (reference.resourceId) query.set("sandboxId", reference.resourceId);

    const op = await this.request(
      `invocations/${encodeURIComponent(reference.invocationKey)}?${query}`,
      Operation,
    );

    if (
      op.projectId !== this.projectId ||
      op.kind !== reference.kind ||
      (reference.resourceId && op.sandboxId !== reference.resourceId) ||
      (reference.operationId && op.id !== reference.operationId)
    )
      throw new SandbarError("INVALID_RESPONSE", "Service operation identity mismatch", "unknown");

    return op;
  }
  async [mutateOperation]<T extends { operation: z.infer<typeof Operation> }>(
    kind: Kind,
    resourceId: string | undefined,
    path: string,
    method: string,
    body: string | ArrayBuffer | undefined,
    schema?: z.ZodType<T>,
    file?: { path: string; bytes: number },
    onDispatch?: (reference: RecoveryReference) => void,
  ): Promise<{ operation: z.infer<typeof Operation>; reference: RecoveryReference }> {
    this.ensureOpen();
    const key = newInvocationKey();

    const candidate = this.reference(kind, key, resourceId);

    if (file) candidate.file = file;
    const reference = sealedReference(candidate);

    onDispatch?.(reference);
    let operation: z.infer<typeof Operation> | undefined;

    try {
      const headers = new Headers({ "Idempotency-Key": key });

      if (kind === "create" || kind === "exec") headers.set("Content-Type", "application/json");

      const response = await this.raw(path, {
        method,
        headers,
        body,
      });

      if (response.ok) {
        const raw: unknown = await response.json();

        if (schema) {
          const parsed = schema.safeParse(raw);

          if (parsed.success) operation = parsed.data.operation;
        } else {
          const accepted = AcceptedOperation.safeParse(raw);

          if (accepted.success) operation = accepted.data.operation;
          else if (FileReceipt.safeParse(raw).success)
            operation = await this.operationFor(reference);
        }
      } else if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 409 &&
        response.status !== 429
      ) {
        await this.throwResponse(response);
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof SandbarError && error.effect === "none") throw error;
    }

    if (!operation) {
      try {
        operation = await this.operationFor(reference);
      } catch {
        throw new OutcomeUnknownError(
          reference,
          "Service admission could not be verified; inspect the invocation without resubmitting",
        );
      }
    }

    if (
      operation.projectId !== this.projectId ||
      operation.kind !== kind ||
      (resourceId && operation.sandboxId !== resourceId)
    )
      throw new OutcomeUnknownError(reference, "Service admitted a mismatched operation");

    return { operation, reference };
  }
  async submitCreate(
    input: CreateInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<OperationHandle<SandboxHandle>> {
    throwIfAborted(options.signal);
    input = validateCreate(input);

    const body = CreateSandboxRequest.parse({
      environment:
        input.environment.kind === "prepared"
          ? { kind: "prepared", imageId: input.environment.value }
          : { kind: "oci", reference: input.environment.value },
      region: input.region,
      network: { policy: input.networkPolicy ?? "blocked" },
      labels: input.labels,
    });

    let dispatched: RecoveryReference | undefined;

    const { operation, reference } = await awaitSubmission(
      this[mutateOperation](
        "create",
        undefined,
        "sandboxes",
        "POST",
        JSON.stringify(body),
        AcceptedOperation,
        undefined,
        (value) => {
          dispatched = value;
        },
      ),
      this.closedSignal,
      options.signal,
      () => dispatched,
    );

    return new RemoteOperation(
      { ...reference, operationId: operation.id },
      this,
      async (current) => {
        if (current.result?.kind !== "create" || current.sandboxId !== current.result.sandboxId)
          throw new OutcomeUnknownError(
            reference,
            "Create operation lacks matching sandbox identity",
          );
        const box = new RemoteSandbox(this, current.result.sandboxId);
        await box.inspect();

        return box;
      },
    );
  }
  async create(input: CreateInput, options: { signal?: AbortSignal } = {}) {
    throwIfAborted(options.signal);
    const operation = await this.submitCreate(input, options);

    try {
      return await operation.wait(options);
    } catch (error) {
      return rethrowCloseWithReference(
        error instanceof Error ? error : new Error("Operation failed", { cause: error }),
        operation.reference,
        options.signal,
      );
    }
  }
  async recover(reference: RecoveryReference): Promise<OperationHandle<unknown>> {
    this.ensureOpen();
    reference = sealedReference(reference);

    if (reference.mode !== "remote")
      throw new SandbarError("INVALID_ARGUMENT", "Expected remote reference");
    await this.operationFor(reference);

    return new RemoteOperation(reference, this, async (op) => {
      if (reference.kind === "create") {
        if (op.result?.kind !== "create" || op.sandboxId !== op.result.sandboxId)
          throw new OutcomeUnknownError(reference, "Create result is missing or mismatched");
        const box = new RemoteSandbox(this, op.result.sandboxId);
        await box.inspect();

        return box;
      }

      if (reference.kind === "exec") {
        if (op.result?.kind !== "exec")
          throw new OutcomeUnknownError(reference, "Execution result is missing or mismatched");

        const value = await this.request(
          `executions/${encodeURIComponent(op.result.executionId)}`,
          Execution,
        );

        if (
          value.id !== op.result.executionId ||
          value.projectId !== this.projectId ||
          value.operationId !== op.id ||
          value.sandboxId !== op.sandboxId ||
          value.status !== "completed"
        )
          throw new OutcomeUnknownError(
            reference,
            "Recovered execution identity or completion is unverified",
          );

        if (value.outputAvailability !== "captured" && value.outputAvailability !== "truncated")
          throw new SandbarError(
            "OUTPUT_UNAVAILABLE",
            `Output is ${value.outputAvailability}`,
            "applied",
          );

        if (value.exitCode === undefined)
          throw new OutcomeUnknownError(reference, "Execution has no exit code");
        const stdout = base64Bytes(value.stdoutBase64);
        const stderr = base64Bytes(value.stderrBase64, 1_048_576 - stdout.length);

        return checkExec(
          execOutput(value.exitCode, stdout, stderr, value.outputAvailability === "truncated"),
        );
      }

      if (reference.kind === "destroy") {
        if (op.result?.kind !== "destroy" || !op.result.computeStopped)
          throw new OutcomeUnknownError(reference, "Compute stop has not been confirmed");

        return op.result;
      }

      if (
        op.result?.kind !== "file_write" ||
        !op.result.receipt.complete ||
        op.result.receipt.path !== reference.file?.path ||
        op.result.receipt.bytesWritten !== reference.file?.bytes
      )
        throw new OutcomeUnknownError(reference, "File write receipt is incomplete or mismatched");

      return op.result.receipt;
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort(new SandbarError("CLIENT_CLOSED", "Client is closed"));
  }
}

export const Sandbar = {
  connect(options: RemoteOptions): RemoteClient {
    return new RemoteClient(options);
  },
};
