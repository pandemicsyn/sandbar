import { z } from "zod";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Scope = {
  authority: { kind: string; id: string };
  partition: Readonly<Record<string, string>>;
};
export type Sandbox = { readonly id: string };
export type Image = { kind: "prepared" | "oci"; value: string };
export type CreateInput = {
  image: Image;
  networkPolicy: string;
  region?: string;
  labels?: Record<string, string>;
};
export type CreateValue = { id: string; state: "running" | "unknown" };
export type DestroyValue = { computeStopped: boolean; retainedResources: string[] };
export type Command = { kind: "argv"; argv: string[] } | { kind: "shell"; script: string };
export type ExecInput<C extends Command["kind"] = Command["kind"]> = {
  sandbox: Sandbox;
  command: Extract<Command, { kind: C }>;
  cwd?: string;
  env?: Record<string, string>;
  deadlineSeconds: number;
  maxOutputBytes: number;
};
export type ExecValue = {
  exitCode: number | null;
  stdout: Uint8Array | ReadableStream<Uint8Array>;
  stderr: Uint8Array | ReadableStream<Uint8Array>;
  truncated: boolean;
};
export type FileWriteInput = { sandbox: Sandbox; path: string; bytes: Uint8Array; overwrite: boolean };
export type FileWriteValue = { bytesWritten: number };
export type ReadContext = { readonly signal: AbortSignal; readonly deadline: number };
export type HostContext<P extends Json = Json> = {
  readonly signal: AbortSignal;
  readonly policy: Readonly<P>;
  onClose(release: () => void | Promise<void>): void;
};
const outcomeBrand: unique symbol = Symbol("sandbar.adapter.outcome");
export type Pending = { readonly [outcomeBrand]: "pending"; readonly token: Json; readonly pollAfterMs?: number };
export type Unknown = { readonly [outcomeBrand]: "unknown"; readonly reason: string };
export type Rejected = { readonly [outcomeBrand]: "rejected"; readonly code: AdapterErrorCode; readonly message: string };
export type AdapterErrorCode =
  | "INVALID_ARGUMENT" | "UNSUPPORTED" | "UNAUTHENTICATED" | "NOT_FOUND"
  | "CONFLICT" | "CAPACITY" | "RATE_LIMIT" | "UNAVAILABLE" | "TIMEOUT" | "INTERNAL";
export class AdapterError extends Error {
  constructor(readonly code: AdapterErrorCode, message: string) {
    super(message);
    this.name = "AdapterError";
  }
}
export type AttemptContext<T extends Json = Json> = {
  readonly operationId: string;
  readonly submissionId: string;
  readonly invocationKey: string;
  readonly signal: AbortSignal;
  pending(token: T, options?: { pollAfterMs?: number }): Pending;
  reject(code: AdapterErrorCode, message: string): Rejected;
  unknown(reason: string): Unknown;
};
export type ObserveContext<T extends Json = Json> = ReadContext & {
  pending(token: T, options?: { pollAfterMs?: number }): Pending;
  unknown(reason: string): Unknown;
};
export type RecoveryAttempt<T extends Json = Json, S extends Sandbox | undefined = Sandbox | undefined> = {
  readonly operationId: string;
  readonly submissionId: string;
  readonly sandbox: S;
  readonly token?: T;
};
export type Mutation<I, V, P = I, T extends Json = Json, S extends Sandbox | undefined = Sandbox | undefined> =
  | ((input: I, ctx: AttemptContext<T>) => Promise<V | Pending | Unknown | Rejected>)
  | {
      recovery?: { version: number; token: z.ZodType<T> };
      prepare?: (input: I, ctx: ReadContext) => Promise<P>;
      submit: (input: P, ctx: AttemptContext<T>) => Promise<V | Pending | Unknown | Rejected>;
      observe?: (attempt: RecoveryAttempt<T, S>, ctx: ObserveContext<T>) => Promise<V | Pending | Unknown | null>;
    };
export type Guarantees<C extends Command["kind"] = Command["kind"]> = {
  images: readonly ("prepared" | "oci")[];
  network: readonly string[];
  exec?: { commands: readonly C[]; maxOutputBytes: number };
  fileWrite?: { overwrite: boolean };
};
export type AdapterSession<CP = CreateInput, DP = Sandbox, EP = ExecInput, WP = FileWriteInput, C extends Command["kind"] = Command["kind"], CT extends Json = Json> = {
  scope: Scope;
  supports: Guarantees<C>;
  create: Mutation<CreateInput, CreateValue, CP, CT, undefined>;
  destroy: Mutation<Sandbox, DestroyValue, DP, Json, Sandbox>;
  inspect?: (box: Sandbox, ctx: ReadContext) => Promise<{ id: string; state: "running" | "destroyed" | "unknown" } | null>;
  exec?: Mutation<ExecInput, ExecValue, EP, Json, Sandbox>;
  files?: {
    maxBytes: number;
    read?: (input: { sandbox: Sandbox; path: string }, ctx: ReadContext) => Promise<Uint8Array | ReadableStream<Uint8Array>>;
    write?: Mutation<FileWriteInput, FileWriteValue, WP, Json, Sandbox>;
  };
  inventory?: (input: { cursor?: string; limit: number }, ctx: ReadContext) => Promise<{ items: { id: string; state: "running" | "destroyed" | "unknown" }[]; nextCursor?: string }>;
};
export type AdapterDefinition<C extends z.ZodType, K extends z.ZodType, S = AdapterSession> = {
  readonly name: string;
  readonly displayName?: string;
  readonly config: C;
  readonly credentials: K;
  readonly connect: (input: { config: z.output<C>; credentials: z.output<K>; host: HostContext }) => Promise<S>;
};
export type PolicyAdapterDefinition<
  C extends z.ZodType, K extends z.ZodType, P extends z.ZodType<Json>, S = AdapterSession,
