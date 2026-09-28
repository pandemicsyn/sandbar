import { z } from "zod";
import { CreateSandboxInput, ExecRequest, FilePath } from "./portable";
import {
  AdapterError,
  createAttemptContext,
  createObserveContext,
  isOutcome,
  operationParts,
  outcomeKind,
  type AdapterSession,
  type AttemptContext,
  type CreateInput,
  type DestroyValue,
  type ExecInput,
  type ExecValue,
  type FileWriteInput,
  type ImageBuildInput,
  type ImageBuildValue,
  type Json,
  type Mutation,
  type Pending,
  type Rejected,
  type Sandbox,
  type Unknown,
} from "./index";

export type RuntimeSession = Omit<
  AdapterSession,
  "create" | "destroy" | "exec" | "files" | "imageBuild"
> & {
  create: unknown;
  imageBuild?: unknown;
  destroy: unknown;
  exec?: unknown;
  files?: {
    maxBytes: number;
    read?: NonNullable<AdapterSession["files"]>["read"];
    write?: unknown;
  };
};

export type OperationKind = "create" | "destroy" | "exec" | "file_write" | "image_build";

export type SpecialOutcome = Pending | Unknown | Rejected;

export type OperationResult =
  | { id: string; state: "running" | "unknown" }
  | DestroyValue
  | ExecValue
  | ImageBuildValue
  | { bytesWritten: number };

export type PreparedOperation = {
  readonly kind: OperationKind;
  readonly input: unknown;
  readonly operation: Mutation<unknown, unknown, unknown>;
};

export type RuntimeResult =
  | { kind: "completed"; value: OperationResult }
  | { kind: "pending"; token: Json; pollAfterMs: number; version: number }
  | { kind: "unknown"; reason: string }
  | { kind: "rejected"; code: string; message: string };

const Id = z.string().min(1).max(512);

const SandboxSchema = z.strictObject({ id: Id });

const CreateInputSchema = z.strictObject({
  image: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("prepared"),
      value: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/),
    }),
    z.strictObject({ kind: z.literal("oci"), value: z.string().min(1).max(1024) }),
  ]),
  networkPolicy: z.string().min(1).max(128),
  region: z.string().min(1).max(128).optional(),
  labels: z.record(z.string().min(1).max(64), z.string().max(256)).optional(),
});

const ImageBuildInputSchema = z.strictObject({
  source: z.strictObject({ kind: z.literal("oci"), value: z.string().min(1).max(1024) }),
});

const ExecInputSchema = z.strictObject({
  sandbox: SandboxSchema,
  command: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("argv"),
      argv: z.array(z.string().max(8192)).min(1).max(128),
    }),
    z.strictObject({ kind: z.literal("shell"), script: z.string().min(1).max(65536) }),
  ]),
  cwd: z.string().min(1).max(4096).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192)).optional(),
  deadlineSeconds: z.number().int().min(1).max(3600),
  maxOutputBytes: z.number().int().nonnegative().max(1_048_576),
});

const FileWriteInputSchema = z.strictObject({
  sandbox: SandboxSchema,
  path: FilePath,
  bytes: z.instanceof(Uint8Array),
  overwrite: z.boolean(),
});

const CreateValueSchema = z.strictObject({ id: Id, state: z.enum(["running", "unknown"]) });

const ImageBuildValueSchema = z.strictObject({
  preparedId: Id,
  retainedResources: z
    .array(
      z.strictObject({
        kind: z.string().min(1).max(128),
        id: Id,
        ownership: z.enum(["verified", "unknown"]),
        cleanup: z.enum(["manual", "provider_expiry", "none_known"]),
      }),
    )
    .max(128),
});

const DestroyValueSchema = z.strictObject({
  computeStopped: z.boolean(),
  retainedResources: z.array(z.string().min(1).max(512)).max(128),
});

const WriteValueSchema = z.strictObject({
  bytesWritten: z.number().int().nonnegative().max(1_048_576),
});

