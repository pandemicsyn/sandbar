import { afterEach, expect, test } from "bun:test";
import { Image, ResourceReference } from "sandbar-sdk";
import {
  fixture,
  disposeFixtures,
} from "../../../packages/sdk-qualification/live/fixtures/offline";
import {
  captureSnapshot,
  saveSnapshot,
  reopenSnapshot,
  createVolume,
  saveVolume,
  reopenVolume,
} from "./recovery-outcomes";

afterEach(disposeFixtures);

test("public capture example saves JSON and reopens original bytes after source and client cleanup", async () => {
  const f = await fixture();
  const first = await f.connect(undefined);
  let saved = "";
  const source = await first.sandboxes.create({ environment: Image.prepared("base") });
  const bytes = Uint8Array.of(0, 255, 129);
  await source.writeFile("/captured.bin", bytes);
  const captured = await captureSnapshot(source);
  await saveSnapshot(captured, async (json) => {
    saved = json;
  });
  expect(captured.snapshot.provider).toBe(first.provider);
  await source.destroy();
  await first.close();
  expect(f.snapshots.size).toBe(1);

  const fresh = await f.connect(undefined);

  try {
    const reference = ResourceReference.parse(JSON.parse(saved));
    const restored = await reopenSnapshot(fresh, reference);

    try {
      expect(await restored.readFile("/captured.bin")).toEqual(bytes);
    } finally {
      await restored.destroy();
    }

    await (await fresh.snapshots.get(reference)).delete();
    expect(f.snapshots.size).toBe(0);
  } finally {
    await fresh.close();
  }
});

test("public volume example retains bytes across compute destruction and fresh connection", async () => {
  const f = await fixture();
  const first = await f.connect(undefined);
  let saved = "";
  const volume = await createVolume(first);
  await saveVolume(volume, async (json) => {
    saved = json;
  });

  const source = await first.sandboxes.create({
    environment: Image.prepared("base"),
    mounts: [volume.at("/mnt/workspace")],
  });

  const bytes = Uint8Array.of(0, 255);
  await source.writeFile("/mnt/workspace/data.bin", bytes, { overwrite: true });
  await source.destroy({ storage: "allow-unconfirmed" });
  await first.close();
  expect(f.volumes.size).toBe(1);

  const fresh = await f.connect(undefined);

  try {
    const reopened = await reopenVolume(fresh, ResourceReference.parse(JSON.parse(saved)));

    const consumer = await fresh.sandboxes.create({
      environment: Image.prepared("base"),
      mounts: [reopened.at("/mnt/workspace")],
    });

    try {
      expect(await consumer.readFile("/mnt/workspace/data.bin")).toEqual(bytes);
    } finally {
      await consumer.destroy({ storage: "allow-unconfirmed" });
    }

    await reopened.delete();
    expect(f.volumes.size).toBe(0);
  } finally {
    await fresh.close();
  }
});

test("application save rejection leaves confirmed snapshot and volume handles accessible", async () => {
  const f = await fixture();
  const client = await f.connect(undefined);

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const captured = await captureSnapshot(source);
    const volume = await createVolume(client);

    const failSave = async () => {
      throw new Error("Application storage unavailable");
    };

    await expect(saveSnapshot(captured, failSave)).rejects.toThrow(
      "Application storage unavailable",
    );
    await expect(saveVolume(volume, failSave)).rejects.toThrow("Application storage unavailable");
    expect((await captured.snapshot.inspect()).state).toBe("ready");
    expect((await volume.inspect()).state).toBe("ready");
    await source.destroy();
    await captured.snapshot.delete();
    await volume.delete();
    expect([f.snapshots.size, f.volumes.size]).toEqual([0, 0]);
  } finally {
    await client.close();
  }
});
