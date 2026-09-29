import { z } from "zod";

export const snapshotProbe = "snapshot-roundtrip-v2" as const;

export const volumeProbe = "volume-persistence-v1" as const;

export const snapshotEvidence = z.strictObject({
  probe: z.literal(snapshotProbe),
  preserve: z.enum(["filesystem", "filesystem+memory"]),
  captureMode: z.literal("native-default"),
  restoreExecution: z.enum(["fresh", "resume"]),
  sourceProcesses: z.enum(["continued", "ended"]),
  freshExecution: z.enum(["verified-missing-guest-process", "not-applicable"]),
  sourceState: z.enum(["running", "stopped"]),
  capturedBytes: z.literal(true),
  newIdentity: z.literal(true),
  metadataInspected: z.literal(true),
  restoredWriteIndependent: z.literal(true),
  sourceWriteIndependent: z.boolean(),
  secondRestoreOriginalBytes: z.literal(true),
  memory: z.enum(["verified-unix-socket-nonce-counter", "not-applicable"]),
  ownedArtifactDeleted: z.literal(true),
});

export const volumeEvidence = z.strictObject({
  probe: z.literal(volumeProbe),
  ownership: z.enum(["created", "borrowed"]),
  metadataInspected: z.literal(true),
  producerWriter: z.literal("finite-writer-closed"),
  shutdownDurability: z.literal("allow-unconfirmed-explicit"),
  computeDeletedVolumeRetained: z.literal(true),
  reopenedBytes: z.literal(true),
  readOnly: z.enum(["rejected-write-unchanged-bytes", "unsupported"]),
  storageCleanup: z.enum(["owned-deleted", "borrowed-retained"]),
});

export const stateEvidence = z.union([snapshotEvidence, volumeEvidence]);

export type StateEvidence = z.infer<typeof stateEvidence>;

export function assertStateEvidence(scenario: string, value: StateEvidence) {
  if (scenario === "snapshot-roundtrip") {
    const evidence = snapshotEvidence.parse(value);

    if (
      evidence.preserve === "filesystem+memory" &&
      (evidence.memory !== "verified-unix-socket-nonce-counter" ||
        !evidence.sourceWriteIndependent ||
        evidence.sourceState !== "running")
    )
      throw new Error(
        "Memory snapshot pass requires observable independent memory and source writes",
      );

    if (
      evidence.preserve === "filesystem" &&
      (evidence.memory !== "not-applicable" ||
        evidence.restoreExecution !== "fresh" ||
        evidence.freshExecution !== "verified-missing-guest-process" ||
        evidence.sourceProcesses !== "ended")
    )
      throw new Error("Filesystem capture requires fresh execution and cannot imply RAM");

    if (
      evidence.preserve === "filesystem+memory" &&
      (evidence.restoreExecution !== "resume" ||
        evidence.sourceProcesses !== "continued" ||
        evidence.freshExecution !== "not-applicable")
    )
      throw new Error("Memory capture requires resumed process execution");
  } else if (scenario === "volume-persistence") volumeEvidence.parse(value);
  else throw new Error("State evidence scenario differs");
}
