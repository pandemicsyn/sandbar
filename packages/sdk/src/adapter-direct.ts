import { z } from "zod";
import {
  AdapterError,
  connectAdapter,
  observeOperation,
  prepareOperation,
  submitOperation,
  type AdapterConnection,
  type AdapterDefinition,
  type RuntimeSession,
  type CreateInput as AdapterCreateInput,
  type ExecInput as AdapterExecInput,
  type FileWriteInput,
  type Json,
  type OperationKind,
  type PreparedOperation,
  type RuntimeResult,
  type Scope,
  type Sandbox,
} from "sandbar-adapter";
import {
  NonzeroExitError,
  NoExitCodeError,
  OutcomeUnknownError,
  WaitAbortedError,
  SandbarError,
  checkExec,
  execOutput,
  newInvocationKey,
  raceAbort,
  validateCreate,
  validateExec,
  validateFilePath,
  waitDelay,
  type CreateInput,
  type ExecInput,
  type ExecOutput,
} from "./resource";
import type { BoundAdapter } from "./bound";

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
  file: z
    .strictObject({
      path: z.string().min(1).max(4096),
      bytes: z.number().int().nonnegative().max(1_048_576),
    })
    .optional(),
  maxOutputBytes: z.number().int().nonnegative().max(1_048_576).optional(),
  tokenVersion: z.number().int().positive().optional(),
  token: z.json().optional(),
});

export type AdapterRecoveryReference = z.infer<typeof ReferenceSchema>;

function canonicalScope(scope: Scope): string {
  return JSON.stringify({
    authority: scope.authority,
    partition: Object.fromEntries(
      Object.entries(scope.partition).sort(([a], [b]) => a.localeCompare(b)),
    ),
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

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The reference schema parsed a JSON token; freeze only its container variants.
  if (copy.token && typeof copy.token === "object") Object.freeze(copy.token);

  return Object.freeze(copy);
}

function identity() {
  const id = () => `sdk_${crypto.randomUUID().replaceAll("-", "")}`;

  return { operationId: id(), submissionId: id(), invocationKey: newInvocationKey() };
}

function asUnknown(
  ref: AdapterRecoveryReference,
  reason?: string,
): OutcomeUnknownError<AdapterRecoveryReference> {
  return new OutcomeUnknownError(ref, reason);
}

function unsupported(feature: string): never {
  throw new SandbarError("UNSUPPORTED", `${feature} is unsupported`);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- AbortSignal.reason may be any JavaScript value and is preserved in WaitAbortedError.
function abortWaiting(ref: AdapterRecoveryReference, reason: unknown): never {
  throw new WaitAbortedError(ref, reason);
}

function assertSignal(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new SandbarError("WAIT_ABORTED", "Waiting stopped before submission", "none");
}

export type AdapterCapabilities = {
  commands: readonly ("argv" | "shell")[];
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
    return this.observeWithSignal(this.client.signal);
  }
  private async observeWithSignal(signal: AbortSignal): Promise<T | null> {
    if (signal.aborted) abortWaiting(this.reference, signal.reason);

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
      const observed = await raceAbort(
        observeOperation(
          this.client.session,
          this.reference.kind,
          {
            operationId: this.reference.operationId,
            submissionId: this.reference.submissionId,
            sandbox: this.reference.sandboxId ? { id: this.reference.sandboxId } : undefined,
            token: this.reference.token,
            version: this.reference.tokenVersion,
          },
          signal,
          this.reference.maxOutputBytes,
        ),
        signal,
      ).catch((error) => {
        if (signal.aborted) abortWaiting(this.reference, signal.reason);

        if (
          error instanceof AdapterError &&
          (error.code === "CONFLICT" || error.code === "INVALID_ARGUMENT")
        )
          throw new SandbarError(error.code, error.message);

        return null;
      });

      if (!observed)
        throw asUnknown(this.reference, "No correlated provider observation is available");
      result = observed;
    }

    if (signal.aborted) abortWaiting(this.reference, signal.reason);

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
      if (!wasFirst) throw asUnknown(this.reference, "Observation cannot certify rejection");
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

      if (error instanceof NonzeroExitError || error instanceof NoExitCodeError) {
        this.terminal = { error };
        throw error;
      }

      throw asUnknown(this.reference, "Provider completion failed validation");
    }
  }
  async wait(options: { signal?: AbortSignal; pollMs?: number } = {}): Promise<T> {
    const pollMs = options.pollMs ?? 500;

    const signal = options.signal
      ? AbortSignal.any([this.client.signal, options.signal])
      : this.client.signal;

    if (!Number.isSafeInteger(pollMs) || pollMs < 50 || pollMs > 60_000)
      throw new SandbarError("INVALID_ARGUMENT", "Invalid polling interval");

    while (true) {
      if (this.client.isClosed()) abortWaiting(this.reference, this.client.signal.reason);

      if (options.signal?.aborted) abortWaiting(this.reference, options.signal.reason);
      const value = await this.observeWithSignal(signal);

      if (value !== null) return value;
      await waitDelay(pollMs, signal).catch((error) => abortWaiting(this.reference, error));
    }
  }
}

