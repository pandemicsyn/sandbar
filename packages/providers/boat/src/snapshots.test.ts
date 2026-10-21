import { afterEach, expect, test } from "bun:test";
import { OutcomeUnknownError, Preserve, Sandbar } from "sandbar-sdk";
import { createBoatAdapter } from "./adapter";
import { boatFixture } from "./fixture.test-support";

const fixtures: ReturnType<typeof boatFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const config = { network: "internet" } as const;

function setup() {
  const fixture = boatFixture();
  fixtures.push(fixture);
  const adapter = createBoatAdapter({ fetch: fixture.fetch, pollIntervalMs: 1, settleSeconds: 1 });

  const connect = (apiKey = "fixture-main") =>
    Sandbar.connect({ adapter, config, credentials: { apiKey } });

  return { fixture, adapter, connect };
}

const creates = (fixture: ReturnType<typeof boatFixture>) =>
  fixture.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes");

test("snapshots save the disk under a unique name and restore that exact capture", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const capabilities = await client.capabilities();
    expect(capabilities.snapshots.restore).toMatchObject({ status: "supported" });

    const source = await client.sandboxes.create();
    await source.writeFile("/home/user/state.txt", new TextEncoder().encode("kept"), {
      overwrite: true,
    });
    fixture.setSavingPolls(3);

    const captured = await source.snapshot();
    const { snapshot } = captured;
    const [name = ""] = fixture.snapshots.keys();

    expect(name).toMatch(/^sandbar-snapshot-[0-9a-f]{24}$/);
    expect(fixture.calls.find((call) => call.path === "/named-snapshots")?.body).toEqual({
      sandboxId: source.id,
      name,
    });
    expect(fixture.effects.save).toBe(1);
    expect(snapshot.reference).toMatchObject({
      kind: "snapshot",
      provider: "boat",
      nativeId: name,
      generation: fixture.snapshots.get(name)?.snapshotId,
      ownership: "verified-created",
    });
    expect(captured.capture).toEqual({
      preserve: "filesystem",
      interruption: "pause",
      restoreExecution: "fresh",
    });
    expect(captured.source).toMatchObject({ state: "running" });
    expect((await source.inspect()).state).toBe("running");

    expect(await snapshot.inspect()).toMatchObject({
      preserve: "filesystem",
      restoreExecution: "fresh",
      state: "ready",
      source: { id: source.id, class: "boat-sandbox" },
      restore: { networkPolicies: ["internet"], resources: false, mounts: false },
    });

    // A saved reference reopens in a fresh connection to the same account.
    const saved = JSON.parse(JSON.stringify(snapshot.reference));
    expect((await client.snapshots.get(saved)).id).toBe(snapshot.id);

    const listed = await client.snapshots.list({ limit: 10 });
    expect(listed.coverage).toBe("provider-scope");
    expect(listed.items.map((item) => item.reference)).toEqual([
      { ...snapshot.reference, ownership: "unknown" },
    ]);

    const restored = await snapshot.restore();
    expect(restored.id).not.toBe(source.id);
    // The restore keeps the captured type and still withholds account secrets.
    expect(creates(fixture).at(-1)?.body).toEqual({
      ttlSeconds: 900,
      from: snapshot.reference.nativeId,
      noEnv: true,
    });
    expect(new TextDecoder().decode(await restored.readFile("/home/user/state.txt"))).toBe("kept");
    expect((await restored.inspect()).state).toBe("running");

    await snapshot.delete();
    expect(fixture.snapshots.size).toBe(0);
    await expect(snapshot.inspect()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(snapshot.restore()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.effects.snapshotDelete).toBe(1);
  } finally {
    await client.close();
  }
});

test("an archived sandbox saves the disk its stop captured and stays archived", async () => {
  const { connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    await source.suspend();

    const captured = await source.snapshot();
    expect(captured.source).toMatchObject({ state: "suspended" });
    expect((await source.inspect()).state).toBe("suspended");
  } finally {
    await client.close();
  }
});

