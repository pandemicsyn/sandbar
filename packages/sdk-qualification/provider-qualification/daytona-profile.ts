import { Image, Sandbar, type AdapterRecoveryReference } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";
import { z } from "zod";

export const daytonaConfiguration = z.strictObject({
  target: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  snapshotId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  ttlMinutes: z.union([z.literal(10), z.literal(15)]).default(15),
  restartAfterCapture: z.boolean().optional(),
  networkPolicy: z.enum(["blocked", "daytona-default"]).default("blocked"),
});

export type DaytonaConfiguration = z.infer<typeof daytonaConfiguration>;

/** Borrowed prepared snapshot only; the shipped factory enforces native lifetime and scope. */
export function daytonaConnection(configuration: DaytonaConfiguration, apiKey: string) {
  const config = daytonaConfiguration.parse(configuration);

  return (
    onReference: (reference: AdapterRecoveryReference) => Promise<void>,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public SDK cleanup errors enter the field-only diagnostic redactor.
    onDiagnostic?: (error: unknown) => void,
  ) =>
    Sandbar.connect({
      adapter: daytona({
        apiKey,
        target: config.target,
        environment: Image.prepared(config.snapshotId),
        ttlMinutes: config.ttlMinutes,
        snapshots: { restartAfterCapture: config.restartAfterCapture ?? true },
        networkPolicy: config.networkPolicy,
      }),
      config: {},
      credentials: {},
      onReference,
      onDiagnostic,
    });
}
