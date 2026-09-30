import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderProfile, profileRouting } from "./profile";
import { runPrepared } from "./lifecycle";
import { LedgerStore } from "./ledger";
import { reopenInFreshProcess } from "./reopen";

const directories: string[] = [];

afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

const profilePath = fileURLToPath(new URL("./fixtures/external-profile.ts", import.meta.url));

test("external profile loads its public adapter through the maintained baseline and owned cleanup", async () => {
  const profile = await loadProviderProfile(profilePath);
  const routing = profileRouting(profile, {});
  const directory = await mkdtemp(join(tmpdir(), "sandbar-external-profile-"));
  directories.push(directory);
  const ledger = new LedgerStore(directory, crypto.randomUUID());
  await ledger.initialize(
    profile.id,
    { kind: "borrowed-prepared", class: "fixture" },
    { profile: profile.id, routing },
  );

  const steps = await runPrepared(
    profile.connection(routing, { SANDBAR_EXTERNAL_FIXTURE_TOKEN: "offline" }),
    ledger,
    String(routing.imageId),
    {
      network: "blocked",
      selectedScenarios: new Set(["inspect"]),
      signal: AbortSignal.timeout(5000),
      cleanupWaitMs: 1000,
    },
  );

  expect(
    steps
      .filter((step) =>
        ["connect", "create-prepared", "inspect", "confirm-cleanup", "close"].includes(
          step.scenario,
        ),
      )
      .map((step) => step.status),
  ).toEqual(["passed", "passed", "passed", "passed", "passed"]);
  expect((await ledger.read()).cleanup).toBe("confirmed");
});

test("serialized snapshot reference reopens and validates scope in a separate OS process", async () => {
  const profile = await loadProviderProfile(profilePath);

  const input = {
    provider: profile.id,
    profilePath,
    connection: { profile: profile.id, routing: profileRouting(profile, {}) },
    reference: {
      version: 1 as const,
      kind: "snapshot" as const,
      provider: profile.id,
      scope: { authority: { kind: "fixture", id: "external" }, partition: {} },
      nativeId: "fixture-snapshot",
      ownership: "verified-created" as const,
    },
  };

  const original = process.env.SANDBAR_EXTERNAL_FIXTURE_TOKEN;
  process.env.SANDBAR_EXTERNAL_FIXTURE_TOKEN = "offline";

  try {
    await reopenInFreshProcess(input, AbortSignal.timeout(5000));
    await expect(
      reopenInFreshProcess(
        {
          ...input,
          reference: {
            ...input.reference,
            scope: { authority: { kind: "fixture", id: "foreign" }, partition: {} },
          },
        },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow("reopen/inspect failed");
  } finally {
    if (original === undefined) delete process.env.SANDBAR_EXTERNAL_FIXTURE_TOKEN;
    else process.env.SANDBAR_EXTERNAL_FIXTURE_TOKEN = original;
  }
});