test("unmet capture and restore requests reject before any Boat effect", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();

    for (const request of [
      { requirements: { preserve: "filesystem+memory" as const } },
      { requirements: { maxInterruption: "none" as const } },
      { retention: { cleanupAfterSeconds: 3600 } },
      { retention: { minimumSeconds: 60 } },
    ])
      await expect(source.snapshot(request)).rejects.toThrow();
    expect(fixture.effects.save).toBe(0);

    const { snapshot } = await source.snapshot();
    const before = creates(fixture).length;

    await expect(snapshot.restore({ networkPolicy: "blocked" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(snapshot.restore({ resources: { vcpu: 8 } })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(creates(fixture)).toHaveLength(before);
  } finally {
    await client.close();
  }
});

test("a name saved again outside Sandbar no longer restores or deletes by its old reference", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    const { snapshot } = await source.snapshot();
    const before = creates(fixture).length;
    fixture.resaveSnapshot(snapshot.reference.nativeId);

    await expect(snapshot.inspect()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(snapshot.restore()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(snapshot.delete()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(creates(fixture)).toHaveLength(before);
    expect(fixture.effects.snapshotDelete).toBe(0);
    expect(fixture.snapshots.size).toBe(1);
  } finally {
    await client.close();
  }
});

test("a lost save response completes by its attempt name without a second save", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    fixture.loseNextSaveResponse();

    const { snapshot } = await source.snapshot();
    expect(fixture.effects.save).toBe(1);
    expect(snapshot.reference).toMatchObject({ ownership: "verified-created" });
    expect(fixture.snapshots.get(snapshot.reference.nativeId)?.status).toBe("ready");
  } finally {
    await client.close();
  }
});

test("a failed save is unknown, is never resent, and its name can be deleted", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    fixture.failSaves();

    const failed = await source.snapshot().catch((error: Error) => error);
    expect(failed).toBeInstanceOf(OutcomeUnknownError);
    expect(fixture.effects.save).toBe(1);

    const listed = await client.snapshots.list({ limit: 10 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ state: "unknown" });
    expect(listed.items[0]?.reference.generation).toBeUndefined();

    await (await client.snapshots.get(listed.items[0]!.reference)).delete();
    expect(fixture.snapshots.size).toBe(0);
  } finally {
    await client.close();
  }
});

test("snapshot references are bound to the verified Boat account", async () => {
  const { fixture, connect } = setup();
  const main = await connect();
  const other = await connect("fixture-alt");

  try {
    const { snapshot } = await (await main.sandboxes.create()).snapshot();
    await expect(other.snapshots.get(snapshot.reference)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await other.snapshots.list({ limit: 10 })).items).toHaveLength(0);
    expect(fixture.snapshots.size).toBe(1);
  } finally {
    await main.close();
    await other.close();
  }
});

test("Boat accepts filesystem-only preserve and rejects memory at connect before any call", async () => {
  const { fixture, adapter } = setup();

  type Depth = (typeof Preserve)[keyof typeof Preserve];

  const connect = (snapshots: Depth, suspension: Depth) =>
    Sandbar.connect({
      adapter,
      config: {
        ...config,
        snapshots: { preserve: snapshots },
        lifecycle: { suspension: { preserve: suspension } },
      },
      credentials: { apiKey: "fixture-main" },
    });

  for (const [snapshots, suspension] of [
    [Preserve.FILESYSTEM_AND_MEMORY, Preserve.FILESYSTEM],
    [Preserve.FILESYSTEM, Preserve.FILESYSTEM_AND_MEMORY],
  ] as const)
    await expect(connect(snapshots, suspension)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(fixture.calls).toHaveLength(0);

  const client = await connect(Preserve.FILESYSTEM, Preserve.FILESYSTEM);

  try {
    const source = await client.sandboxes.create();
    const captured = await source.snapshot({ requirements: { preserve: Preserve.FILESYSTEM } });
    expect(captured.capture.preserve).toBe("filesystem");
  } finally {
    await client.close();
  }
});
