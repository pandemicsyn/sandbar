import { z } from "zod";
import { NativeScope } from "@sandbar/provider-spi";
import { ModalProviderDriver } from "./driver";
import { createSdkTransport, MODAL_ENDPOINT, type ModalTransport } from "./transport";

const Options = z.strictObject({
  tokenId: z.string().min(1),
  tokenSecret: z.string().min(1),
  appName: z.string().min(1).max(128),
  environment: z.string().min(1).max(128),
  region: z.string().min(1).max(128).optional(),
  timeoutSeconds: z.number().int().min(60).max(3600).default(300),
  endpoint: z.literal(MODAL_ENDPOINT).optional(),
});

export type ModalProviderOptions = z.input<typeof Options>;

async function connectionId(appId: string, environment: string, region?: string): Promise<string> {
  const input = `${MODAL_ENDPOINT}\n${appId}\n${environment}\n${region ?? ""}`;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
  return `modal_${Array.from(hash, x => x.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Bind a Modal token to an existing deployed App. App lookup is read-only.
 * The SDK has no public authoritative workspace-ID reader, so this adapter
 * claims only the verified App, environment and fixed control endpoint.
 */
export async function modalProvider(options: ModalProviderOptions, injectedTransport?: ModalTransport): Promise<{ driver: ModalProviderDriver; scope: NativeScope; ownership: "owned"; release: () => void }> {
  const parsed = Options.parse(options);
  const transport = injectedTransport ?? createSdkTransport(parsed);
  try {
    const appId = await transport.lookupApp(parsed.appName, parsed.environment);
    if (!/^ap-[A-Za-z0-9_-]+$/.test(appId)) throw new Error("Modal app lookup returned an invalid native ID");
    const scope = NativeScope.parse({
      provider: "modal", connectionId: await connectionId(appId, parsed.environment, parsed.region),
      resourceScope: { kind: "app", id: appId },
      endpoint: MODAL_ENDPOINT, region: parsed.region,
    });
    const driver = new ModalProviderDriver(scope as NativeScope & { resourceScope: { kind: "app"; id: string } }, parsed.appName, parsed.environment, parsed.timeoutSeconds * 1000, transport);
    return { driver, scope, ownership: "owned", release: () => driver.close() };
  } catch (error) {
    transport.close();
    throw error;
  }
}

export { ModalProviderDriver } from "./driver";
export { MODAL_ENDPOINT, type ModalTransport } from "./transport";
