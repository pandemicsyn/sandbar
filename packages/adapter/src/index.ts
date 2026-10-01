import { AdapterError } from "./errors";
import { OperationOutcome } from "./state";

export { AdapterError } from "./errors";

export { OperationOutcome } from "./state";

import type { SnapshotRequest, SnapshotProfile, Support, ResourceReference } from "./state";
import { z } from "zod";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Scope = {
  authority: { kind: string; id: string };
  partition: Readonly<Record<string, string>>;
};

export type Sandbox = {
  readonly id: string;
  readonly reference?: import("./state").SandboxReference;
};

export type RecoveryResource = Sandbox | ResourceReference;

export type Image = { kind: "prepared" | "oci"; value: string };

export type ImageBuildInput = { source: { kind: "oci"; value: string } };

export type RetainedArtifact = {
  kind: string;
  id: string;
  ownership: "verified" | "unknown";
  cleanup: "manual" | "provider_expiry" | "none_known";
};

export type ImageBuildValue = { preparedId: string; retainedResources: RetainedArtifact[] };

export * from "./resources";

export * from "./lifecycle";

export type CreateInput = {
  image: Image;
  networkPolicy: string;
  region?: string;
  labels?: Record<string, string>;
  requirements?: { snapshot: SnapshotRequest };
  mounts?: import("./resources").MountSpec[];
};

export type CreateValue = {
  id: string;
  reference?: import("./state").SandboxReference;
  state: "running" | "unknown";
  mounts?: import("./state").MountSpec[];
};

export type DestroyValue = {
  computeStopped: boolean;
  retainedResources: string[];
  mountDurability?: z.infer<typeof import("./resources").MountDurability>[];
};

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

/** Finite decoded text observation; detach never terminates compute. */
export type ProcessOutput = { stream: "stdout" | "stderr"; text: string };

export type NativeProcessExit = { exitCode: number };

export type ProcessObservationFailure = AdapterError & { confirmedExit?: NativeProcessExit };

export type ProcessStartContext = ReadContext & {
  onOutput(chunk: ProcessOutput): void;
};

export interface NativeProcess {
  /** Synchronous confirmed evidence, including during final decoder callbacks. */
  readonly confirmedExit?: NativeProcessExit;
  wait(): Promise<NativeProcessExit>;
  detach(): Promise<void>;
}

export type ProcessStartInput = {
  sandbox: Sandbox;
  command: Command;
  cwd?: string;
  env?: Record<string, string>;
  maxOutputBytes: number;
};

export type FileWriteInput = {
  sandbox: Sandbox;
  path: string;
  bytes: Uint8Array;
  overwrite: boolean;
};

export type FileWriteValue = { bytesWritten: number };

export type ReadContext = { readonly signal: AbortSignal; readonly deadline: number };

export type HostContext<P extends Json = Json> = {
  readonly signal: AbortSignal;
  readonly policy: Readonly<P>;
  onClose(release: () => void | Promise<void>): void;
};

const outcomeBrand: unique symbol = Symbol("sandbar.adapter.outcome");

export type Pending = {
  readonly [outcomeBrand]: "pending";
  readonly token: Json;
  readonly pollAfterMs?: number;
};

export type Unknown = {
  readonly [outcomeBrand]: "unknown";
  readonly reason: string;
  readonly outcome?: OperationOutcome;
};

export type Rejected = {
  readonly [outcomeBrand]: "rejected";
  readonly code: AdapterErrorCode;
  readonly message: string;
};

export type AdapterErrorCode =
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CAPACITY"
  | "RATE_LIMIT"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "INTERNAL";

const AdapterErrorCodeSchema = z.enum([
  "INVALID_ARGUMENT",
  "UNSUPPORTED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "CAPACITY",
  "RATE_LIMIT",
  "UNAVAILABLE",
  "TIMEOUT",
  "INTERNAL",
]);

const OutcomeTextSchema = z.string().max(1024);

/** Persistence failed; adapters must stop before dispatching another stage. */
export class AdapterCheckpointError extends Error {
  outcome?: OperationOutcome;
  constructor() {
    super("Operation reference persistence failed");
    this.name = "AdapterCheckpointError";
  }
}

export type AttemptContext<T extends Json = Json> = {
  readonly operationId: string;
  readonly submissionId: string;
  readonly invocationKey: string;
  readonly signal: AbortSignal;
  checkpoint(token: T): Promise<void>;
  pending(token: T, options?: { pollAfterMs?: number }): Pending;
  reject(code: AdapterErrorCode, message: string): Rejected;
  unknown(reason: string, outcome?: OperationOutcome): Unknown;
};

