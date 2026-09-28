import { Sandbar, type AdapterRecoveryReference } from "sandbar-sdk";
import { e2b, createE2BAdapter, type E2BTransport } from "sandbar-sdk/e2b";
import { z } from "zod";

export const e2bConfiguration = z.strictObject({
  teamId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  templateId: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?(?::default)?$/)
    .default("base"),
  timeoutSeconds: z.literal(300).default(300),
});

export type E2BConfiguration = z.infer<typeof e2bConfiguration>;

/** Production uses the bound public factory; offline qualification uses its public native boundary. */
export function e2bConnection(
  configuration: E2BConfiguration,
  apiKey: string,
  transportFactory?: (options: { apiKey: string }) => E2BTransport,
) {
  const config = e2bConfiguration.parse(configuration);

  return (
    onReference: (reference: AdapterRecoveryReference) => Promise<void>,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The public SDK diagnostic callback receives external cleanup errors for field-only redaction.
    onDiagnostic?: (error: unknown) => void,
  ) =>
    transportFactory
      ? Sandbar.connect({
          adapter: createE2BAdapter(transportFactory),
          config,
          credentials: { apiKey },
          onReference,
          onDiagnostic,
        })
      : Sandbar.connect({
          adapter: e2b({ ...config, apiKey }),
          config: {},
          credentials: {},
          onReference,
          onDiagnostic,
        });
}

/** Owned-only read of the public sandbox-info endpoint used by pinned E2B Sandbox.getInfo. */
export function e2bEnvdVersion(
  apiKey: string,
  fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch,
) {
  return async (ownedSandboxId: string, signal?: AbortSignal): Promise<string | undefined> => {
    const response = await fetcher(
      `https://api.e2b.app/sandboxes/${encodeURIComponent(ownedSandboxId)}`,
      {
        headers: { "X-API-Key": apiKey, Accept: "application/json" },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      },
    );

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`E2B sandbox-info failed (HTTP ${response.status})`);
    }

    const info = z
      .object({
        envdVersion: z
          .string()
          .max(80)
          .regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/)
          .optional(),
      })
      .parse(await response.json());

    return info.envdVersion;
  };
}
