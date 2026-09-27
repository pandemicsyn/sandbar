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

const Credentials = z.strictObject({ tokenId: z.string().min(1), tokenSecret: z.string().min(1) });

const Configuration = z.strictObject({
  appName: z.string().min(1).max(128),
  environment: z.string().min(1).max(128),
  region: z.string().min(1).max(128).optional(),
  timeoutSeconds: z
    .string()
    .regex(/^[1-9][0-9]{0,3}$/)
    .refine((value) => Number(value) >= 60 && Number(value) <= 3600)
    .optional(),
});

export type ModalProviderOptions = z.input<typeof Options>;

async function connectionId(appId: string, environment: string, region?: string): Promise<string> {
  const input = `${MODAL_ENDPOINT}\n${appId}\n${environment}\n${region ?? ""}`;

  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );

  return `modal_${Array.from(hash, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Bind a Modal token to an existing deployed App. App lookup is read-only.
 * The SDK has no public authoritative workspace-ID reader, so this adapter
 * claims only the verified App, environment and fixed control endpoint.
 */
async function connect(
  options: ModalProviderOptions,
  transportFactory?: () => ModalTransport,
  suppliedConnectionId?: string,
): Promise<{
  driver: ModalProviderDriver;
  scope: NativeScope;
  ownership: "owned";
  release: () => void;
}> {
  const parsed = Options.parse(options);
  const transport = transportFactory?.() ?? createSdkTransport(parsed);

  try {
    const appId = await transport.lookupApp(parsed.appName, parsed.environment);

    if (!/^ap-[A-Za-z0-9_-]+$/.test(appId))
      throw new Error("Modal app lookup returned an invalid native ID");

    const scope = NativeScope.parse({
      provider: "modal",
      connectionId:
        suppliedConnectionId ?? (await connectionId(appId, parsed.environment, parsed.region)),
      resourceScope: { kind: "app", id: appId },
      endpoint: MODAL_ENDPOINT,
      region: parsed.region,
    });

    const driver = new ModalProviderDriver(
      scope,
      parsed.appName,
      parsed.environment,
      parsed.timeoutSeconds * 1000,
      transport,
    );

    return { driver, scope, ownership: "owned", release: () => driver.close() };
  } catch (error) {
    transport.close();
    throw error;
  }
}

export async function modalProvider(
  options: ModalProviderOptions,
  injectedTransport?: ModalTransport,
) {
  return connect(options, injectedTransport ? () => injectedTransport : undefined);
}

/** Structural registry factory: the portable package does not import service-runtime. */
export function createModalRegistration(
  transportFactory?: (options: ModalProviderOptions) => ModalTransport,
) {
  const validate = (input: {
    credentials: Record<string, string>;
    configuration: Record<string, string>;
  }) => ({
    credentials: Credentials.parse(input.credentials),
    configuration: Configuration.parse(input.configuration),
  });

  return {
    provider: "modal" as const,
    catalog: {
      displayName: "Modal",
      configurationSchema: z.toJSONSchema(Configuration),
      credentialsSchema: z.toJSONSchema(Credentials),
    },
    validate,
    async connect(input: {
      connectionId: string;
      credentials: Record<string, string>;
      configuration: Record<string, string>;
    }) {
      const validated = validate(input);
      const { timeoutSeconds, ...configuration } = validated.configuration;

      const options: ModalProviderOptions = {
        ...validated.credentials,
        ...configuration,
      };

      if (timeoutSeconds !== undefined) options.timeoutSeconds = Number(timeoutSeconds);

      return connect(
        options,
        transportFactory ? () => transportFactory(options) : undefined,
        input.connectionId,
      );
    },
  };
}

export const modalRegistration = createModalRegistration();

export { ModalProviderDriver } from "./driver";

export { MODAL_ENDPOINT, type ModalTransport } from "./transport";