const ExecValueSchema = z.strictObject({
  exitCode: z.number().int().nullable(),
  stdout: z.union([
    z.instanceof(Uint8Array),
    z.custom<ReadableStream<Uint8Array>>((value) => value instanceof ReadableStream),
  ]),
  stderr: z.union([
    z.instanceof(Uint8Array),
    z.custom<ReadableStream<Uint8Array>>((value) => value instanceof ReadableStream),
  ]),
  truncated: z.boolean(),
});

const MAX_OUTPUT = 1_048_576;

function checkedRecoveryVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version <= 0)
    throw new AdapterError("INVALID_ARGUMENT", "Invalid recovery token version");

  return version;
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- AbortSignal.reason is caller-owned and must propagate unchanged through cancellation.
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };

    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function collect(
  value: Uint8Array | ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (signal.aborted) throw abortReason(signal);

  if (value instanceof Uint8Array) {
    return {
      bytes: Uint8Array.from(value.subarray(0, limit)),
      truncated: value.length > limit,
    };
  }

  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    if (limit === 0) {
      // No read is needed to enforce a zero-byte budget; EOF is unproven.
      truncated = true;
    } else {
      while (true) {
        const next = await readWithAbort(reader, signal);

        if (next.done) break;

        if (!(next.value instanceof Uint8Array))
          throw new AdapterError("INVALID_ARGUMENT", "Execution stream emitted non-byte data");
        const remaining = limit - total;

        if (next.value.length > remaining) {
          if (remaining > 0) chunks.push(Uint8Array.from(next.value.subarray(0, remaining)));
          total += remaining;
          truncated = true;
          break;
        }

        chunks.push(Uint8Array.from(next.value));
        total += next.value.length;

        if (total === limit) {
          // Do not wait for another chunk only to distinguish exact EOF from more output.
          truncated = true;
          break;
        }
      }
    }
  } finally {
    // Native stream cancellation is best effort and must not hold a capped result.
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // A broken reader cannot delay delivery of already bounded bytes.
    }
  }

  if (signal.aborted) throw abortReason(signal);

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return { bytes, truncated };
}