export class AdapterSandbox {
  constructor(
    private readonly client: AdapterDirectClient,
    readonly id: string,
  ) {}
  supports(feature: "inspect" | "exec" | "readFile" | "writeFile" | "destroy"): boolean {
    if (feature === "inspect") return !!this.client.session.inspect;

    if (feature === "exec")
      return !!this.client.session.exec && !!this.client.session.supports.exec;

    if (feature === "readFile") return !!this.client.session.files?.read;

    if (feature === "writeFile") return !!this.client.session.files?.write;

    return true;
  }
  async inspect(): Promise<{ state: "running" | "destroyed" | "unknown" }> {
    this.client.ensureOpen();

    if (!this.client.session.inspect) unsupported("inspect");

    const result = await this.client.session.inspect(
      { id: this.id },
      { signal: this.client.signal, deadline: Date.now() + 30_000 },
    );

    if (!result) return { state: "unknown" };

    if (result.id !== this.id)
      throw new SandbarError("INVALID_RESPONSE", "Provider returned another sandbox", "unknown");

    return { state: result.state };
  }
  async submitExec(
    input: ExecInput | readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<AdapterOperation<ExecOutput>> {
    if (!this.supports("exec")) unsupported("exec");
    const request = validateExec(input);
    const max = this.client.session.supports.exec!.maxOutputBytes;

    if (request.maxOutputBytes > max) unsupported("requested output limit");

    return this.client.submit(
      "exec",
      {
        sandbox: { id: this.id },
        command: request.command,
        cwd: request.cwd,
        env: request.env,
        deadlineSeconds: request.deadlineSeconds,
        maxOutputBytes: request.maxOutputBytes,
      },
      (result, ref) => {
        if (result.kind !== "completed" || !("stdout" in result.value)) throw asUnknown(ref);
        const output = result.value;

        if (!(output.stdout instanceof Uint8Array) || !(output.stderr instanceof Uint8Array))
          throw asUnknown(ref);

        return checkExec(
          execOutput(output.exitCode, output.stdout, output.stderr, output.truncated),
        );
      },
      { ...options, sandboxId: this.id, maxOutputBytes: request.maxOutputBytes },
    );
  }
  async exec(
    input: ExecInput | readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<ExecOutput> {
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

        if (
          !(part.value instanceof Uint8Array) ||
          total + part.value.length > this.client.session.files.maxBytes
        )
          throw new SandbarError("OUTPUT_CAPACITY", "File exceeds adapter limit", "unknown");
        chunks.push(Uint8Array.from(part.value));
        total += part.value.length;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    return bytes;
  }
  async writeFile(
    path: string,
    bytes: Uint8Array,
    options: { overwrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!this.supports("writeFile")) unsupported("writeFile");
    validateFilePath(path);

    if (!(bytes instanceof Uint8Array))
      throw new SandbarError("INVALID_ARGUMENT", "Expected byte buffer");
    const payload = Uint8Array.from(bytes);

    const op = await this.client.submit(
      "file_write",
      {
        sandbox: { id: this.id },
        path,
        bytes: payload,
        overwrite: options.overwrite ?? false,
      },
      (result, ref) => {
        if (
          result.kind !== "completed" ||
          !("bytesWritten" in result.value) ||
          result.value.bytesWritten !== payload.length
        )
          throw asUnknown(ref);
      },
      { ...options, sandboxId: this.id, file: { path, bytes: payload.length } },
    );

    await op.wait(options);
  }
  async destroy(options: { signal?: AbortSignal } = {}): Promise<void> {
    const op = await this.client.submit(
      "destroy",
      { id: this.id },
      (result, ref) => {
        if (
          result.kind !== "completed" ||
          !("computeStopped" in result.value) ||
          !result.value.computeStopped
        )
          throw asUnknown(ref, "Compute termination was not confirmed");
      },
      { ...options, sandboxId: this.id },
    );

    await op.wait(options);
  }
}

/** Optional lifecycle API for applications with their own durable operation ledger. */
export const ADAPTER_CONTRACT_VERSION = 1 as const;

export type AdvancedOperationResult = RuntimeResult;

export type AdvancedOperationKind = OperationKind;

export type AdvancedIdentity = { operationId: string; submissionId: string; invocationKey: string };

export type AdvancedObservation = {
  scope: Scope;
  kind: OperationKind;
  operationId: string;
  submissionId: string;
  sandboxId?: string;
  token?: Json;
  tokenVersion?: number;
};

const AdvancedIdentitySchema = z.strictObject({
  operationId: z.string().min(1).max(128),
  submissionId: z.string().min(1).max(128),
  invocationKey: z.string().min(1).max(128),
});

class BeforeSubmitError extends Error {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The reference callback may reject with any JavaScript value; preserve its cause.
  constructor(readonly original: unknown) {
    super("Submission barrier failed");
  }
}

export class PreparedAdapterAttempt {
  private used = false;
  constructor(
    private readonly client: AdapterDirectClient,
    private readonly prepared: PreparedOperation,
    private readonly kind: OperationKind,
    private readonly maxOutputBytes?: number,
  ) {}
  /** The callback must durably record the submission marker; false cancels dispatch. */
  async submit(
    identity: AdvancedIdentity,
    options: { beforeSubmit: () => Promise<boolean>; signal?: AbortSignal },
  ): Promise<AdvancedOperationResult | null> {
    if (this.used) throw new SandbarError("CONFLICT", "Prepared attempt was already used");
    this.used = true;
    this.client.ensureOpen();
    assertSignal(options.signal);
    const checked = AdvancedIdentitySchema.parse(identity);
    let permitted: boolean;

    try {
      permitted = await options.beforeSubmit();
    } catch (error) {
      throw new BeforeSubmitError(error);
    }

    if (!permitted) return null;
    this.client.ensureOpen();
    assertSignal(options.signal);

    const signal = options.signal
      ? AbortSignal.any([this.client.signal, options.signal])
      : this.client.signal;

    try {
      return await raceAbort(
        submitOperation(
          this.prepared,
          checked,
          signal,
          this.kind === "exec" ? this.maxOutputBytes : undefined,
        ),
        signal,
      );
    } catch (error) {
      if (signal.aborted)
        return {
          kind: "unknown",
          reason: "Provider submission outcome is unknown after cancellation",
        };
      throw error;
    }
  }
}

export class AdapterDirectClient {
  private closed = false;
  private closePromise?: Promise<void>;
  readonly session: RuntimeSession;
  readonly scope: Scope;
  readonly operations: {
    inventory: (input: { cursor?: string; limit: number }) => Promise<{
      items: { id: string; state: "running" | "destroyed" | "unknown" }[];
      nextCursor?: string;
    }>;
    prepare: (
      kind: OperationKind,
      input: AdapterCreateInput | AdapterExecInput | FileWriteInput | Sandbox,
      options?: { signal?: AbortSignal; maxOutputBytes?: number },
    ) => Promise<PreparedAdapterAttempt>;
    observe: (
      input: AdvancedObservation,
      options?: { signal?: AbortSignal },
    ) => Promise<AdvancedOperationResult | null>;
  };
  readonly signal: AbortSignal;
  readonly sandboxes: {
    create: (input: CreateInput, options?: { signal?: AbortSignal }) => Promise<AdapterSandbox>;
    submitCreate: (
      input: CreateInput,
      options?: { signal?: AbortSignal },
    ) => Promise<AdapterOperation<AdapterSandbox>>;
  };
  constructor(
    readonly provider: string,
    private readonly connection: AdapterConnection<RuntimeSession>,
    private readonly onReference?: (reference: AdapterRecoveryReference) => void | Promise<void>,
  ) {
    this.session = connection.session;
    this.scope = connection.scope;
    this.signal = connection.signal;
    this.operations = {
      inventory: async (input) => {
        this.ensureOpen();

        if (!this.session.inventory) unsupported("inventory");

        const checked = z
          .strictObject({
            cursor: z.string().max(4096).optional(),
            limit: z.number().int().min(1).max(100),
          })
          .parse(input);

        const result = await this.session.inventory(checked, {
          signal: this.signal,
          deadline: Date.now() + 30_000,
        });

        return z
          .strictObject({
            items: z
              .array(
                z.strictObject({
                  id: z.string().min(1).max(512),
                  state: z.enum(["running", "destroyed", "unknown"]),
                }),
              )
              .max(100),
            nextCursor: z.string().max(4096).optional(),
          })
          .parse(result);
      },
      prepare: async (kind, input, options = {}) => {
        this.ensureOpen();
        assertSignal(options.signal);

        const signal = options.signal
          ? AbortSignal.any([this.signal, options.signal])
          : this.signal;

        let prepared: PreparedOperation;

        try {
          prepared = await prepareOperation(this.session, kind, input, signal);
        } catch (error) {
          if (error instanceof AdapterError && error.code === "INVALID_ARGUMENT")
            throw new SandbarError(error.code, error.message);
          throw error;
        }

        this.ensureOpen();

        return new PreparedAdapterAttempt(this, prepared, kind, options.maxOutputBytes);
      },
      observe: async (input, options = {}) => {
        this.ensureOpen();
        assertSignal(options.signal);

        const signal = options.signal
          ? AbortSignal.any([this.signal, options.signal])
          : this.signal;

        const checked = z
          .strictObject({
            scope: ReferenceSchema.shape.scope,
            kind: z.enum(["create", "destroy", "exec", "file_write"]),
            operationId: z.string().min(1).max(128),
            submissionId: z.string().min(1).max(128),
            sandboxId: z.string().min(1).max(512).optional(),
            token: z.json().optional(),
            tokenVersion: z.number().int().positive().optional(),
          })
          .parse(input);

        if (canonicalScope(checked.scope) !== canonicalScope(this.scope))
          throw new SandbarError(
            "FORBIDDEN",
            "Observation scope differs from the verified connection",
          );

        if (
          (checked.kind === "create" && checked.sandboxId) ||
          (checked.kind !== "create" && !checked.sandboxId)
        )
          throw new SandbarError("INVALID_ARGUMENT", "Observation sandbox binding is invalid");

        try {
          return await raceAbort(
            observeOperation(
              this.session,
              checked.kind,
              {
                operationId: checked.operationId,
                submissionId: checked.submissionId,
                sandbox: checked.sandboxId ? { id: checked.sandboxId } : undefined,
                token: checked.token,
                version: checked.tokenVersion,
              },
              signal,
            ),
            signal,
          );
        } catch (error) {
          if (signal.aborted)
            return {
              kind: "unknown",
              reason: "Provider observation outcome is unknown after cancellation",
            };
          throw error;
        }
      },
    };
    this.sandboxes = {
      create: async (input, options = {}) =>
        (await this.submitCreate(input, options)).wait(options),
      submitCreate: (input, options = {}) => this.submitCreate(input, options),
    };
  }
  isClosed() {
    return this.closed || this.signal.aborted;
  }
  ensureOpen() {
    if (this.isClosed()) throw new SandbarError("CLIENT_CLOSED", "Client is closed");
  }
  capabilities(): AdapterCapabilities {
    this.ensureOpen();
    const support = this.session.supports;

    return {
      commands: support.exec?.commands ?? [],
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
  async submitCreate(
    input: CreateInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<AdapterOperation<AdapterSandbox>> {
    const request = validateCreate(input);

    return this.submit(
      "create",
      {
        image: request.environment,
        networkPolicy: request.networkPolicy ?? "blocked",
        region: request.region,
        labels: request.labels,
      },
      (result, ref) => {
        if (result.kind !== "completed" || !("id" in result.value)) throw asUnknown(ref);

        return new AdapterSandbox(this, result.value.id);
      },
      options,
    );
  }
  async submit<T>(
    kind: OperationKind,
    input: AdapterCreateInput | AdapterExecInput | FileWriteInput | Sandbox,
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
    const prepared = await this.operations.prepare(kind, input, options);
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

    let first: RuntimeResult;
    const signals = options.signal ? [this.signal, options.signal] : [this.signal];
    const waiting = AbortSignal.any(signals);

    try {
      first = await raceAbort(
        prepared
          .submit(ids, {
            beforeSubmit: async () => {
              await this.onReference?.(reference);

              return true;
            },
            signal: waiting,
          })
          .then((value) => {
            if (!value) throw new SandbarError("CONFLICT", "Submission was cancelled");

            return value;
          }),
        waiting,
      );
    } catch (error) {
      if (error instanceof BeforeSubmitError) throw error.original;

      if (waiting.aborted) abortWaiting(reference, waiting.reason);
      throw asUnknown(reference, "Provider submission outcome is unknown");
    }

    return new AdapterOperation(this, reference, decode, first);
  }
  async recover(reference: AdapterRecoveryReference): Promise<AdapterOperation<unknown>> {
    this.ensureOpen();
    reference = sealedReference(reference);

    if (
      reference.provider !== this.provider ||
      canonicalScope(reference.scope) !== canonicalScope(this.connection.scope)
    )
      throw new SandbarError("FORBIDDEN", "Recovery scope does not match the verified connection");

    if (reference.kind === "create" && reference.sandboxId)
      throw new SandbarError("INVALID_ARGUMENT", "Create reference cannot have a sandbox");

    if (reference.kind !== "create" && !reference.sandboxId)
      throw new SandbarError("INVALID_ARGUMENT", "Recovery sandbox is missing");

    return new AdapterOperation(this, reference, (result, ref) => {
      if (result.kind !== "completed") throw asUnknown(ref);
      const value = result.value;

      if (ref.kind === "create" && "id" in value) return new AdapterSandbox(this, value.id);

      if (
        ref.kind === "exec" &&
        "stdout" in value &&
        value.stdout instanceof Uint8Array &&
        value.stderr instanceof Uint8Array
      )
        return checkExec(execOutput(value.exitCode, value.stdout, value.stderr, value.truncated));

      if (ref.kind === "destroy" && "computeStopped" in value && value.computeStopped) return;

      if (
        ref.kind === "file_write" &&
        "bytesWritten" in value &&
        value.bytesWritten === ref.file?.bytes
      )
        return;
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

export type AdapterConnectOptions<
  C extends z.ZodType,
  K extends z.ZodType,
  S extends RuntimeSession,
> = {
  adapter: Pick<AdapterDefinition<C, K, S>, "name" | "config" | "credentials"> & {
    connect: (input: never) => Promise<S>;
    policy?: { schema: z.ZodType; default: Json };
  };
  config: z.input<C>;
  credentials: z.input<K>;
  onReference?: (reference: AdapterRecoveryReference) => void | Promise<void>;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A cleanup hook may throw any JavaScript value; the diagnostic receives it intact.
  onDiagnostic?: (error: unknown) => void;
};

export function connectDirect(adapter: BoundAdapter): Promise<AdapterDirectClient>;
export function connectDirect<C extends z.ZodType, K extends z.ZodType, S extends RuntimeSession>(
  options: AdapterConnectOptions<C, K, S>,
): Promise<AdapterDirectClient>;

export async function connectDirect<
  C extends z.ZodType,
  K extends z.ZodType,
  S extends RuntimeSession,
>(options: AdapterConnectOptions<C, K, S> | BoundAdapter): Promise<AdapterDirectClient> {
  if ("bound" in options) {
    const connection = await connectAdapter(options, { config: {}, credentials: {} });

    return new AdapterDirectClient(options.name, connection);
  }

  const connection = await connectAdapter(options.adapter, {
    config: options.config,
    credentials: options.credentials,
    onDiagnostic: options.onDiagnostic,
  });

  return new AdapterDirectClient(options.adapter.name, connection, options.onReference);
}
