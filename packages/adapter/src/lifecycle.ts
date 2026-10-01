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