async function validateValue(
  kind: OperationKind,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native operation results cross the provider boundary and are parsed by kind below.
  value: unknown,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<OperationResult> {
  if (signal.aborted) throw abortReason(signal);

  if (kind === "create") return CreateValueSchema.parse(value);

  if (kind === "image_build") return ImageBuildValueSchema.parse(value);

  if (kind === "destroy") return DestroyValueSchema.parse(value);

  if (kind === "file_write") return WriteValueSchema.parse(value);
  const parsed = ExecValueSchema.parse(value);
  const limit = Math.min(MAX_OUTPUT, maxOutputBytes);
  const stdoutStop = new AbortController();
  const stderrStop = new AbortController();
  let failure: { reason: unknown } | undefined;
  let skipStderr = false;

  // Each collector retains at most `limit` bytes in chunks and may assemble one
  // bounded buffer; the selected final stdout and stderr total at most `limit`.
  const stdoutTask = collect(
    parsed.stdout,
    limit,
    AbortSignal.any([signal, stdoutStop.signal]),
  ).then(
    (value) => ({ kind: "ok" as const, value }),
    (error) => {
      failure ??= { reason: error };
      stderrStop.abort(error);

      return { kind: "error" as const, error };
    },
  );

  const stderrTask = collect(
    parsed.stderr,
    limit,
    AbortSignal.any([signal, stderrStop.signal]),
  ).then(
    (value) => ({ kind: "ok" as const, value }),
    (error) => {
      if (!skipStderr) {
        failure ??= { reason: error };
        stdoutStop.abort(error);
      }

      return { kind: "error" as const, error };
    },
  );

  const stdoutResult = await stdoutTask;

  if (stdoutResult.kind === "error") {
    await stderrTask;
    throw failure?.reason ?? stdoutResult.error;
  }

  const stdout = stdoutResult.value;
  let stderr: Awaited<ReturnType<typeof collect>>;

  if (stdout.bytes.length === limit) {
    skipStderr = true;
    stderrStop.abort();
    await stderrTask;
    stderr = {
      bytes: new Uint8Array(),
      truncated:
        parsed.stderr instanceof ReadableStream ||
        (parsed.stderr instanceof Uint8Array && parsed.stderr.length > 0),
    };
  } else {
    const stderrResult = await stderrTask;

    if (stderrResult.kind === "error") throw failure?.reason ?? stderrResult.error;

    const remaining = limit - stdout.bytes.length;
    stderr = {
      bytes: Uint8Array.from(stderrResult.value.bytes.subarray(0, remaining)),
      truncated: stderrResult.value.truncated || stderrResult.value.bytes.length > remaining,
    };
  }

  if (failure) throw failure.reason;

  if (signal.aborted) throw abortReason(signal);

  return {
    exitCode: parsed.exitCode,
    stdout: stdout.bytes,
    stderr: stderr.bytes,
    truncated: parsed.truncated || stdout.truncated || stderr.truncated,
  };
}

function select(session: RuntimeSession, kind: OperationKind): Mutation<unknown, unknown, unknown> {
  let op: unknown;

  switch (kind) {
    case "create":
      op = session.create;
      break;
    case "image_build":
      op = session.imageBuild;
      break;
    case "destroy":
      op = session.destroy;
      break;
    case "exec":
      op = session.exec;
      break;
    case "file_write":
      op = session.files?.write;
      break;
  }

  if (!op) throw new AdapterError("UNSUPPORTED", `${kind} is unsupported`);

  // SAFETY: RuntimeSession comes from a host-installed adapter; select maps its declared operation field by kind.
  return op as Mutation<unknown, unknown, unknown>;
}

function checkCapability(
  session: RuntimeSession,
  kind: OperationKind,
  input: CreateInput | ImageBuildInput | ExecInput | FileWriteInput | Sandbox,
): CreateInput | ImageBuildInput | ExecInput | FileWriteInput | Sandbox {
  if (kind === "image_build") return ImageBuildInputSchema.parse(input);

  if (kind === "create") {
    const request = CreateInputSchema.parse(input);
    CreateSandboxInput.parse({
      environment:
        request.image.kind === "prepared"
          ? { kind: "prepared", imageId: request.image.value }
          : { kind: "oci", reference: request.image.value },
      network: { policy: request.networkPolicy },
      region: request.region,
      labels: request.labels,
    });

    if (
      !session.supports.images.includes(request.image.kind) ||
      !session.supports.network.includes(request.networkPolicy)
    )
      throw new AdapterError("UNSUPPORTED", "Requested image or network policy is unsupported");

    return request;
  }

  if (kind === "exec") {
    const request = ExecInputSchema.parse(input);
    ExecRequest.parse({
      command: request.command,
      cwd: request.cwd,
      env: request.env,
      deadlineSeconds: request.deadlineSeconds,
      output: { capture: "bounded", maxBytes: request.maxOutputBytes },
    });
    const support = session.supports.exec;

    if (
      !support ||
      !support.commands.includes(request.command.kind) ||
      request.maxOutputBytes > support.maxOutputBytes
    )
      throw new AdapterError("UNSUPPORTED", "Requested command or output limit is unsupported");

    return request;
  }

  if (kind === "file_write") {
    const request = FileWriteInputSchema.parse(input);

    if (
      !session.files?.write ||
      (request.overwrite
        ? !session.supports.fileWrite?.overwrite
        : !session.supports.fileWrite?.noClobber)
    )
      throw new AdapterError("UNSUPPORTED", "Requested file write is unsupported");

    if (request.bytes.length > session.files.maxBytes)
      throw new AdapterError("CAPACITY", "File exceeds adapter limit");

    return request;
  }

  return SandboxSchema.parse(input);
}

export async function prepareOperation(
  session: RuntimeSession,
  kind: OperationKind,
  input: CreateInput | ImageBuildInput | ExecInput | FileWriteInput | Sandbox,
  signal: AbortSignal,
): Promise<PreparedOperation> {
  const operation = select(session, kind);
  let checkedInput: CreateInput | ImageBuildInput | ExecInput | FileWriteInput | Sandbox;

  try {
    checkedInput = checkCapability(session, kind, input);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new AdapterError("INVALID_ARGUMENT", `Invalid ${kind} request`);
    throw error;
  }

  const parts = operationParts(operation);

  if (parts.recovery) checkedRecoveryVersion(parts.recovery.version);

  const prepared = parts.prepare
    ? await prepareBeforeDeadline(parts.prepare, structuredClone(checkedInput), signal)
    : structuredClone(checkedInput);

  return { kind, input: prepared, operation };
}

function prepareBeforeDeadline<I, P>(
  prepare: (input: I, context: { signal: AbortSignal; deadline: number }) => Promise<P>,
  input: I,
  signal: AbortSignal,
): Promise<P> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const deadline = Date.now() + 30_000;

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));

      return;
    }

    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      action();
    };

    const onAbort = () =>
      finish(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));

    const timer = setTimeout(
      () => {
        const error = new AdapterError("TIMEOUT", "Adapter preparation deadline exceeded");
        controller.abort(error);
        finish(() => reject(error));
      },
      Math.max(0, deadline - Date.now()),
    );

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        if (combined.aborted) throw combined.reason ?? new DOMException("Aborted", "AbortError");

        return prepare(input, { signal: combined, deadline });
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}