export type ObserveContext<T extends Json = Json> = ReadContext & {
  pending(token: T, options?: { pollAfterMs?: number }): Pending;
  unknown(reason: string, outcome?: OperationOutcome): Unknown;
};

export type RecoveryAttempt<
  T extends Json = Json,
  S extends RecoveryResource | undefined = Sandbox | undefined,
> = {
  readonly operationId: string;
  readonly submissionId: string;
  readonly sandbox: S;
  readonly resource?: ResourceReference;
  readonly mounts?: import("./state").MountSpec[];
  readonly lifecycle?: import("./lifecycle").LifecycleIntent;
  readonly renewal?: import("./lifecycle").RenewRequest;
  readonly capture?: import("./state").SnapshotCaptureInput["expectation"];
  readonly token?: T;
};

export type Mutation<
  I,
  V,
  P = I,
  T extends Json = Json,
  S extends RecoveryResource | undefined = Sandbox | undefined,
> =
  | (P extends I
      ? (input: P, ctx: AttemptContext<T>) => Promise<V | Pending | Unknown | Rejected>
      : never)
  | {
      recovery?: { version: number; token: z.ZodType<T> };
      continue?: (
        attempt: RecoveryAttempt<T, S>,
        ctx: AttemptContext<T>,
      ) => Promise<V | Pending | Unknown | Rejected>;
      prepare?: (input: I, ctx: ReadContext) => Promise<P>;
      submit: (input: P, ctx: AttemptContext<T>) => Promise<V | Pending | Unknown | Rejected>;
      observe?: (
        attempt: RecoveryAttempt<T, S>,
        ctx: ObserveContext<T>,
      ) => Promise<V | Pending | Unknown | null>;
    };

/** Lifecycle preparation resolves setup defaults before the SDK saves the dispatch intent. */
type LifecycleMutation<V> = Extract<
  Mutation<import("./lifecycle").LifecycleInput, V, import("./lifecycle").ResolvedLifecycleInput>,
  { submit: unknown }
> & {
  prepare: (
    input: import("./lifecycle").LifecycleInput,
    ctx: ReadContext,
  ) => Promise<import("./lifecycle").ResolvedLifecycleInput>;
};

export type Guarantees<C extends Command["kind"] = Command["kind"]> = {
  images: readonly ("prepared" | "oci")[];
  network: readonly string[];
  exec?: { commands: readonly C[]; maxOutputBytes: number };
  fileWrite?: { overwrite: boolean; noClobber: boolean };
};

export type AdapterSession<
  CP = CreateInput,
  DP = Sandbox,
  EP = ExecInput,
  WP = FileWriteInput,
  C extends Command["kind"] = Command["kind"],
  CT extends Json = Json,
