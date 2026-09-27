import { z } from "zod";
import {
  AdapterError,
  connectAdapter,
  observeOperation,
  prepareOperation,
  submitOperation,
  type AdapterConnection,
  type AdapterDefinition,
  type AdapterSession,
  type Json,
  type OperationKind,
  type RuntimeResult,
  type Scope,
} from "@sandbar/adapter";
import {
  Image,
  OutcomeUnknownError,
  WaitAbortedError,
  SandbarError,
  checkExec,
  execOutput,
  newInvocationKey,
  outputText,
  raceAbort,
  validateCreate,
  validateExec,
  validateFilePath,
  waitDelay,
  type CreateInput,
  type ExecInput,
  type ExecOutput,
} from "./resource";

export { Image, outputText } from "./resource";

const ReferenceSchema = z.strictObject({
  version: z.literal(2),
  mode: z.literal("direct"),
  provider: z.string().min(1).max(128),
  kind: z.enum(["create", "destroy", "exec", "file_write"]),
  scope: z.strictObject({
    authority: z.strictObject({ kind: z.string().min(1).max(64), id: z.string().min(1).max(512) }),
    partition: z.record(z.string().min(1).max(64), z.string().max(2048)),
  }),
  operationId: z.string().min(1).max(128),
  submissionId: z.string().min(1).max(128),
  invocationKey: z.string().min(1).max(128),
  sandboxId: z.string().min(1).max(512).optional(),
  file: z.strictObject({ path: z.string().min(1).max(4096), bytes: z.number().int().nonnegative().max(1_048_576) }).optional(),
  maxOutputBytes: z.number().int().nonnegative().max(1_048_576).optional(),
  tokenVersion: z.number().int().positive().optional(),
  token: z.json().optional(),
});
export type AdapterRecoveryReference = z.infer<typeof ReferenceSchema>;

function canonicalScope(scope: Scope): string {
  return JSON.stringify({
    authority: scope.authority,
    partition: Object.fromEntries(Object.entries(scope.partition).sort(([a], [b]) => a.localeCompare(b))),
  });
}
function sealedReference(value: AdapterRecoveryReference): AdapterRecoveryReference {
  const parsed = ReferenceSchema.parse(value);
  if (JSON.stringify(parsed).length > 16_384)
    throw new SandbarError("INVALID_ARGUMENT", "Recovery reference exceeds 16384 bytes");
  const copy = structuredClone(parsed);
  Object.freeze(copy.scope.authority);
  Object.freeze(copy.scope.partition);
  Object.freeze(copy.scope);
  if (copy.file) Object.freeze(copy.file);
  if (copy.token && typeof copy.token === "object") Object.freeze(copy.token);
  return Object.freeze(copy);
}
function identity() {
  const id = () => `sdk_${crypto.randomUUID().replaceAll("-", "")}`;
  return { operationId: id(), submissionId: id(), invocationKey: newInvocationKey() };
}
function asUnknown(ref: AdapterRecoveryReference, reason?: string): OutcomeUnknownError {
  return new OutcomeUnknownError(ref as never, reason);
}
function unsupported(feature: string): never {
  throw new SandbarError("UNSUPPORTED", `${feature} is unsupported`);
}
function abortWaiting(ref: AdapterRecoveryReference, reason: unknown): never {
  throw new WaitAbortedError(ref as never, reason);
}
function assertSignal(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new SandbarError("WAIT_ABORTED", "Waiting stopped before submission", "none");
}

export type AdapterCapabilities = {
  images: readonly ("prepared" | "oci")[];
  network: readonly string[];
  exec: boolean;
  inspect: boolean;
  inventory: boolean;
  readFile: boolean;
  writeFile: boolean;
  maxOutputBytes: number;
  maxFileBytes: number;
};

