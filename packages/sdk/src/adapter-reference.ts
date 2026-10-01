import { z } from "zod";
import { ResourceReference, MountSpec, SnapshotProfile, SandboxState } from "sandbar-adapter";

export const CaptureExpectation = z.strictObject({
  profile: SnapshotProfile,
  sourceState: SandboxState,
});

export const ReferenceSchema = z.strictObject({
  version: z.literal(2),
  mode: z.literal("direct"),
  provider: z.string().min(1).max(128),
  kind: z.enum([
    "create",
    "destroy",
    "exec",
    "file_write",
    "image_build",
    "snapshot_capture",
    "snapshot_restore",
    "snapshot_delete",
    "volume_create",
    "volume_delete",
  ]),
  scope: z.strictObject({
    authority: z.strictObject({ kind: z.string().min(1).max(64), id: z.string().min(1).max(512) }),
    partition: z.record(z.string().min(1).max(64), z.string().max(2048)),
  }),
  operationId: z.string().min(1).max(128),
  submissionId: z.string().min(1).max(128),
  invocationKey: z.string().min(1).max(128),
  sandboxId: z.string().min(1).max(512).optional(),
  sandboxReference: ResourceReference.extend({ kind: z.literal("sandbox") }).optional(),
  capture: CaptureExpectation.optional(),
  resource: ResourceReference.optional(),
  mounts: z.array(MountSpec).max(32).optional(),
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