> = {
  scope: Scope;
  /** Read-only evidence, scoped to the checked class or sandbox. Never allocate probe resources. */
  snapshotProfiles?: (
    target: { sandbox?: Sandbox; create?: CreateInput },
    ctx: ReadContext,
  ) => Promise<Support<{ profiles: SnapshotProfile[]; defaultProfileId: string }>>;
  suspend?: LifecycleMutation<import("./lifecycle").SuspendResult>;
  resume?: LifecycleMutation<import("./lifecycle").ResumeResult>;
  suspensionCapabilities?: (
    target: { sandbox?: Sandbox },
    ctx: ReadContext,
  ) => Promise<
    Support<{
      preserve: "filesystem" | "filesystem+memory";
      processes: "terminated" | "preserved";
      connections: "dropped";
    }>
  >;
  resumeCapabilities?: (
    target: { sandbox?: Sandbox },
    ctx: ReadContext,
  ) => Promise<
    Support<{ sourceStates: import("./state").SandboxState[]; setsSessionTimeout: boolean }>
  >;
  renew?: Mutation<
    import("./lifecycle").RenewInput,
    import("./lifecycle").RenewResult,
    import("./lifecycle").ResolvedRenewInput
  >;
  renewCapabilities?: (
    target: { sandbox?: Sandbox },
    ctx: ReadContext,
  ) => Promise<Support<import("./lifecycle").RenewLimits>>;
  snapshotCapture?: Mutation<
    import("./resources").SnapshotCaptureInput,
    import("./resources").SnapshotCaptureValue
  >;
  snapshotRestore?: Mutation<import("./resources").SnapshotRestoreInput, CreateValue>;
  snapshotDelete?: Mutation<ResourceReference, import("./resources").ArtifactDeletionResult>;
  snapshotInspect?: (
    ref: ResourceReference,
    ctx: ReadContext,
  ) => Promise<import("./resources").SnapshotInfo>;
  /** Inventory coverage established by this adapter; omit when unknown. */
  snapshotListCoverage?: "provider-scope" | "sandbar-managed";
  snapshotList?: (
    input: import("./resources").InventoryInput,
    ctx: ReadContext,
  ) => Promise<{
    items: import("./resources").SnapshotInfo[];
    nextCursor?: string;
    coverage: "provider-scope" | "sandbar-managed";
  }>;
  volumeCreate?: Mutation<
    import("./resources").VolumeCreateInput,
    import("./resources").VolumeInfo
  >;
  volumeDelete?: Mutation<ResourceReference, import("./resources").ArtifactDeletionResult>;
  volumeInspect?: (
    ref: ResourceReference,
    ctx: ReadContext,
  ) => Promise<import("./resources").VolumeInfo>;
  volumeList?: (
    input: import("./resources").InventoryInput,
    ctx: ReadContext,
  ) => Promise<{
    items: import("./resources").VolumeInfo[];
    nextCursor?: string;
    coverage: "provider-scope" | "sandbar-managed";
  }>;
  resourceCapabilities?: (
    target: { sandbox?: Sandbox; create?: CreateInput },
    ctx: ReadContext,
  ) => Promise<{
    restore: Support<import("./resources").RestoreCapabilities>;
    volumes: Support<import("./resources").VolumeCapabilities>;
    mounts: Support<import("./resources").MountCapabilities>;
  }>;
  checkMounts?: (input: CreateInput, ctx: ReadContext) => Promise<Support<{}>>;

  supports: Guarantees<C>;
  create: Mutation<CreateInput, CreateValue, CP, CT, undefined>;
  imageBuild?: Mutation<ImageBuildInput, ImageBuildValue, ImageBuildInput, Json, undefined>;
  destroy: Mutation<import("./resources").DestroyInput, DestroyValue, DP, Json, Sandbox>;
  reopen?: (
    reference: import("./state").SandboxReference,
    ctx: ReadContext,
  ) => Promise<import("./state").SandboxInfo>;
  inspect?: (
    box: Sandbox,
    ctx: ReadContext,
  ) => Promise<
    | ({ id: string; state: import("./state").SandboxState } & Partial<
        import("./state").SandboxInfo
      >)
    | null
  >;
  exec?: Mutation<ExecInput, ExecValue, EP, Json, Sandbox>;
  processes?: { start(input: ProcessStartInput, ctx: ProcessStartContext): Promise<NativeProcess> };
  files?: {
    maxBytes: number;
    read?: (
      input: { sandbox: Sandbox; path: string },
      ctx: ReadContext,
    ) => Promise<Uint8Array | ReadableStream<Uint8Array>>;
    write?: Mutation<FileWriteInput, FileWriteValue, WP, Json, Sandbox>;
  };
  inventory?: (
    input: { cursor?: string; limit: number },
    ctx: ReadContext,
  ) => Promise<{
    items: { id: string; state: "running" | "destroyed" | "unknown" }[];
    nextCursor?: string;
  }>;
};

export type AdapterDefinition<C extends z.ZodType, K extends z.ZodType, S = AdapterSession> = {
  readonly name: string;
  readonly displayName?: string;
  readonly config: C;
  readonly credentials: K;
  readonly connect: (input: {
    config: z.output<C>;
    credentials: z.output<K>;
    host: HostContext;
  }) => Promise<S>;
};

export type PolicyAdapterDefinition<
  C extends z.ZodType,
  K extends z.ZodType,
  P extends z.ZodType<Json>,
  S = AdapterSession,
> = Omit<AdapterDefinition<C, K, S>, "connect"> & {
  readonly policy: { readonly schema: P; readonly default: z.output<P> };
  readonly connect: (input: {
    config: z.output<C>;
    credentials: z.output<K>;
    host: HostContext<z.output<P>>;
  }) => Promise<S>;
  withPolicy(value: z.input<P>): PolicyAdapterDefinition<C, K, P, S>;
};

const ProviderName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);

export function defineAdapter<
  C extends z.ZodType,
  K extends z.ZodType,
  P extends z.ZodType<Json>,
  Cmd extends Command["kind"],
  CT extends Json,
  CP = CreateInput,
  DP = Sandbox,
  EP = ExecInput,
  WP = FileWriteInput,
