import { z } from "zod";
import { AdapterError, type ResourceReference } from "sandbar-adapter";

const Evidence = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["snapshot", "volume"]),
  nativeId: z.string().min(1).max(512),
  generation: z.string().max(512).optional(),
  sourceId: z.string().max(512).optional(),
  preserve: z.enum(["filesystem", "filesystem+memory"]).optional(),
  sourceClass: z.string().max(128).optional(),
  consistency: z.enum(["crash-consistent", "caller-quiesced", "unknown"]).optional(),
  mounts: z.literal("none").optional(),
  name: z.string().max(128).optional(),
  deletion: z
    .strictObject({
      templateId: z.string().max(128),
      builds: z.array(z.string().max(128)).max(100),
      names: z.array(z.string().max(256)).max(100),
      public: z.boolean(),
    })
    .optional(),
});

export type ResourceEvidence = z.infer<typeof Evidence>;

/** Application-retained history; native scope and identity are checked separately on every use. */
export function resourceHistory() {
  return {
    issue(value: ResourceEvidence) {
      return { ...Evidence.parse(value), provenance: "application-retained" as const };
    },
    read(reference: ResourceReference): ResourceEvidence | null {
      const parsed = Evidence.extend({ provenance: z.literal("application-retained") }).safeParse(
        reference.history,
      );

      if (
        !parsed.success ||
        parsed.data.nativeId !== reference.nativeId ||
        parsed.data.kind !== reference.kind ||
        parsed.data.generation !== reference.generation
      )
        return null;

      return parsed.data;
    },
    owned(reference: ResourceReference) {
      if (reference.ownership !== "verified-created" || !this.read(reference))
        throw new AdapterError(
          "CONFLICT",
          "Correlated creation history is missing or inconsistent",
        );
    },
  };
}
