import { readFile, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  LedgerStore,
  requirePrivateDirectory,
  type RunLedger,
} from "../../provider-qualification/ledger";
import { loadCredentials } from "../../provider-qualification/credentials";
import { builtinSupport, type SupportMetadata } from "../../provider-qualification/support";
import {
  loadProviderProfile,
  profileRouting,
  providerId,
} from "../../provider-qualification/profile";
import { reopenInFreshProcess } from "../../provider-qualification/reopen";
import { TestResources } from "../fixtures/resources";
import type { ResourceReference } from "sandbar-sdk";

export const liveEnabled = process.env.SANDBAR_LIVE === "1";

const selectedProvider = process.env.SANDBAR_QUAL_PROVIDER ?? "daytona";

const profilePath = process.env.SANDBAR_QUAL_PROFILE
  ? resolve(process.env.SANDBAR_QUAL_PROFILE)
  : undefined;

const external = profilePath ? await loadProviderProfile(profilePath) : undefined;

const declared =
  external?.support ?? builtinSupport.find((profile) => profile.id === selectedProvider);

export const featureSupported = (feature: keyof SupportMetadata["features"]) =>
  declared?.features[feature]?.support !== undefined &&
  declared.features[feature].support !== "unsupported";

const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

const required = (name: string) => {
  const value = process.env[name];

  if (!value) throw new Error(`${name} is required`);

  return value;
};

export async function configuredProvider(saved?: RunLedger["connection"]) {
  const provider = providerId.parse(selectedProvider);

  if (external) {
    if (external.id !== provider) throw new Error("Profile provider differs");

    const routing = profileRouting(
      external,
      process.env,
      saved && "profile" in saved ? saved.routing : undefined,
    );

    const credentials = Object.fromEntries(
      external.credentialVariables.map((name) => [name, required(name)]),
    );

    return {
      provider,
      connection: { profile: provider, routing },
      factory: external.connection(routing, credentials),
      imageId: z.string().parse(routing.imageId),
      network: z.string().parse(routing.networkPolicy),
      exerciseMs: external.bounds.exerciseMs,
      cleanupMs: external.bounds.cleanupMs,
      configuration: external.configuration(routing),
      nativeVersion: external.nativeVersion,
    };
  }

  await loadCredentials();

  if (provider === "daytona") {
    const { daytonaConfiguration, daytonaConnection } =
      await import("../../provider-qualification/daytona-profile");

    const connection = daytonaConfiguration.parse(
      saved ?? {
        target: required("SANDBAR_DAYTONA_TARGET"),
        snapshotId: required("SANDBAR_DAYTONA_SNAPSHOT_ID"),
        networkPolicy: process.env.SANDBAR_DAYTONA_NETWORK_POLICY ?? "blocked",
      },
    );

    return {
      provider,
      connection,
      factory: daytonaConnection(connection, required("SANDBAR_DAYTONA_API_KEY")),
      imageId: connection.snapshotId,
      network: connection.networkPolicy,
      exerciseMs: 240000,
      cleanupMs: 60000,
      nativeVersion: "Daytona REST 0.218",
      configuration: {
        imageClass: "prepared" as const,
        fileRoot: "/tmp" as const,
        templateClass: "borrowed-snapshot" as const,
        authorityClass: "verified-organization" as const,
        network: `${connection.networkPolicy}-requested`,
        regionClass: connection.target,
      },
    };
  }

  if (provider !== "e2b") throw new Error("Select a public external provider profile");

  const { e2bConfiguration, e2bConnection } =
    await import("../../provider-qualification/e2b-profile");

  const connection = e2bConfiguration.parse(
    saved ?? {
      teamId: process.env.SANDBAR_E2B_TEAM_ID,
      templateId: process.env.SANDBAR_E2B_TEMPLATE_ID ?? "base",
    },
  );

  process.env.E2B_API_KEY = required("E2B_API_KEY");
  const manifest = JSON.parse(await readFile(join(root, "packages/sdk/package.json"), "utf8"));

  return {
    provider,
    connection,
    factory: e2bConnection(connection, process.env.E2B_API_KEY),
    imageId: connection.templateId,
    network: "blocked",
    exerciseMs: 240000,
    cleanupMs: 60000,
    nativeVersion: `e2b ${manifest.dependencies.e2b}`,
    configuration: {
      imageClass: "prepared" as const,
      fileRoot: "/home/user" as const,
      templateClass: "borrowed-template" as const,
      authorityClass: connection.teamId ? ("verified-team" as const) : ("api-key" as const),
      network: "blocked-requested",
      regionClass: "native-default",
    },
  };
}