>(
  definition: Omit<
    PolicyAdapterDefinition<C, K, P, AdapterSession<CP, DP, EP, WP, Cmd, CT>>,
    "withPolicy"
  >,
): PolicyAdapterDefinition<C, K, P, AdapterSession<CP, DP, EP, WP, Cmd, CT>>;
export function defineAdapter<
  C extends z.ZodType,
  K extends z.ZodType,
  Cmd extends Command["kind"],
  CT extends Json,
  CP = CreateInput,
  DP = Sandbox,
  EP = ExecInput,
  WP = FileWriteInput,
>(
  definition: AdapterDefinition<C, K, AdapterSession<CP, DP, EP, WP, Cmd, CT>>,
): AdapterDefinition<C, K, AdapterSession<CP, DP, EP, WP, Cmd, CT>>;
export function defineAdapter(
  definition: AdapterDefinition<z.ZodType, z.ZodType> & {
    policy?: { schema: z.ZodType; default: Json };
  },
) {
  ProviderName.parse(definition.name);

  if (!definition.policy) return Object.freeze(definition);

  // SAFETY: parseBoundedSchema validates the default with the declared schema and a JSON bound.
  const parsedDefault = parseBoundedSchema(
    definition.policy.schema,
    definition.policy.default,
    "host policy",
  ) as Json;

  const clone = (policy: Json) =>
    Object.freeze({
      ...definition,
      policy: Object.freeze({ schema: definition.policy!.schema, default: policy }),
      withPolicy(value: Json) {
        // SAFETY: parseBoundedSchema validates the replacement policy with the declared schema and a JSON bound.
        return clone(parseBoundedSchema(definition.policy!.schema, value, "host policy") as Json);
      },
    });

  return clone(parsedDefault);
}

export function isOutcome(value: unknown): value is Pending | Unknown | Rejected {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- A provider result is untrusted until its private outcome brand is checked.
  return typeof value === "object" && value !== null && outcomeBrand in value;
}

export function outcomeKind(
  value: Pending | Unknown | Rejected,
): "pending" | "unknown" | "rejected" {
  return value[outcomeBrand];
}

function boundedToken(value: Json, schema: z.ZodType<Json>): Json {
  const token = parseBoundedSchema(schema, value, "recovery token");

  if (new TextEncoder().encode(JSON.stringify(token)).length > 4096)
    throw new AdapterError("INVALID_ARGUMENT", "Recovery token exceeds 4096 bytes");

  return token;
}

export function createAttemptContext(
  input: Pick<AttemptContext, "operationId" | "submissionId" | "invocationKey" | "signal"> & {
    onCheckpoint?: (token: Json) => Promise<void>;
  },
  tokenSchema?: z.ZodType<Json>,
): AttemptContext {
  return {
    operationId: input.operationId,
    submissionId: input.submissionId,
    invocationKey: input.invocationKey,
    signal: input.signal,
    checkpoint: async (token) => {
      try {
        if (!tokenSchema)
          throw new AdapterError("INVALID_ARGUMENT", "Checkpoint requires declared recovery");
        const checked = boundedToken(token, tokenSchema);
        await input.onCheckpoint?.(structuredClone(checked));
      } catch {
        throw new AdapterCheckpointError();
      }
    },
    pending: (token, options) => {
      if (!tokenSchema)
        throw new AdapterError("INVALID_ARGUMENT", "Pending requires a declared recovery token");
      const pollAfterMs = options?.pollAfterMs;

      if (
        pollAfterMs !== undefined &&
        (!Number.isSafeInteger(pollAfterMs) || pollAfterMs < 0 || pollAfterMs > 86_400_000)
      )
        throw new AdapterError("INVALID_ARGUMENT", "Invalid observation delay");

      const checkedToken = boundedToken(token, tokenSchema);

      if (pollAfterMs === undefined) return { [outcomeBrand]: "pending", token: checkedToken };

      return { [outcomeBrand]: "pending", token: checkedToken, pollAfterMs };
    },
    reject: (code, message) => {
      const checkedCode = AdapterErrorCodeSchema.safeParse(code);
      const checkedMessage = OutcomeTextSchema.safeParse(message);

      if (!checkedCode.success || !checkedMessage.success)
        throw new AdapterError("INVALID_ARGUMENT", "Invalid rejection outcome");

      return { [outcomeBrand]: "rejected", code: checkedCode.data, message: checkedMessage.data };
    },
    unknown: (reason, outcome) => {
      const checkedReason = OutcomeTextSchema.safeParse(reason);

      if (!checkedReason.success)
        throw new AdapterError("INVALID_ARGUMENT", "Invalid unknown outcome");

      const checkedOutcome =
        outcome === undefined ? undefined : OperationOutcome.safeParse(outcome);

      if (checkedOutcome && !checkedOutcome.success)
        throw new AdapterError("INVALID_ARGUMENT", "Invalid operation outcome");

      return {
        [outcomeBrand]: "unknown",
        reason: checkedReason.data,
        outcome: checkedOutcome?.data,
      };
    },
  };
}