export class AdapterOperation<T> {
  readonly durability = "process" as const;
  private first: RuntimeResult | undefined;
  private terminal?: { value: T } | { error: Error };
  constructor(
    private readonly client: AdapterDirectClient,
    public reference: AdapterRecoveryReference,
    private readonly decode: (value: RuntimeResult, ref: AdapterRecoveryReference) => T,
    first?: RuntimeResult,
  ) {
    this.first = first;
  }
  async observe(): Promise<T | null> {
    if (this.client.isClosed()) abortWaiting(this.reference, this.client.signal.reason);
    if (this.terminal) {
      if ("error" in this.terminal) throw this.terminal.error;
      return this.terminal.value;
    }
    let result = this.first;
    const wasFirst = result !== undefined;
    this.first = undefined;
    if (result?.kind === "pending") {
      this.reference = sealedReference({
        ...this.reference,
        token: result.token,
        tokenVersion: result.version,
      });
      return null;
    }
    if (!result) {
      const observed = await observeOperation(
        this.client.session,
        this.reference.kind,
        {
          operationId: this.reference.operationId,
          submissionId: this.reference.submissionId,
          sandbox: this.reference.sandboxId ? { id: this.reference.sandboxId } : undefined,
          token: this.reference.token,
          version: this.reference.tokenVersion,
        },
        this.client.signal,
        this.reference.maxOutputBytes,
      ).catch((error) => {
        if (error instanceof AdapterError && (error.code === "CONFLICT" || error.code === "INVALID_ARGUMENT"))
          throw new SandbarError(error.code, error.message);
        return null;
      });
      if (!observed) throw asUnknown(this.reference, "No correlated provider observation is available");
      result = observed;
    }
    if (result.kind === "pending") {
      this.reference = sealedReference({
        ...this.reference,
        token: result.token,
        tokenVersion: result.version,
      });
      return null;
    }
    if (result.kind === "unknown") throw asUnknown(this.reference, result.reason);
    if (result.kind === "rejected") {
      // Only a submission response may certify no effect.
      if (!wasFirst)
        throw asUnknown(this.reference, "Observation cannot certify rejection");
      const error = new SandbarError(result.code, result.message, "none");
      this.terminal = { error };
      throw error;
    }
    try {
      const value = this.decode(result, this.reference);
      this.terminal = { value };
      return value;
    } catch (error) {
      if (error instanceof OutcomeUnknownError) throw error;
      throw asUnknown(this.reference, "Provider completion failed validation");
    }
  }
  async wait(options: { signal?: AbortSignal; pollMs?: number } = {}): Promise<T> {
    const pollMs = options.pollMs ?? 500;
    if (!Number.isSafeInteger(pollMs) || pollMs < 50 || pollMs > 60_000)
      throw new SandbarError("INVALID_ARGUMENT", "Invalid polling interval");
    while (true) {
      if (this.client.isClosed()) abortWaiting(this.reference, this.client.signal.reason);
      if (options.signal?.aborted) abortWaiting(this.reference, options.signal.reason);
      const value = await this.observe();
      if (value !== null) return value;
      await waitDelay(pollMs, options.signal).catch((error) => abortWaiting(this.reference, error));
    }
  }
}