> = Omit<AdapterDefinition<C, K, S>, "connect"> & {
  readonly policy: { readonly schema: P; readonly default: z.output<P> };
  readonly connect: (input: {
    config: z.output<C>; credentials: z.output<K>; host: HostContext<z.output<P>>;
  }) => Promise<S>;
  withPolicy(value: z.input<P>): PolicyAdapterDefinition<C, K, P, S>;
};
const ProviderName = z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
export function defineAdapter<
  C extends z.ZodType, K extends z.ZodType, P extends z.ZodType<Json>,
  Cmd extends Command["kind"], CT extends Json,
  CP = CreateInput, DP = Sandbox, EP = ExecInput, WP = FileWriteInput,
>(definition: Omit<PolicyAdapterDefinition<C, K, P, AdapterSession<CP, DP, EP, WP, Cmd, CT>>, "withPolicy">):
  PolicyAdapterDefinition<C, K, P, AdapterSession<CP, DP, EP, WP, Cmd, CT>>;
export function defineAdapter<
  C extends z.ZodType, K extends z.ZodType,
  Cmd extends Command["kind"], CT extends Json,
  CP = CreateInput, DP = Sandbox, EP = ExecInput, WP = FileWriteInput,
>(definition: AdapterDefinition<C, K, AdapterSession<CP, DP, EP, WP, Cmd, CT>>):
  AdapterDefinition<C, K, AdapterSession<CP, DP, EP, WP, Cmd, CT>>;
export function defineAdapter(definition: AdapterDefinition<z.ZodType, z.ZodType> & {
  policy?: { schema: z.ZodType; default: Json };
}) {
  ProviderName.parse(definition.name);
  if (!definition.policy) return Object.freeze(definition);
  const parsedDefault = parseBoundedSchema(definition.policy.schema, definition.policy.default, "host policy") as Json;
  const clone = (policy: Json) => Object.freeze({
    ...definition,
    policy: Object.freeze({ schema: definition.policy!.schema, default: policy }),
    withPolicy(value: Json) {
      return clone(parseBoundedSchema(definition.policy!.schema, value, "host policy") as Json);
    },
  });
  return clone(parsedDefault);
}
export function isOutcome(value: unknown): value is Pending | Unknown | Rejected {
  return typeof value === "object" && value !== null && outcomeBrand in value;
}
export function outcomeKind(value: Pending | Unknown | Rejected): "pending" | "unknown" | "rejected" {
  return value[outcomeBrand];
}
function boundedToken(value: unknown, schema: z.ZodType<Json>): Json {
  const token = parseBoundedSchema(schema, value, "recovery token");
  if (new TextEncoder().encode(JSON.stringify(token)).length > 4096)
    throw new AdapterError("INVALID_ARGUMENT", "Recovery token exceeds 4096 bytes");
  return token;
}
export function createAttemptContext(
  input: Pick<AttemptContext, "operationId" | "submissionId" | "invocationKey" | "signal">,
  tokenSchema?: z.ZodType<Json>,
): AttemptContext {
  return {
    ...input,
    pending: (token, options) => {
      if (!tokenSchema)
        throw new AdapterError("INVALID_ARGUMENT", "Pending requires a declared recovery token");
      const pollAfterMs = options?.pollAfterMs;
      if (pollAfterMs !== undefined && (!Number.isSafeInteger(pollAfterMs) || pollAfterMs < 0 || pollAfterMs > 86_400_000))
        throw new AdapterError("INVALID_ARGUMENT", "Invalid observation delay");
      return { [outcomeBrand]: "pending", token: boundedToken(token, tokenSchema), ...options };
    },
    reject: (code, message) => ({ [outcomeBrand]: "rejected", code, message }),
    unknown: (reason) => ({ [outcomeBrand]: "unknown", reason }),
  };
}
export function createObserveContext(input: ReadContext, tokenSchema?: z.ZodType<Json>): ObserveContext {
  const attempt = createAttemptContext(
    { operationId: "", submissionId: "", invocationKey: "", signal: input.signal },
    tokenSchema,
  );
  return { ...input, pending: attempt.pending, unknown: attempt.unknown };
}
export function operationParts<I, V, P, T extends Json, S extends Sandbox | undefined>(
  mutation: Mutation<I, V, P, T, S>,
): {
  prepare?: (input: I, ctx: ReadContext) => Promise<P>;
  submit: (input: P, ctx: AttemptContext<T>) => Promise<V | Pending | Unknown | Rejected>;
  observe?: (attempt: RecoveryAttempt<T, S>, ctx: ObserveContext<T>) => Promise<V | Pending | Unknown | null>;
  recovery?: { version: number; token: z.ZodType<T> };
} {
  if (typeof mutation === "function")
    return { submit: mutation as unknown as (input: P, ctx: AttemptContext<T>) => Promise<V | Pending | Unknown | Rejected> };
  return mutation;
}