export async function setupLive(
  names: string[],
  budget: { compute: number; snapshots: number; volumes: number },
) {
  if (!liveEnabled || process.env.CI || process.env.SANDBAR_QUAL_LIVE_AUTHORIZED !== "yes")
    throw new Error("Explicit local live authorization is required");

  if (!globalThis.sandbarLiveBuild)
    throw new Error(
      "Run Bun with --preload ./packages/sdk-qualification/live/preload.ts to build before SDK imports",
    );
  const supplied = required("SANDBAR_QUAL_LEDGER_DIR");

  if (!isAbsolute(supplied)) throw Error("Ledger directory must be absolute");
  const directory = await realpath(supplied);
  await requirePrivateDirectory(directory);

  for (const parent of [root, "/tmp", "/private/tmp", await realpath(tmpdir())])
    if (directory === parent || directory.startsWith(parent + sep))
      throw Error("Custody requires stable private storage outside checkout/temp");
  const reportDirectory = await realpath(required("SANDBAR_LIVE_REPORT_DIR"));
  await requirePrivateDirectory(reportDirectory);
  const profile = await configuredProvider();
  const ledger = new LedgerStore(directory, crypto.randomUUID());

  const resources = new TestResources(
    profile.factory,
    ledger,
    profile.imageId,
    profile.network,
    { ...budget, exerciseMs: profile.exerciseMs, cleanupMs: profile.cleanupMs },
    { provider: profile.provider, connection: profile.connection },
  );

  const manifest = JSON.parse(await readFile(join(root, "packages/sdk/package.json"), "utf8"));

  const context = {
    schemaVersion: 1,
    provider: profile.provider,
    names,
    sdkCommit: globalThis.sandbarLiveBuild.revision,
    harnessCommit: globalThis.sandbarLiveBuild.revision,
    dirty: globalThis.sandbarLiveBuild.dirty,
    sdkVersion: manifest.version,
    nativeVersion: profile.nativeVersion,
    runtime: `Bun ${Bun.version}`,
    platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(),
    configuration: profile.configuration,
    runId: ledger.runId,
    cleanup: "pending",
    closeSucceeded: false,
  };

  const contextPath = join(reportDirectory, `${names[0]}.context.json`);
  await writeFile(contextPath, JSON.stringify(context, null, 2), { mode: 0o600, flag: "wx" });

  const fixture = {
    resources,
    profile,
    context,
    contextPath,
    fileRoot: profile.configuration.fileRoot ?? "/tmp",
  };

  // Return ownership before awaiting provider IO, so Bun's afterAll can always abort/reconcile.
  return fixture;
}

export async function finishLive(fixture: Awaited<ReturnType<typeof setupLive>>) {
  const failures: unknown[] = [];

  try {
    await fixture.resources.close();
    fixture.context.closeSucceeded = true;
  } catch (error) {
    failures.push(error);
  }

  try {
    fixture.context.cleanup = (await fixture.resources.ledger.read()).cleanup;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      fixture.context.cleanup = "not-required";
    else failures.push(error);
  }

  try {
    await writeFile(fixture.contextPath, JSON.stringify(fixture.context, null, 2), { mode: 0o600 });
  } catch (error) {
    failures.push(error);
  }

  if (failures.length)
    throw new AggregateError(failures, "Integration teardown or receipt persistence failed");
}

export function reopenSnapshot(
  fixture: Awaited<ReturnType<typeof setupLive>>,
  reference: ResourceReference,
  sandboxProbe?: {
    path: string;
    base64: string;
    inactive?: boolean;
    expires: import("sandbar-sdk").Deadline;
  },
) {
  return reopenInFreshProcess(
    {
      provider: fixture.profile.provider,
      connection: fixture.profile.connection,
      reference,
      profilePath,
      sandboxProbe,
    },
    fixture.resources.signal,
  );
}