export class AdapterSandbox {
  constructor(private readonly client: AdapterDirectClient, readonly id: string) {}
  supports(feature: "inspect" | "exec" | "readFile" | "writeFile" | "destroy"): boolean {
    if (feature === "inspect") return !!this.client.session.inspect;
    if (feature === "exec") return !!this.client.session.exec && !!this.client.session.supports.exec;
    if (feature === "readFile") return !!this.client.session.files?.read;
    if (feature === "writeFile") return !!this.client.session.files?.write;
    return true;
  }
  async inspect() {
    this.client.ensureOpen();
    if (!this.client.session.inspect) unsupported("inspect");
    const result = await this.client.session.inspect({ id: this.id }, { signal: this.client.signal, deadline: Date.now() + 30_000 });
    if (!result) return { state: "unknown" };
    if (result.id !== this.id) throw new SandbarError("INVALID_RESPONSE", "Provider returned another sandbox", "unknown");
    return { state: result.state };
  }
  async submitExec(input: ExecInput, options: { signal?: AbortSignal } = {}): Promise<AdapterOperation<ExecOutput>> {
    if (!this.supports("exec")) unsupported("exec");
    const request = validateExec(input);
    const max = this.client.session.supports.exec!.maxOutputBytes;
    if (request.maxOutputBytes > max) unsupported("requested output limit");
    return this.client.submit("exec", {
      sandbox: { id: this.id },
      command: request.command,
      cwd: request.cwd,
      env: request.env,
      deadlineSeconds: request.deadlineSeconds,
      maxOutputBytes: request.maxOutputBytes,
    }, (result, ref) => {
      if (result.kind !== "completed" || !("stdout" in result.value)) throw asUnknown(ref);
      const output = result.value;
      if (!(output.stdout instanceof Uint8Array) || !(output.stderr instanceof Uint8Array)) throw asUnknown(ref);
      return checkExec(execOutput(output.exitCode, output.stdout, output.stderr, output.truncated));
    }, { ...options, sandboxId: this.id, maxOutputBytes: request.maxOutputBytes });
  }
  async exec(input: ExecInput, options: { signal?: AbortSignal } = {}): Promise<ExecOutput> {
    return (await this.submitExec(input, options)).wait(options);
  }
  async readFile(path: string): Promise<Uint8Array> {
    this.client.ensureOpen();
    if (!this.client.session.files?.read) unsupported("readFile");
    validateFilePath(path);
    const value = await this.client.session.files.read(
      { sandbox: { id: this.id }, path },
      { signal: this.client.signal, deadline: Date.now() + 30_000 },
    );
    if (value instanceof Uint8Array) {
      if (value.length > this.client.session.files.maxBytes)
        throw new SandbarError("OUTPUT_CAPACITY", "File exceeds adapter limit", "unknown");
      return Uint8Array.from(value);
    }
    const reader = value.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || total + part.value.length > this.client.session.files.maxBytes)
          throw new SandbarError("OUTPUT_CAPACITY", "File exceeds adapter limit", "unknown");
        chunks.push(Uint8Array.from(part.value));
        total += part.value.length;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  async writeFile(path: string, bytes: Uint8Array, options: { overwrite?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    if (!this.supports("writeFile")) unsupported("writeFile");
    validateFilePath(path);
    if (!(bytes instanceof Uint8Array)) throw new SandbarError("INVALID_ARGUMENT", "Expected byte buffer");
    const payload = Uint8Array.from(bytes);
    const op = await this.client.submit("file_write", {
      sandbox: { id: this.id }, path, bytes: payload, overwrite: options.overwrite ?? false,
    }, (result, ref) => {
      if (result.kind !== "completed" || !("bytesWritten" in result.value) ||
          result.value.bytesWritten !== payload.length) throw asUnknown(ref);
    }, { ...options, sandboxId: this.id, file: { path, bytes: payload.length } });
    await op.wait(options);
  }
  async destroy(options: { signal?: AbortSignal } = {}): Promise<void> {
    const op = await this.client.submit("destroy", { id: this.id }, (result, ref) => {
      if (result.kind !== "completed" || !("computeStopped" in result.value) || !result.value.computeStopped)
        throw asUnknown(ref, "Compute termination was not confirmed");
    }, { ...options, sandboxId: this.id });
    await op.wait(options);
  }
}

export class AdapterDirectClient {
  private closed = false;
  private closePromise?: Promise<void>;
  readonly session: AdapterSession;
  readonly signal: AbortSignal;
  readonly sandboxes: {
    create: (input: CreateInput, options?: { signal?: AbortSignal }) => Promise<AdapterSandbox>;
    submitCreate: (input: CreateInput, options?: { signal?: AbortSignal }) => Promise<AdapterOperation<AdapterSandbox>>;
  };
  constructor(
    readonly provider: string,
    private readonly connection: AdapterConnection<AdapterSession>,
    private readonly onReference?: (reference: AdapterRecoveryReference) => void | Promise<void>,
  ) {
    this.session = connection.session;
    this.signal = connection.signal;
    this.sandboxes = {
      create: async (input, options = {}) => (await this.submitCreate(input, options)).wait(options),
      submitCreate: (input, options = {}) => this.submitCreate(input, options),
    };
  }
  isClosed() { return this.closed || this.signal.aborted; }
  ensureOpen() {
    if (this.isClosed()) throw new SandbarError("CLIENT_CLOSED", "Client is closed");
  }
  capabilities(): AdapterCapabilities {
    this.ensureOpen();
    const support = this.session.supports;
    return {
      images: support.images,
      network: support.network,
      exec: !!this.session.exec && !!support.exec,
      inspect: !!this.session.inspect,
      inventory: !!this.session.inventory,
      readFile: !!this.session.files?.read,
      writeFile: !!this.session.files?.write,
      maxOutputBytes: support.exec?.maxOutputBytes ?? 0,
      maxFileBytes: this.session.files?.maxBytes ?? 0,
    };
  }
  async submitCreate(input: CreateInput, options: { signal?: AbortSignal } = {}): Promise<AdapterOperation<AdapterSandbox>> {
    const request = validateCreate(input);
    return this.submit("create", {
      image: request.environment,
      networkPolicy: request.networkPolicy ?? "blocked",
      region: request.region,
      labels: request.labels,
    }, (result, ref) => {
      if (result.kind !== "completed" || !("id" in result.value)) throw asUnknown(ref);
      return new AdapterSandbox(this, result.value.id);
    }, options);
  }
  async submit<T>(
    kind: OperationKind,
    input: unknown,
    decode: (result: RuntimeResult, ref: AdapterRecoveryReference) => T,
    options: {
      signal?: AbortSignal;
      sandboxId?: string;
      file?: { path: string; bytes: number };
      maxOutputBytes?: number;
    } = {},
  ): Promise<AdapterOperation<T>> {
    this.ensureOpen();
    assertSignal(options.signal);
    const prepared = await prepareOperation(this.session, kind, input, this.signal);
    this.ensureOpen();
    assertSignal(options.signal);
    const ids = identity();
    const reference = sealedReference({
      version: 2,
      mode: "direct",
      provider: this.provider,
      kind,
      scope: this.connection.scope,
      ...ids,
      sandboxId: options.sandboxId,
      file: options.file,
      maxOutputBytes: options.maxOutputBytes,
    });
    await this.onReference?.(reference);
    this.ensureOpen();
    assertSignal(options.signal);
    let first: RuntimeResult;
    const signals = options.signal ? [this.signal, options.signal] : [this.signal];
    const waiting = AbortSignal.any(signals);
    try {
      first = await raceAbort(
        submitOperation(prepared, ids, waiting, options.maxOutputBytes),
        waiting,
      );
    } catch {
      if (waiting.aborted) abortWaiting(reference, waiting.reason);
      throw asUnknown(reference, "Provider submission outcome is unknown");
    }
    return new AdapterOperation(this, reference, decode, first);
  }
  async recover(reference: AdapterRecoveryReference): Promise<AdapterOperation<unknown>> {
    this.ensureOpen();
    reference = sealedReference(reference);
    if (reference.provider !== this.provider ||
        canonicalScope(reference.scope) !== canonicalScope(this.connection.scope))
      throw new SandbarError("FORBIDDEN", "Recovery scope does not match the verified connection");
    if (reference.kind === "create" && reference.sandboxId) throw new SandbarError("INVALID_ARGUMENT", "Create reference cannot have a sandbox");
    if (reference.kind !== "create" && !reference.sandboxId) throw new SandbarError("INVALID_ARGUMENT", "Recovery sandbox is missing");
    return new AdapterOperation(this, reference, (result, ref) => {
      if (result.kind !== "completed") throw asUnknown(ref);
      const value = result.value;
      if (ref.kind === "create" && "id" in value) return new AdapterSandbox(this, value.id);
      if (ref.kind === "exec" && "stdout" in value &&
          value.stdout instanceof Uint8Array && value.stderr instanceof Uint8Array)
        return checkExec(execOutput(value.exitCode, value.stdout, value.stderr, value.truncated));
      if (ref.kind === "destroy" && "computeStopped" in value && value.computeStopped) return;
      if (ref.kind === "file_write" && "bytesWritten" in value && value.bytesWritten === ref.file?.bytes) return;
      throw asUnknown(ref, "Recovered completion mismatches the operation");
    });
  }
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = this.connection.close();
    }
    return this.closePromise;
  }
}

export type AdapterConnectOptions<C extends z.ZodType, K extends z.ZodType, S extends AdapterSession> = {
  adapter: AdapterDefinition<C, K, S>;
  config: z.input<C>;
  credentials: z.input<K>;
  onReference?: (reference: AdapterRecoveryReference) => void | Promise<void>;
  onDiagnostic?: (error: unknown) => void;
};

export async function connectDirect<C extends z.ZodType, K extends z.ZodType, S extends AdapterSession>(
  options: AdapterConnectOptions<C, K, S>,
): Promise<AdapterDirectClient> {
  const connection = await connectAdapter(options.adapter, {
    config: options.config,
    credentials: options.credentials,
    onDiagnostic: options.onDiagnostic,
  });
  return new AdapterDirectClient(options.adapter.name, connection, options.onReference);
}
