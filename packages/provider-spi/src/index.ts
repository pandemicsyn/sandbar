import { z } from "zod";
import { ExecCommand, Effect, Id } from "@sandbar/contracts";

export const NativeScope = z.object({
  provider: z.string().min(1),
  connectionId: Id,
  accountId: z.string().min(1),
  region: z.string().optional(),
});

export const NativeRef = z.object({
  scope: NativeScope,
  nativeId: z.string().min(1),
  kind: z.enum(["sandbox", "execution"]),
});

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
  ref: NativeRef,
  state: z.enum(["running", "destroyed", "unknown"]),
  observedAt: z.iso.datetime({ offset: true }),
  sourceSequence: z.number().int().nonnegative().optional(),
});

export const ExecutionObservation = z.object({
  ref: NativeRef,
  sandbox: NativeRef,
  completed: z.boolean(),
  exitCode: z.number().int().nullable().optional(),
  stdoutBase64: z.base64().optional(),
  stderrBase64: z.base64().optional(),
  truncated: z.boolean().optional(),
  observedAt: z.iso.datetime({ offset: true }),
});

export const DestroyObservation = z.object({
  sandbox: NativeRef,
  computeStopped: z.boolean(),
  retainedResources: z.array(z.string()),
});

export const FileWriteObservation = z.object({
  sandbox: NativeRef,
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

export type InvocationIdentity = z.infer<typeof InvocationIdentity>;

export type DriverCapabilities = z.infer<typeof DriverCapabilities>;

export type DriverResult = z.infer<typeof DriverResult>;

export type SandboxObservation = z.infer<typeof SandboxObservation>;

export class ProviderReadError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_RESPONSE",
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
  inspect(ref: NativeRef): Promise<SandboxObservation | null>;
  inventory(input: {
    scope: NativeScope;
    cursor?: string;
    limit: number;
  }): Promise<{ items: SandboxObservation[]; nextCursor?: string }>;
  exec(input: {
    sandbox: NativeRef;
    identity: InvocationIdentity;
    command: z.infer<typeof ExecCommand>;
    cwd?: string;
    env?: Record<string, string>;
    deadlineSeconds: number;
    maxOutputBytes: number;
  }): Promise<DriverResult>;
  readFile(input: { sandbox: NativeRef; path: string }): Promise<Uint8Array>;
  writeFile(input: {
    sandbox: NativeRef;
    identity: InvocationIdentity;
    path: string;
    bytes: Uint8Array;
    overwrite: boolean;
  }): Promise<DriverResult>;
  destroy(input: { sandbox: NativeRef; identity: InvocationIdentity }): Promise<DriverResult>;
  // Observe must not submit a mutation. Null means no evidence, never proof of no effect.
  observe(input: { scope: NativeScope; submissionId: string }): Promise<DriverResult | null>;
}

export function validateDriverResult(value: DriverResult): DriverResult {
  return DriverResult.parse(value);
}
