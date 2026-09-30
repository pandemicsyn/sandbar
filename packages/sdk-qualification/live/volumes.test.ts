import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SandbarError, type AdapterVolume } from "sandbar-sdk";
import { TestResources } from "./fixtures/resources";
import { liveEnabled, setupLive, finishLive, featureSupported } from "./providers";

export async function volumeCrud(t: TestResources, volume: AdapterVolume) {
  let info = await volume.inspect({ signal: t.signal });

  for (let read = 0; info.state === "creating" && read < 40; read++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    t.signal.throwIfAborted();
    info = await volume.inspect({ signal: t.signal });
  }

  expect(info.state).toBe("ready");
  expect(info.reference.nativeId).toBe(volume.reference.nativeId);
}

export async function volumePersistence(t: TestResources, volume: AdapterVolume, borrowed = false) {
  await volumeCrud(t, volume);
  const caps = await t.client.capabilities();
  const mounts = caps.mounts;

  if (mounts?.status !== "supported")
    throw new SandbarError(
      mounts?.status === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE",
      "Mount eligibility unavailable",
    );
  const path = `/mnt/sandbar-state/sandbar_${t.ledger.runId.replaceAll("-", "")}.bin`;
  const bytes = new TextEncoder().encode(`Sandbar persistence ${t.ledger.runId}`);
  const producer = await t.create("volume/producer", [volume.at("/mnt/sandbar-state")]);
  await producer.writeFile(path, bytes, { overwrite: !borrowed, signal: t.signal });
  await t.exec(
    producer,
    `python3 -c 'import os;f=open(${JSON.stringify(path)},"rb");os.fsync(f.fileno());f.close()'`,
  );
  expect(await t.read(producer, path)).toEqual(bytes);
  await t.destroy("volume/producer");
  expect((await volume.inspect({ signal: t.signal })).state).toBe("ready");
  const consumer = await t.create("volume/consumer", [volume.at("/mnt/sandbar-state")]);
  expect(await t.read(consumer, path)).toEqual(bytes);

  if (mounts.value.access.includes("read-only")) {
    await t.destroy("volume/consumer");

    const reader = await t.create("volume/read-only", [
      volume.at("/mnt/sandbar-state", { access: "read-only" }),
    ]);

    const script = `import errno\ntry:\n f=open(${JSON.stringify(path)},"r+b")\n f.write(bytes([7]));f.close()\n print("WRITE_ACCEPTED")\nexcept OSError as e:\n if e.errno not in (errno.EACCES,errno.EPERM,errno.EROFS): raise\n print("READ_ONLY_REJECTED")`;
    expect(await t.exec(reader, `python3 -c '${script}'`)).toBe("READ_ONLY_REJECTED\n");
    expect(await t.read(reader, path)).toEqual(bytes);
  }
}

const enabled = liveEnabled && featureSupported("volumes");

describe("Sandbar volumes", () => {
  let fixture: Awaited<ReturnType<typeof setupLive>> | undefined;
  let volume: AdapterVolume;
  beforeAll(async () => {
    if (enabled) {
      fixture = await setupLive(["volume-crud", "volume-persistence"], {
        compute: 3,
        snapshots: 0,
        volumes: 1,
      });
      await fixture.resources.setup(async () => {
        await fixture!.resources.open();
        volume = await fixture!.resources.volume();
      });
    }
  }, 96000);
  afterAll(async () => {
    if (fixture) await finishLive(fixture);
  }, 76000);
  (enabled ? test : test.skip)(
    "volume-crud",
    async () => volumeCrud(fixture!.resources, volume),
    241000,
  );
  (enabled && featureSupported("persistence") ? test : test.skip)(
    "volume-persistence",
    async () => volumePersistence(fixture!.resources, volume),
    241000,
  );
});
