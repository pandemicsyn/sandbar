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
    sandboxProbe: z
      .object({
        path: z.string(),
        base64: z.string(),
        inactive: z.boolean().optional(),
        expires: z.unknown(),
      })
      .optional(),
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

const client = await factory(async (reference) => {
  if (!input.sandboxProbe || reference.kind !== "exec")
    throw new Error("Fresh-process probe forbids control-plane mutations");
});

try {
  if (input.reference.kind === "sandbox" && input.sandboxProbe) {
    const sandbox = await client.sandboxes.get({ ...input.reference, kind: "sandbox" });
    const before = await sandbox.inspect();

    if (input.sandboxProbe.inactive) {
      if (!["stopped", "suspended"].includes(before.state))
        throw Error("Inactive reopen changed state");

      for (const read of [
        () => sandbox.readFile(input.sandboxProbe!.path),
        () => sandbox.exec(["true"]),
      ]) {
        let rejected = false;

        try {
          await read();
        } catch {
          rejected = true;
        }

        if (!rejected) throw Error("Inactive guest access succeeded");
      }

      if (
        (await sandbox.inspect()).state !== before.state ||
        JSON.stringify(before.expires) !== JSON.stringify(input.sandboxProbe.expires)
      )
        throw Error("Inactive guest access changed lifecycle");
    } else {
      if (
        input.provider === "e2b" &&
        (before.expires.status !== "known" || before.expires.scope !== "running-session")
      )
        throw new Error("E2B running-session expiry is required for no-extension evidence");

      if (
        before.state !== "running" ||
        JSON.stringify(before.expires) !== JSON.stringify(input.sandboxProbe.expires)
      )
        throw new Error("Fresh-process sandbox state/deadline differs");
      const bytes = await sandbox.readFile(input.sandboxProbe.path);

      if (Buffer.from(bytes).toString("base64") !== input.sandboxProbe.base64)
        throw new Error("Fresh-process sandbox bytes differ");
      const result = await sandbox.exec(["/bin/sh", "-c", "printf sandbox-reopen"]);

      if (result.stdoutText() !== "sandbox-reopen")
        throw new Error("Fresh-process sandbox exec differs");

      if (JSON.stringify((await sandbox.inspect()).expires) !== JSON.stringify(before.expires))
        throw new Error("Guest access changed sandbox expiry");
    }
  } else {
    const snapshot = await client.snapshots.get(input.reference);
    const info = await snapshot.inspect();

    if (
      info.reference.nativeId !== input.reference.nativeId ||
      info.reference.generation !== input.reference.generation ||
      info.mountHandling !== "none" ||
      info.state !== "ready"
    )
      throw new Error("Fresh-process snapshot identity/provenance differs");
  }
} finally {
  await client.close();
}

console.log("reopened");