export function createObserveContext(
  input: ReadContext,
  tokenSchema?: z.ZodType<Json>,
): ObserveContext {
  const attempt = createAttemptContext(
    { operationId: "", submissionId: "", invocationKey: "", signal: input.signal },
    tokenSchema,
  );

  return { ...input, pending: attempt.pending, unknown: attempt.unknown };
}

export type OperationParts<I, V, P, T extends Json, S extends RecoveryResource | undefined> = {
  prepare?: (input: I, ctx: ReadContext) => Promise<P>;
  submit: (input: P, ctx: AttemptContext<T>) => Promise<V | Pending | Unknown | Rejected>;
  observe?: (
    attempt: RecoveryAttempt<T, S>,
    ctx: ObserveContext<T>,
  ) => Promise<V | Pending | Unknown | null>;
  continue?: (
    attempt: RecoveryAttempt<T, S>,
    ctx: AttemptContext<T>,
  ) => Promise<V | Pending | Unknown | Rejected>;
  recovery?: { version: number; token: z.ZodType<T> };
};

export function operationParts<I, V, P, T extends Json, S extends RecoveryResource | undefined>(
  mutation: Mutation<I, V, P, T, S>,
): OperationParts<I, V, P, T, S> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Mutation is the declared function-or-object union; this selects its function branch.
  if (typeof mutation === "function")
    return {
      submit: mutation,
    };

  return mutation;
}

const ScopeSchema = z.strictObject({
  authority: z.strictObject({
    kind: z.string().min(1).max(64),
    id: z.string().min(1).max(512),
  }),
  partition: z
    .record(z.string().min(1).max(64), z.string().max(2048))
    .refine((value) => Object.keys(value).length <= 32, "Scope partition has too many fields"),
});

const JsonSchema = z.json();

const MAX_CONFIG_BYTES = 65_536;

function freezeJson<T extends Json>(value: T): Readonly<T> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON values contain primitives and containers; only containers need recursive freezing.
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }

  return value;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the untrusted configuration boundary; JsonSchema.safeParse validates it below.
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

function parseBoundedSchema<S extends z.ZodType>(
  schema: S,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- External adapter config and credentials are checked by schema.safeParse below.
  value: unknown,
  label: string,
): z.output<S> {
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

export async function connectAdapter<
  C extends z.ZodType,
  K extends z.ZodType,
  S extends { scope: Scope },
>(
  definition: Pick<AdapterDefinition<C, K, S>, "config" | "credentials"> & {
    connect: (input: never) => Promise<S>;
    policy?: { schema: z.ZodType; default: Json };
  },
  input: {
    config: z.input<C>;
    credentials: z.input<K>;
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Cleanup callbacks may throw any JavaScript value; diagnostics preserve that value.
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

  // SAFETY: The declared policy schema has parsed and bounded the host policy default.
  const policy = definition.policy
    ? (parseBoundedSchema(
        definition.policy.schema,
        definition.policy.default,
        "host policy",
      ) as Json)
    : {};

  const host: HostContext = {
    signal: controller.signal,
    policy: freezeJson(policy),
    onClose(release) {
      if (closed) throw new AdapterError("CONFLICT", "Connection is closed");
      releases.push(release);
    },
  };

  try {
    const session =
      await // SAFETY: connect accepts never only to store heterogeneous adapter definitions; config and credentials were parsed with this definition's schemas above.
      (
        definition.connect as (input: {
          config: z.output<C>;
          credentials: z.output<K>;
          host: HostContext;
        }) => Promise<S>
      )({ config, credentials, host });

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

export { prepareOperation, submitOperation, observeOperation, continueOperation } from "./runtime";

export type {
  OperationKind,
  OperationInput,
  PreparedOperation,
  RuntimeResult,
  RuntimeSession,
} from "./runtime";

export function validateAdapterConfiguration<C extends z.ZodType, K extends z.ZodType>(
  definition: Pick<AdapterDefinition<C, K>, "config" | "credentials">,
  input: { configuration: unknown; credentials: unknown },
) {
  return {
    configuration: parseBoundedSchema(definition.config, input.configuration, "configuration"),
    credentials: parseBoundedSchema(definition.credentials, input.credentials, "credentials"),
  };
}

export { ExecCommand, ExecRequest, CreateSandboxInput, SafeError } from "./portable";

export * from "./state";
