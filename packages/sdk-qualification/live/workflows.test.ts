import { afterEach, expect, test } from "bun:test";
import { fixture, disposeFixtures } from "./fixtures/offline";
import { TestResources } from "./fixtures/resources";
import { lifecycle, execution, files } from "./sandbox.test";
import { volumeCrud, volumePersistence } from "./volumes.test";
import { networkControls } from "./network.test";
import { networkFixture, outcomes } from "./fixtures/network-offline";

afterEach(disposeFixtures);

async function open(f: Awaited<ReturnType<typeof fixture>>) {
  const t = new TestResources(f.connect, f.ledger, "base", "blocked", {
    compute: 3,
    snapshots: 0,
    volumes: 1,
    exerciseMs: 5000,
    cleanupMs: 1000,
  });

  await t.open();

  return t;
}

test("ordinary Bun baseline bodies test public lifecycle, argv/shell/nonzero and file overwrite/no-clobber", async () => {
  const f = await fixture();
  const t = await open(f);

  try {
    const box = await t.create("sandbox/source");
    await lifecycle(t, box);
    await execution(t, box);
    await files(t, box);
  } finally {
    await t.close();
  }

  expect(f.calls.create).toBe(1);
  expect(f.boxes.size).toBe(0);
  expect((await f.ledger.read()).cleanup).toBe("confirmed");
});

test("independent CRUD uses no compute and shares one volume with mounted persistence", async () => {
  const f = await fixture();
  const t = await open(f);

  try {
    const volume = await t.volume();
    await volumeCrud(t, volume);
    expect(f.calls.create).toBe(0);
    await volumePersistence(t, volume);
  } finally {
    await t.close();
  }

  expect(f.calls).toMatchObject({ create: 2, volumeCreate: 1, volumeDelete: 1 });
  expect([f.boxes.size, f.volumes.size]).toEqual([0, 0]);
});

test("dropped volume bytes fail persistence while owned teardown still completes", async () => {
  const f = await fixture({ dropVolumeWrite: true });
  const t = await open(f);

  try {
    const volume = await t.volume();
    await expect(volumePersistence(t, volume)).rejects.toThrow();
  } finally {
    await t.close();
  }

  expect(f.volumes.size).toBe(0);
});

test.each(["enforced", "leaky"] as const)(
  "advertised read-only %s is checked by native write rejection and unchanged bytes",
  async (readOnly) => {
    const f = await fixture({ readOnly });
    const t = await open(f);

    try {
      const volume = await t.volume();

      if (readOnly === "enforced") await volumePersistence(t, volume);
      else await expect(volumePersistence(t, volume)).rejects.toThrow();
    } finally {
      await t.close();
    }

    expect(f.calls.create).toBe(3);
    expect(f.volumes.size).toBe(0);
  },
);

test("borrowed volume and unrelated data survive cleanup with a unique no-clobber probe path", async () => {
  const f = await fixture({ borrowed: true });
  const t = await open(f);

  try {
    await volumePersistence(t, await t.client.volumes.get(f.borrowed!), true);
  } finally {
    await t.close();
  }

  expect(f.calls.volumeDelete).toBe(0);
  expect(f.volumes.get("borrowed")?.files.get("/existing")).toEqual(new Uint8Array([7]));
});

test.each(["rejected", "uncertain"] as const)(
  "volume %s keeps definitive no-effect distinct from uncertain custody",
  async (volumeFailure) => {
    const f = await fixture({ volumeFailure });
    const t = await open(f);
    await expect(t.volume()).rejects.toThrow();

    if (volumeFailure === "rejected") {
      await t.close();
      expect((await f.ledger.read()).cleanup).toBe("not-required");
      await f.ledger.requirePreviousCleanup("daytona");
    } else {
      await expect(t.close()).rejects.toThrow("unresolved");
      await expect(f.ledger.requirePreviousCleanup("daytona")).rejects.toThrow("unresolved");
    }

    expect(f.calls.volumeCreate).toBe(1);
  },
);

test.each(["pass", "before", "after", "leak"] as const)(
  "paired IPv4 TCP %s keeps positive controls and finite owned cleanup",
  async (mode) => {
    const samples = {
      before: [outcomes(false)],
      after: [outcomes(true), outcomes(false), outcomes(false)],
      leak: [outcomes(true), outcomes(true), outcomes(true)],
      pass: undefined,
    }[mode];

    const f = await networkFixture(samples);

    const t = new TestResources(f.factory, f.internet, "base", "blocked", {
      compute: 2,
      snapshots: 0,
      volumes: 0,
      exerciseMs: 5000,
      cleanupMs: 1000,
    });

    await t.open();

    try {
      if (mode === "pass") await networkControls(t);
      else await expect(networkControls(t)).rejects.toThrow();
    } finally {
      await t.close();
    }

    expect(f.created).toHaveLength(mode === "before" ? 1 : 2);
    expect(f.destroyed).toHaveLength(mode === "before" ? 1 : 2);

    if (mode !== "before") expect(f.commands).toEqual(["owned-1", "owned-2", "owned-1"]);
  },
);

test("selected persistence waits for a creating volume without requiring the CRUD case", async () => {
  const f = await fixture({ readyAfterInspect: 1 });
  const t = await open(f);

  try {
    const volume = await t.volume();
    await volumePersistence(t, volume);
  } finally {
    await t.close();
  }

  expect(f.calls.volumeCreate).toBe(1);
  expect(f.calls.create).toBe(2);
  expect((await f.ledger.read()).cleanup).toBe("confirmed");
});
