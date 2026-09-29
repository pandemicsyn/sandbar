import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AdapterError, type ResourceReference, type Scope } from "sandbar-adapter";

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
});

export type ResourceEvidence = z.infer<typeof Evidence>;

/** An authenticated receipt of acknowledged native facts, not a native generation. */
export function resourceReceipts(key: string, provider: string, scope: Scope) {
  const binding = JSON.stringify([
    provider,
    scope.authority.kind,
    scope.authority.id,
    Object.entries(scope.partition).sort(([a], [b]) => a.localeCompare(b)),
  ]);

  const sign = (payload: string) =>
    createHmac("sha256", key)
      .update("sandbar-resource-receipt-v1\0")
      .update(binding)
      .update("\0")
      .update(payload)
      .digest("base64url");

  return {
    issue(value: ResourceEvidence) {
      const payload = Buffer.from(JSON.stringify(Evidence.parse(value))).toString("base64url");

      return `${payload}.${sign(payload)}`;
    },
    read(reference: ResourceReference): ResourceEvidence | null {
      if (!reference.receipt) return null;
      const [payload, signature, ...extra] = reference.receipt.split(".");

      if (!payload || !signature || extra.length) return null;
      const expected = Buffer.from(sign(payload));
      const actual = Buffer.from(signature);

      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      let value;

      try {
        value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }

      const parsed = Evidence.safeParse(value);

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
          "Verified native creation receipt is required; names/ownership labels alone are not evidence",
        );
    },
  };
}