const ScopeSchema = z.strictObject({
  authority: z.strictObject({
    kind: z.string().min(1).max(64),
    id: z.string().min(1).max(512),
  }),
  partition: z.record(z.string().min(1).max(64), z.string().max(2048)).refine(
    (value) => Object.keys(value).length <= 32,
    "Scope partition has too many fields",
  ),
});
const JsonSchema = z.json();
const MAX_CONFIG_BYTES = 65_536;

function boundedSchemaOutput(value: unknown, label: string): Json {
  const parsed = JsonSchema.safeParse(value);
  if (!parsed.success) throw new AdapterError("INVALID_ARGUMENT", `Invalid ${label}`);
  const encoded = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(encoded).length > MAX_CONFIG_BYTES)
    throw new AdapterError("INVALID_ARGUMENT", `${label} exceeds 65536 bytes`);
  return structuredClone(parsed.data);
}

function redactSchemaFailure(label: string, error: z.ZodError): AdapterError {
  const paths = error.issues.slice(0, 8).map((issue) => issue.path.join(".") || "(root)");
  return new AdapterError("INVALID_ARGUMENT", `Invalid ${label}: ${paths.join(", ")}`);
}

function parseBoundedSchema<S extends z.ZodType>(schema: S, value: unknown, label: string): z.output<S> {
  boundedSchemaOutput(value, label);
  let parsed;
  try {
    parsed = schema.safeParse(value);
  } catch {
    throw new AdapterError("INVALID_ARGUMENT", `Invalid ${label}`);
  }
  if (!parsed.success) throw redactSchemaFailure(label, parsed.error);
  boundedSchemaOutput(parsed.data, label);
  return structuredClone(parsed.data);
}

export type AdapterConnection<S> = {
  readonly session: S;
  readonly scope: Scope;
  readonly signal: AbortSignal;
  close(): Promise<void>;
};

export async function connectAdapter<C extends z.ZodType, K extends z.ZodType, S extends { scope: Scope }>(
  definition: Pick<AdapterDefinition<C, K, S>, "config" | "credentials"> & {
    connect: (input: never) => Promise<S>;
    policy?: { schema: z.ZodType; default: Json };
  },
  input: {
    config: z.input<C>;
    credentials: z.input<K>;
    onDiagnostic?: (error: unknown) => void;
  },
): Promise<AdapterConnection<S>> {
  const config = parseBoundedSchema(definition.config, input.config, "configuration");
  const credentials = parseBoundedSchema(definition.credentials, input.credentials, "credentials");
  const controller = new AbortController();
  const releases: (() => void | Promise<void>)[] = [];
  let closed: Promise<void> | undefined;
  const close = () => {
    if (!closed) {
      controller.abort();
      closed = (async () => {
        for (const release of releases.reverse()) {
          try {
            await release();
          } catch (error) {
            input.onDiagnostic?.(error);
          }
        }
      })();
    }
    return closed;
  };
  const host: HostContext = {
    signal: controller.signal,
    policy: Object.freeze(definition.policy
      ? parseBoundedSchema(definition.policy.schema, definition.policy.default, "host policy")
      : {}),
    onClose(release) {
      if (closed) throw new AdapterError("CONFLICT", "Connection is closed");
      releases.push(release);
    },
  };
  try {
    const session = await (definition.connect as (input: {
      config: z.output<C>; credentials: z.output<K>; host: HostContext;
    }) => Promise<S>)({ config, credentials, host });
    const scope = ScopeSchema.safeParse(session.scope);
    if (!scope.success) throw new AdapterError("INVALID_ARGUMENT", "Invalid verified scope");
    const detached = structuredClone(scope.data);
    Object.freeze(detached.authority);
    Object.freeze(detached.partition);
    Object.freeze(detached);
    return { session, scope: detached, signal: controller.signal, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export {
  prepareOperation,
  submitOperation,
  observeOperation,
} from "./runtime";
export type { OperationKind, PreparedOperation, RuntimeResult } from "./runtime";

export function validateAdapterConfiguration<C extends z.ZodType, K extends z.ZodType>(
  definition: Pick<AdapterDefinition<C, K>, "config" | "credentials">,
  input: { configuration: unknown; credentials: unknown },
): { configuration: z.output<C>; credentials: z.output<K> } {
  return {
    configuration: parseBoundedSchema(definition.config, input.configuration, "configuration"),
    credentials: parseBoundedSchema(definition.credentials, input.credentials, "credentials"),
  };
}
