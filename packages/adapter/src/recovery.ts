import { z } from "zod";
import { ResourceReference, SandboxState, SnapshotCaptureValue } from "./state";

/** Historical, advisory facts. These never authorize dispatch or resource access. */
export const RecoveryFacts = z
  .strictObject({
    version: z.literal(1),
    retainedResources: z.array(ResourceReference).max(32),
    completed: z
      .array(
        z.strictObject({
          step: z.string().min(1).max(128),
          capture: SnapshotCaptureValue.shape.capture.optional(),
          restoreExecution: z.enum(["fresh", "resume"]).optional(),
        }),
      )
      .max(16),
    source: z
      .strictObject({
        state: SandboxState,
        observedAt: z.iso.datetime(),
        provenance: z.enum(["provider-read", "acknowledgement"]),
      })
      .optional(),
    steps: z
      .array(
        z.strictObject({
          step: z.string().min(1).max(128),
          status: z.enum(["pending", "uncertain", "failed", "completed"]),
          reason: z.string().min(1).max(1024).optional(),
        }),
      )
      .max(16),
    continuation: z.strictObject({
      supported: z.union([z.boolean(), z.literal("unknown")]).default("unknown"),
      status: z.enum(["eligible", "unavailable", "unknown"]),
      reason: z.string().min(1).max(1024),
    }),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 16384,
    "Recovery facts exceed 16384 bytes",
  );

export type RecoveryFacts = z.infer<typeof RecoveryFacts>;
