import { z } from "zod";
import { ExecCommand, Effect, Id } from "@sandbar/contracts";

export const NativeScope = z
  .object({
    provider: z.string().min(1),
    connectionId: Id,
    accountId: z.string().min(1).optional(),
    resourceScope: z.object({ kind: z.literal("app"), id: z.string().min(1) }).optional(),
    region: z.string().optional(),
    endpoint: z.url().optional(),
    adapterScope: z.strictObject({
      authority: z.strictObject({ kind: z.string().min(1).max(64), id: z.string().min(1).max(512) }),
      partition: z.record(z.string().min(1).max(64), z.string().max(2048)),
    }).optional(),
  })
  .refine(
    (value) => !!value.accountId !== !!value.resourceScope,
    "Exactly one verified native scope is required",
  );

export const NativeRef = z.object({
  scope: NativeScope,
  nativeId: z.string().min(1),
  kind: z.enum(["sandbox", "execution"]),
});

export const SandboxRef = NativeRef.extend({ kind: z.literal("sandbox") });

const ExecutionRef = NativeRef.extend({ kind: z.literal("execution") });

const sameScope = (left: z.infer<typeof NativeScope>, right: z.infer<typeof NativeScope>) =>
  left.provider === right.provider &&
  left.connectionId === right.connectionId &&
  left.accountId === right.accountId &&
  left.resourceScope?.kind === right.resourceScope?.kind &&
  left.resourceScope?.id === right.resourceScope?.id &&
  left.region === right.region &&
  left.endpoint === right.endpoint &&
  JSON.stringify(left.adapterScope) === JSON.stringify(right.adapterScope);

export const InvocationIdentity = z.object({
  projectId: Id,
  operationId: Id,
  invocationKey: z.string().min(1),
  // Stable key persisted before provider IO. The driver must never invent it per attempt.
  submissionId: Id,
});

export const DriverError = z.object({
  code: z.enum([
    "invalid",
    "unsupported",
    "unauthorized",
    "not_found",
    "conflict",
    "capacity",
    "rate_limit",
    "unavailable",
    "timeout",
    "internal",
  ]),
  message: z.string().max(1024),
  effect: Effect,
  retry: z.enum(["never", "safe_same_invocation", "observe_only", "new_invocation_with_risk"]),
});

export const DriverCapabilities = z.object({
  provider: z.string(),
  nativeIdempotency: z.object({
    create: z.boolean(),
    exec: z.boolean(),
    destroy: z.boolean(),
    writeFile: z.boolean(),
  }),
  discoveryBySubmission: z.boolean(),
  supports: z.object({
    argv: z.boolean(),
    shell: z.boolean(),
    fileBytes: z.boolean(),
    inventory: z.boolean(),
  }),
  maxFileBytes: z.number().int().nonnegative(),
  maxOutputBytes: z.number().int().nonnegative(),
  networkPolicies: z.array(z.string()),
});

export const SandboxObservation = z.object({
  ref: SandboxRef,
  state: z.enum(["running", "destroyed", "unknown"]),
  observedAt: z.iso.datetime({ offset: true }),
  sourceSequence: z.number().int().nonnegative().optional(),
});

export const ExecutionObservation = z
  .object({
    ref: ExecutionRef,
    sandbox: SandboxRef,
    completed: z.boolean(),
    exitCode: z.number().int().nullable().optional(),
    stdoutBase64: z.base64().optional(),
    stderrBase64: z.base64().optional(),
    truncated: z.boolean().optional(),
    observedAt: z.iso.datetime({ offset: true }),
  })
  .refine((observation) => sameScope(observation.ref.scope, observation.sandbox.scope), {
    message: "Execution and sandbox references must share a native scope",
  });

export const DestroyObservation = z.object({
  sandbox: SandboxRef,
  computeStopped: z.boolean(),
  retainedResources: z.array(z.string()),
});

export const FileWriteObservation = z.object({
  sandbox: SandboxRef,
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  complete: z.boolean(),
});

export const DriverValue = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sandbox"), observation: SandboxObservation }),
  z.object({ kind: z.literal("execution"), observation: ExecutionObservation }),
  z.object({ kind: z.literal("destroy"), observation: DestroyObservation }),
  z.object({ kind: z.literal("file_write"), observation: FileWriteObservation }),
]);

export const DriverResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    effect: z.enum(["applied", "partial"]),
    value: DriverValue,
    // Required by observe() responses so a completed effect can be tied to its submission.
    submissionId: Id.optional(),
  }),
  z.object({
    status: z.literal("pending"),
    effect: z.literal("possible"),
    submissionId: Id,
    observeAfterMs: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("unknown"),
    effect: z.enum(["possible", "unknown"]),
    submissionId: Id,
    reason: z.string().max(512),
  }),
  z.object({
    status: z.literal("rejected"),
    effect: z.literal("none"),
    error: DriverError.extend({ effect: z.literal("none") }),
  }),
]);

export type NativeScope = z.infer<typeof NativeScope>;

export type NativeRef = z.infer<typeof NativeRef>;

export type SandboxRef = z.infer<typeof SandboxRef>;

export type InvocationIdentity = z.infer<typeof InvocationIdentity>;

export type DriverCapabilities = z.infer<typeof DriverCapabilities>;

export type DriverResult = z.infer<typeof DriverResult>;

export type SandboxObservation = z.infer<typeof SandboxObservation>;

export class ProviderReadError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_RESPONSE" | "UNAUTHENTICATED",
    message: string,
  ) {
    super(message);
    this.name = "ProviderReadError";
  }
}

export interface ProviderDriver {
  readonly name: string;
  capabilities(scope: NativeScope): Promise<DriverCapabilities>;
  prepare(input: {
    scope: NativeScope;
    image: { kind: "prepared" | "oci"; value: string };
    networkPolicy: string;
    region?: string;
  }): Promise<{ supported: boolean; reason?: string; effectiveImage?: string }>;
  create(input: {
    scope: NativeScope;
    identity: InvocationIdentity;
    image: string;
    networkPolicy: string;
    labels?: Record<string, string>;
  }): Promise<DriverResult>;
  inspect(ref: SandboxRef): Promise<SandboxObservation | null>;
  inventory(input: {
    scope: NativeScope;
    cursor?: string;
    limit: number;
  }): Promise<{ items: SandboxObservation[]; nextCursor?: string }>;
  exec(input: {
    sandbox: SandboxRef;
    identity: InvocationIdentity;
    command: z.infer<typeof ExecCommand>;
    cwd?: string;
    env?: Record<string, string>;
    deadlineSeconds: number;
    maxOutputBytes: number;
  }): Promise<DriverResult>;
  readFile(input: { sandbox: SandboxRef; path: string }): Promise<Uint8Array>;
  writeFile(input: {
    sandbox: SandboxRef;
    identity: InvocationIdentity;
    path: string;
    bytes: Uint8Array;
    overwrite: boolean;
  }): Promise<DriverResult>;
  destroy(input: { sandbox: SandboxRef; identity: InvocationIdentity }): Promise<DriverResult>;
  // Observe must not submit a mutation. Null means no evidence, never proof of no effect.
  observe(input: {
    scope: NativeScope;
    submissionId: string;
    operationId?: string;
  }): Promise<DriverResult | null>;
}

/** Releasing an owned transport never destroys provider compute. */
export type ProviderLease = { driver: ProviderDriver; scope: NativeScope } & (
  | { ownership: "owned"; release: () => void | Promise<void> }
  | { ownership?: "borrowed"; release?: never }
);

export function validateDriverResult(value: DriverResult): DriverResult {
  return DriverResult.parse(value);
}
