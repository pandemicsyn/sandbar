import { z } from "zod";
import { ResourceReference, SandboxInfoSchema } from "./state";

/** Provider-independent positive window; adapters resolve units before dispatch. */
export const RenewRequest = z.strictObject({ forSeconds: z.number().int().positive().safe() });

export type RenewRequest = z.infer<typeof RenewRequest>;

export const RenewInput = z.strictObject({
  sandbox: z.strictObject({
    id: z.string().min(1).max(512),
    reference: ResourceReference.extend({ kind: z.literal("sandbox") }),
  }),
  forSeconds: RenewRequest.shape.forSeconds.optional(),
});

export type RenewInput = z.infer<typeof RenewInput>;

export const ResolvedRenewInput = RenewInput.extend({ forSeconds: RenewRequest.shape.forSeconds });

export type ResolvedRenewInput = z.infer<typeof ResolvedRenewInput>;

export const RenewResult = z.strictObject({
  reference: ResourceReference.extend({ kind: z.literal("sandbox") }),
  requested: RenewRequest,
  acknowledged: z.literal(true),
  observation: SandboxInfoSchema.nullable(),
});

export type RenewResult = z.infer<typeof RenewResult>;

export const RenewLimits = z.strictObject({
  minSeconds: RenewRequest.shape.forSeconds,
  maxSeconds: RenewRequest.shape.forSeconds,
  stepSeconds: RenewRequest.shape.forSeconds,
  scope: z.enum(["sandbox", "running-session"]),
});

export type RenewLimits = z.infer<typeof RenewLimits>;

/** Resolved native intent saved before dispatch; ordinary callers choose this at setup. */
export const LifecycleIntent = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("suspend"),
    preserve: z.enum(["filesystem", "filesystem+memory"]),
  }),
  z.strictObject({
    action: z.literal("resume"),
    forSeconds: RenewRequest.shape.forSeconds.optional(),
  }),
]);

export type LifecycleIntent = z.infer<typeof LifecycleIntent>;

export const LifecycleInput = z.strictObject({ sandbox: RenewInput.shape.sandbox });

export type LifecycleInput = z.infer<typeof LifecycleInput>;

export const ResolvedLifecycleInput = LifecycleInput.extend({ intent: LifecycleIntent });

export type ResolvedLifecycleInput = z.infer<typeof ResolvedLifecycleInput>;

export const SuspendResult = z.strictObject({
  reference: RenewResult.shape.reference,
  preserve: z.enum(["filesystem", "filesystem+memory"]),
  processes: z.enum(["terminated", "preserved"]),
  connections: z.enum(["dropped", "preserved"]),
  observation: SandboxInfoSchema,
});

export type SuspendResult = z.infer<typeof SuspendResult>;

export const ResumeResult = z.strictObject({
  reference: RenewResult.shape.reference,
  execution: z.enum(["fresh", "resumed", "unknown"]),
  executionIdentity: SandboxInfoSchema.shape.execution,
  connections: z.enum(["dropped", "preserved", "unknown"]),
  observation: SandboxInfoSchema,
});

export type ResumeResult = z.infer<typeof ResumeResult>;
