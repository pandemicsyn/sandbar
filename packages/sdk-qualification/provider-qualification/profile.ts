import { z } from "zod";
import { pathToFileURL } from "node:url";
import { supportMetadataSchema, type SupportMetadata } from "./support";
import type { ConnectionFactory } from "./connection";
import type { QualificationRecord } from "./report";

export const providerId = z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/);

const routingSchema = z.record(
  z.string().max(80),
  z.union([z.string().max(512), z.number().finite(), z.boolean()]),
);

export type Routing = z.infer<typeof routingSchema>;

export type ProviderProfile = {
  id: string;
  nativeVersion: string;
  support: SupportMetadata;
  credentialVariables: readonly string[];
  bounds: { nativeLifetimeSeconds: number; exerciseMs: number; cleanupMs: number };
  configure: (
    environment: Readonly<Record<string, string | undefined>>,
    saved?: Routing,
  ) => Routing;
  connection: (
    routing: Routing,
    credentials: Readonly<Record<string, string>>,
  ) => ConnectionFactory;
  configuration: (routing: Routing) => QualificationRecord["configuration"];
};

/** A profile is trusted installed code, just like its adapter; construction must perform no IO. */
export function defineProviderProfile(profile: ProviderProfile): ProviderProfile {
  providerId.parse(profile.id);
  const support = supportMetadataSchema.parse(profile.support);

  if (support.id !== profile.id) throw new Error("Profile support identity differs");
  z.string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_.: /-]+$/)
    .parse(profile.nativeVersion);
  z.array(z.string().regex(/^[A-Z][A-Z0-9_]+$/))
    .min(1)
    .max(16)
    .parse(profile.credentialVariables);
  z.strictObject({
    nativeLifetimeSeconds: z.number().int().min(60).max(900),
    exerciseMs: z.number().int().min(1000).max(240000),
    cleanupMs: z.number().int().min(1000).max(60000),
  }).parse(profile.bounds);

  return profile;
}

export async function loadProviderProfile(path: string): Promise<ProviderProfile> {
  const module = await import(pathToFileURL(path).href);
  z.object({
    configure: z.function(),
    connection: z.function(),
    configuration: z.function(),
  }).parse(module.default);
  // SAFETY: Callable exports were parsed above; defineProviderProfile validates metadata/bounds before use.
  const profile = module.default as ProviderProfile;

  return defineProviderProfile(profile);
}

export function profileRouting(
  profile: ProviderProfile,
  environment: Readonly<Record<string, string | undefined>>,
  saved?: Routing,
) {
  const routing = routingSchema.parse(profile.configure(environment, saved));

  if (routing.nativeLifetimeSeconds !== profile.bounds.nativeLifetimeSeconds)
    throw new Error("Profile routing must retain its approved native lifetime");

  return routing;
}
