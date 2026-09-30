import { ResourceReference } from "sandbar-sdk";
import { z } from "zod";
import { daytonaConfiguration, daytonaConnection } from "./daytona-profile";
import { e2bConfiguration, e2bConnection } from "./e2b-profile";
import { loadProviderProfile, profileRouting } from "./profile";

const input = z
  .object({
    provider: z.string(),
    connection: z.unknown(),
    reference: ResourceReference,
    profilePath: z.string().optional(),
  })
  .parse(JSON.parse(await Bun.stdin.text()));

const required = (name: string) => {
  const value = process.env[name];

  if (!value) throw new Error("Fresh-process credential unavailable");

  return value;
};

const external = input.profilePath ? await loadProviderProfile(input.profilePath) : undefined;

const routing = external
  ? z
      .object({
        profile: z.literal(external.id),
        routing: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      })
      .parse(input.connection).routing
  : undefined;

const factory =
  external && routing
    ? external.connection(
        profileRouting(external, process.env, routing),
        Object.fromEntries(external.credentialVariables.map((name) => [name, required(name)])),
      )
    : input.provider === "e2b"
      ? e2bConnection(e2bConfiguration.parse(input.connection), required("E2B_API_KEY"))
      : input.provider === "daytona"
        ? daytonaConnection(
            daytonaConfiguration.parse(input.connection),
            required("SANDBAR_DAYTONA_API_KEY"),
          )
        : undefined;

if (!factory) throw new Error("Unknown fresh-process profile");

const client = await factory(async () => {
  throw new Error("Fresh-process probe must not mutate");
});

try {
  const snapshot = await client.snapshots.get(input.reference);
  const info = await snapshot.inspect();

  if (
    info.reference.nativeId !== input.reference.nativeId ||
    info.reference.generation !== input.reference.generation ||
    info.mountHandling !== "none" ||
    info.state !== "ready"
  )
    throw new Error("Fresh-process snapshot identity/provenance differs");
} finally {
  await client.close();
}

console.log("reopened");
