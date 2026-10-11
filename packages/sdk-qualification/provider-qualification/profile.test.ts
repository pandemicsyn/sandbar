import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderProfile, profileRouting } from "./profile";
import { TestResources } from "../live/fixtures/resources";
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

  const t = new TestResources(
    profile.connection(routing, { SANDBAR_EXTERNAL_FIXTURE_TOKEN: "offline" }),
    ledger,
    String(routing.imageId),
    "blocked",
    { compute: 1, snapshots: 0, volumes: 0, exerciseMs: 5000, cleanupMs: 1000 },
  );

  try {
    await t.open();
    const box = await t.create("sandbox/source");
    expect((await box.inspect()).state).toBe("running");
  } finally {
    await t.close();
  }

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

test("serialized sandbox reference reopens and uses public files/exec in a separate OS process", async () => {
  const profile = await loadProviderProfile(profilePath);
  const original = process.env.SANDBAR_EXTERNAL_FIXTURE_TOKEN;
  process.env.SANDBAR_EXTERNAL_FIXTURE_TOKEN = "offline";

  try {
    await reopenInFreshProcess(
      {
        provider: profile.id,
        profilePath,
        connection: { profile: profile.id, routing: profileRouting(profile, {}) },
        reference: {
          version: 1,
          kind: "sandbox",
          provider: profile.id,
          scope: { authority: { kind: "fixture", id: "external" }, partition: {} },
          nativeId: "fixture",
          ownership: "verified-created",
          receipt: JSON.stringify({
            operation: "fixture-operation",
            submission: "fixture-submission",
          }),
        },
        sandboxProbe: {
          path: "/tmp/work",
          base64: Buffer.from([0, 255, 31, 128]).toString("base64"),
          expires: { status: "unknown", reason: "Native expiry is unavailable" },
        },
      },
      AbortSignal.timeout(5000),
    );
  } finally {
    if (original === undefined) delete process.env.SANDBAR_EXTERNAL_FIXTURE_TOKEN;
    else process.env.SANDBAR_EXTERNAL_FIXTURE_TOKEN = original;
  }
});
