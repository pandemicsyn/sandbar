import { z } from "zod";
import {
  AdapterError,
  createAttemptContext,
  createObserveContext,
  isOutcome,
  operationParts,
  outcomeKind,
  type Guarantees,
  type AttemptContext,
  type CreateInput,
  type DestroyValue,
  type ExecInput,
  type ExecValue,
  type FileWriteInput,
  type Json,
  type Mutation,
  type Pending,
  type Rejected,
  type Sandbox,
  type Unknown,
} from "./index";

export type RuntimeSession = {
  supports: Guarantees;
  create: unknown;
  destroy: unknown;
  exec?: unknown;
  files?: { maxBytes: number; write?: unknown };
};
export type OperationKind = "create" | "destroy" | "exec" | "file_write";
export type SpecialOutcome = Pending | Unknown | Rejected;
export type OperationResult =
  | { id: string; state: "running" | "unknown" }
  | DestroyValue
  | ExecValue
  | { bytesWritten: number };
export type PreparedOperation = {
  readonly kind: OperationKind;
  readonly input: unknown;
  readonly operation: Mutation<unknown, unknown, unknown>;
};
export type RuntimeResult = { kind: "completed"; value: OperationResult }
  | { kind: "pending"; token: Json; pollAfterMs: number; version: number }
  | { kind: "unknown"; reason: string }
  | { kind: "rejected"; code: string; message: string };

const Id = z.string().min(1).max(512);
const CreateValueSchema = z.strictObject({ id: Id, state: z.enum(["running", "unknown"]) });
const DestroyValueSchema = z.strictObject({
  computeStopped: z.boolean(),
  retainedResources: z.array(z.string().min(1).max(512)).max(128),
});
const WriteValueSchema = z.strictObject({ bytesWritten: z.number().int().nonnegative().max(1_048_576) });
const ExecValueSchema = z.strictObject({
  exitCode: z.number().int().nullable(),
  stdout: z.union([z.instanceof(Uint8Array), z.custom<ReadableStream<Uint8Array>>((value) => value instanceof ReadableStream)]),
  stderr: z.union([z.instanceof(Uint8Array), z.custom<ReadableStream<Uint8Array>>((value) => value instanceof ReadableStream)]),
  truncated: z.boolean(),
});
const MAX_OUTPUT = 1_048_576;

async function collect(
  value: Uint8Array | ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
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
    while (true) {
      const next = await reader.read();
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
        const extra = await reader.read();
        truncated = !extra.done;
        break;
      }
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
  return { bytes, truncated };
}

async function validateValue(kind: OperationKind, value: unknown, maxOutputBytes: number): Promise<OperationResult> {
  if (kind === "create") return CreateValueSchema.parse(value);
  if (kind === "destroy") return DestroyValueSchema.parse(value);
  if (kind === "file_write") return WriteValueSchema.parse(value);
  const parsed = ExecValueSchema.parse(value);
  const limit = Math.min(MAX_OUTPUT, maxOutputBytes);
  const stdout = await collect(parsed.stdout, limit);
  const stderr = await collect(parsed.stderr, limit - stdout.bytes.length);
  return {
    exitCode: parsed.exitCode,
    stdout: stdout.bytes,
    stderr: stderr.bytes,
    truncated: parsed.truncated || stdout.truncated || stderr.truncated,
  };
}

function select(session: RuntimeSession, kind: OperationKind): Mutation<unknown, unknown, unknown> {
  const op = kind === "create" ? session.create
    : kind === "destroy" ? session.destroy
    : kind === "exec" ? session.exec
    : session.files?.write;
  if (!op) throw new AdapterError("UNSUPPORTED", `${kind} is unsupported`);
  return op as Mutation<unknown, unknown, unknown>;
}

function checkCapability(session: RuntimeSession, kind: OperationKind, input: unknown): void {
  if (kind === "create") {
    const request = input as CreateInput;
    if (!session.supports.images.includes(request.image.kind) ||
        !session.supports.network.includes(request.networkPolicy))
      throw new AdapterError("UNSUPPORTED", "Requested image or network policy is unsupported");
  }
  if (kind === "exec") {
    const request = input as ExecInput;
    const support = session.supports.exec;
    if (!support || !support.commands.includes(request.command.kind) ||
        request.maxOutputBytes > support.maxOutputBytes)
      throw new AdapterError("UNSUPPORTED", "Requested command or output limit is unsupported");
  }
  if (kind === "file_write") {
    const request = input as FileWriteInput;
    if (!session.files?.write || (request.overwrite && !session.supports.fileWrite?.overwrite))
      throw new AdapterError("UNSUPPORTED", "Requested file write is unsupported");
    if (request.bytes.length > session.files.maxBytes)
      throw new AdapterError("CAPACITY", "File exceeds adapter limit");
  }
}

export async function prepareOperation(
  session: RuntimeSession,
  kind: OperationKind,
  input: unknown,
  signal: AbortSignal,
): Promise<PreparedOperation> {
  const operation = select(session, kind);
  checkCapability(session, kind, input);
  const parts = operationParts(operation);
  const prepared = parts.prepare
    ? await parts.prepare(structuredClone(input), { signal, deadline: Date.now() + 30_000 })
    : structuredClone(input);
  return { kind, input: prepared, operation };
}

function normalizeSpecial(value: SpecialOutcome, operation: Mutation<unknown, unknown, unknown>): RuntimeResult {
  const parts = operationParts(operation);
  const kind = outcomeKind(value);
  if (kind === "pending") {
    const pending = value as Pending;
    if (!parts.recovery) throw new AdapterError("INVALID_ARGUMENT", "Pending requires declared recovery");
    return {
      kind: "pending",
      token: pending.token,
      pollAfterMs: pending.pollAfterMs ?? 500,
      version: parts.recovery.version,
    };
  }
  if (kind === "unknown") return { kind: "unknown", reason: (value as Unknown).reason };
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
  const context = createAttemptContext(
    { ...identity, signal },
    parts.recovery?.token as z.ZodType<Json> | undefined,
  );
  const value = await parts.submit(prepared.input, context);
  if (isOutcome(value)) return normalizeSpecial(value, prepared.operation);
  return { kind: "completed", value: await validateValue(prepared.kind, value, maxOutputBytes) };
}

export async function observeOperation(
  session: RuntimeSession,
  kind: OperationKind,
  attempt: { operationId: string; submissionId: string; sandbox?: Sandbox; token?: Json; version?: number },
  signal: AbortSignal,
  maxOutputBytes = MAX_OUTPUT,
): Promise<RuntimeResult | null> {
  const operation = select(session, kind);
  const parts = operationParts(operation);
  if (!parts.observe) return null;
  if (attempt.token !== undefined) {
    if (!parts.recovery || parts.recovery.version !== attempt.version)
      throw new AdapterError("CONFLICT", "Recovery token version is unsupported");
    parts.recovery.token.parse(attempt.token);
  }
  const context = createObserveContext(
    { signal, deadline: Date.now() + 30_000 },
    parts.recovery?.token as z.ZodType<Json> | undefined,
  );
  const value = await parts.observe({ ...attempt, sandbox: attempt.sandbox }, context);
  if (value === null) return null;
  if (isOutcome(value)) {
    if (outcomeKind(value) === "rejected")
      throw new AdapterError("INVALID_ARGUMENT", "Observation cannot certify rejection");
    return normalizeSpecial(value, operation);
  }
  return { kind: "completed", value: await validateValue(kind, value, maxOutputBytes) };
}