function normalizeSpecial(
  value: SpecialOutcome,
  operation: Mutation<unknown, unknown, unknown>,
): RuntimeResult {
  const parts = operationParts(operation);
  const kind = outcomeKind(value);

  if (kind === "pending") {
    // SAFETY: outcomeKind read the private outcome brand and selected Pending.
    const pending = value as Pending;

    if (!parts.recovery)
      throw new AdapterError("INVALID_ARGUMENT", "Pending requires declared recovery");

    return {
      kind: "pending",
      token: pending.token,
      pollAfterMs: pending.pollAfterMs ?? 500,
      version: checkedRecoveryVersion(parts.recovery.version),
    };
  }

  if (kind === "unknown") {
    // SAFETY: outcomeKind read the private outcome brand and selected Unknown.
    const unknownValue = value as Unknown;

    return { kind: "unknown", reason: unknownValue.reason };
  }

  // SAFETY: Pending and Unknown were handled above; the branded outcome is Rejected.
  const rejected = value as Rejected;

  return { kind: "rejected", code: rejected.code, message: rejected.message };
}

export async function submitOperation(
  prepared: PreparedOperation,
  identity: Pick<AttemptContext, "operationId" | "submissionId" | "invocationKey">,
  signal: AbortSignal,
  maxOutputBytes = MAX_OUTPUT,
): Promise<RuntimeResult> {
  const parts = operationParts(prepared.operation);

  const context = createAttemptContext({ ...identity, signal }, parts.recovery?.token);

  const value = await parts.submit(prepared.input, context);

  if (isOutcome(value)) return normalizeSpecial(value, prepared.operation);

  return {
    kind: "completed",
    value: await validateValue(prepared.kind, value, maxOutputBytes, signal),
  };
}

export async function observeOperation(
  session: RuntimeSession,
  kind: OperationKind,
  attempt: {
    operationId: string;
    submissionId: string;
    sandbox?: Sandbox;
    token?: Json;
    version?: number;
  },
  signal: AbortSignal,
  maxOutputBytes = MAX_OUTPUT,
  onValidated?: () => void,
): Promise<RuntimeResult | null> {
  const operation = select(session, kind);
  const parts = operationParts(operation);

  if (!parts.observe) return null;

  const context = createObserveContext(
    { signal, deadline: Date.now() + 30_000 },
    parts.recovery?.token,
  );

  let token = attempt.token;

  if (token !== undefined) {
    if (!parts.recovery || parts.recovery.version !== attempt.version)
      throw new AdapterError("CONFLICT", "Recovery token version is unsupported");
    // The contextual constructor applies the same bounded parse used for newly pending tokens.
    token = context.pending(token).token;
  }

  onValidated?.();

  const value = await parts.observe({ ...attempt, token, sandbox: attempt.sandbox }, context);

  if (value === null) return null;

  if (isOutcome(value)) {
    if (outcomeKind(value) === "rejected")
      throw new AdapterError("INVALID_ARGUMENT", "Observation cannot certify rejection");

    return normalizeSpecial(value, operation);
  }

  return { kind: "completed", value: await validateValue(kind, value, maxOutputBytes, signal) };
}
