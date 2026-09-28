import { expect, test } from "bun:test";
import { Sandbar, Image, OutcomeUnknownError } from "sandbar-sdk";
import { createE2BAdapter } from "./index";
import { createSdkTransport, type E2BTransport, type E2BRecord } from "./transport";

function fixture() {
  const boxes = new Map<string, E2BRecord>();
  const snapshots = new Map<string, { snapshotId: string; names: string[] }>();
  const volumes = new Map<string, { volumeId: string; name: string }>();
  let generation = "build_one";
  let extraTag = false;
  let inventoryBarrier: (() => Promise<void>) | undefined;

  const calls = {
    create: 0,
    capture: 0,
    snapshotDelete: 0,
    volumeCreate: 0,
    volumeDelete: 0,
    kill: 0,
  };

  const modes = {
    loseCapture: false,
    loseDelete: false,
    omitMounts: false,
    betaDenied: false,
    tagsDenied: false,
  };

  const transport: E2BTransport = {
    async verifyAuth() {},
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      return id;
    },
    async buildImage() {
      throw new Error("No image build in fixture");
    },
    async findBuild() {
      return null;
    },
    async create(input) {
      calls.create++;
      const id = `box_${calls.create}`;
      boxes.set(id, {
        id,
        templateId: input.templateId.split(":")[0]!,
        metadata: input.metadata,
        state: "running",
        envdVersion: "0.5.1",
        volumeMounts: modes.omitMounts
          ? []
          : Object.entries(input.volumeMounts ?? {}).map(([path, name]) => ({ path, name })),
      });

      return id;
    },
    async get(id) {
      return boxes.get(id) ?? null;
    },
    async list(metadata, limit) {
      return {
        items: [...boxes.values()]
          .filter((box) =>
            Object.entries(metadata).every(([key, value]) => box.metadata[key] === value),
          )
          .slice(0, limit),
      };
    },
    async kill(id) {
      calls.kill++;

      return boxes.delete(id);
    },
    async run() {
      throw new Error("No process fixture");
    },
    async read() {
      throw new Error("No filesystem fixture");
    },
    async write() {},
    async remove() {},
    close() {},
    state: {
      async tags() {
        if (modes.tagsDenied) throw new Error("Native tag evidence unavailable");

        return [
          { tag: "default", buildId: generation },
          ...(extraTag ? [{ tag: "shared", buildId: generation }] : []),
        ];
      },
      async capture(_id, name) {
        calls.capture++;
        expect(name).toBeUndefined();
        const snapshot = { snapshotId: "snap_one:default", names: [] };
        snapshots.set(snapshot.snapshotId, snapshot);

        if (modes.loseCapture) throw new Error("Acknowledgement lost after native capture");

        return snapshot;
      },
      async snapshots(input) {
        return {
          items: [...snapshots.values()]
            .filter((snapshot) => !input.name || snapshot.snapshotId === input.name)
            .slice(0, input.limit),
        };
      },
      async deleteSnapshot(id) {
        calls.snapshotDelete++;
        snapshots.delete(id);

        if (modes.loseDelete) throw new Error("Acknowledgement lost after deletion");

        return true;
      },
      async createVolume(name) {
        calls.volumeCreate++;
        const volume = { volumeId: `volume_${calls.volumeCreate}`, name };
        volumes.set(volume.volumeId, volume);

        return volume;
      },
      async volume(id) {
        const volume = volumes.get(id);

        if (!volume) throw new Error("404 volume");

        return volume;
      },
      async volumes() {
        await inventoryBarrier?.();

        if (modes.betaDenied) throw new Error("403 private beta");

        return [...volumes.values()];
      },
      async deleteVolume(id) {
        calls.volumeDelete++;

        return volumes.delete(id);
      },
    },
  };

  const connect = (apiKey = "fixture-key", onReference?: (ref: { kind: string }) => void) =>
    Sandbar.connect({
      adapter: createE2BAdapter(() => transport),
      config: {},
      credentials: { apiKey },
      onReference,
    });

  return {
    connect,
    boxes,
    snapshots,
    volumes,
    calls,
    modes,
    inventoryBarrier(value: () => Promise<void>) {
      inventoryBarrier = value;
    },
    shareTemplate() {
      extraTag = true;
    },
    replaceBuild() {
      generation = "build_two";
    },
  };
}

test("E2B capture is independent compute, reconnects after source deletion, and detects tag reassignment", async () => {
  const f = fixture();
  const client = await f.connect();

  const source = await client.sandboxes.create({
    environment: Image.prepared("base"),
    networkPolicy: "blocked",
  });

  const result = await source.snapshot({ preserve: "filesystem+memory" });
  expect(result.source).toEqual({ state: "running", connections: "dropped" });
  expect(result.snapshot.reference.generation).toBe("build_one");
  expect(f.calls.capture).toBe(1);
  const saved = structuredClone(result.snapshot.reference);
  await source.destroy();
  await client.close();
  const reopened = await f.connect();
  const snapshot = await reopened.snapshots.get(saved);
  expect((await snapshot.inspect()).mountHandling).toBe("none");
  const restored = await snapshot.restore({ networkPolicy: "blocked" });
  expect(restored.id).not.toBe(source.id);
  await restored.destroy();
  f.replaceBuild();
  await expect(snapshot.restore({ networkPolicy: "blocked" })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(f.calls.create).toBe(2);
  await reopened.close();
});

test("E2B lost capture acknowledgement is observed without a second capture or guessed ownership", async () => {
  const f = fixture();
  f.modes.loseCapture = true;
  const client = await f.connect();
  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  const operation = await source.submitSnapshot({ preserve: "filesystem+memory" });
  await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
  const recovered = await client.recover(operation.reference);
  await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
  expect(f.calls.capture).toBe(1);
  expect(f.snapshots.size).toBe(1);
  expect(f.calls.snapshotDelete).toBe(0);
  await source.destroy();
  await client.close();
});

test("native deletion needs an acknowledged request, an owned receipt, and matching scope", async () => {
  const f = fixture();
  const client = await f.connect();
  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  const result = await source.snapshot({ preserve: "filesystem+memory" });
  const foreign = structuredClone(result.snapshot.reference);
  foreign.provider = "daytona";
  await expect(
    Promise.resolve().then(() => client.snapshots.delete(foreign)),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const forged = structuredClone(result.snapshot.reference);
  delete forged.receipt;
  await expect(client.snapshots.delete(forged)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(f.calls.snapshotDelete).toBe(0);
  f.modes.loseDelete = true;
  const operation = await result.snapshot.submitDelete();
  await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
  const recovered = await client.recover(operation.reference);
  await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
  expect(f.calls.snapshotDelete).toBe(1);
  await source.destroy();
  await client.close();
});

test("E2B mounted compute requires explicit unconfirmed durability and retains independent volume custody", async () => {
  const f = fixture();
  const client = await f.connect();
  const volume = await client.volumes.create({ name: "fixture_volume" });

  const box = await client.sandboxes.create({
    environment: Image.prepared("base"),
    mounts: [volume.at("/mnt/data")],
  });

  await expect(box.destroy()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(f.calls.kill).toBe(0);
  const result = await box.destroy({ storage: "allow-unconfirmed" });
  expect(result.computeStopped).toBe(true);
  expect(result.mountDurability?.[0]?.status).toBe("unconfirmed");
  expect(result.retainedResources).toContain(`e2b-volume:${volume.reference.nativeId}`);
  expect(f.volumes.size).toBe(1);
  await volume.delete();
  expect(f.volumes.size).toBe(0);
  await client.close();
});

test("E2B mount recovery never succeeds from compute identity alone", async () => {
  const f = fixture();
  f.modes.omitMounts = true;
  const client = await f.connect();
  const volume = await client.volumes.create({ name: "fixture_mount" });

  const operation = await client.sandboxes.submitCreate({
    environment: Image.prepared("base"),
    mounts: [volume.at("/mnt/data")],
  });

  await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
  expect(operation.reference.mounts?.length).toBe(1);
  const recovered = await client.recover(operation.reference);
  await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
  expect(f.calls.create).toBe(1);
  await client.close();
});

test("private-beta denial and incompatible mounts fail before effect", async () => {
  const f = fixture();
  const client = await f.connect();
  f.modes.betaDenied = true;
  expect((await client.capabilities()).volumes.status).toBe("unavailable");
  f.modes.betaDenied = false;
  const volume = await client.volumes.create({ name: "fixture_scope" });
  await expect(
    client.sandboxes.create({
      environment: Image.prepared("base"),
      mounts: [volume.at("/mnt/data", { access: "read-only" })],
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  const foreign = structuredClone(volume.reference);
  foreign.scope.partition.other = "foreign";
  await expect(
    client.sandboxes.create({
      environment: Image.prepared("base"),
      mounts: [{ ...volume.at("/mnt/data"), volume: foreign }],
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(f.calls.create).toBe(0);
  await volume.delete();
  await client.close();
});

test("pinned native volume/tag inventory is byte bounded before parsing", async () => {
  let cancelled = 0;

  const fetcher = Object.assign(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1048577));
          },
          cancel() {
            cancelled++;
          },
        }),
      ),
    { preconnect() {} },
  );

  const transport = createSdkTransport("fixture-key", fetcher);
  await expect(transport.state!.volumes()).rejects.toThrow("byte bound");
  await expect(transport.state!.tags("raw_id")).rejects.toThrow("byte bound");
  expect(cancelled).toBe(2);
});

test("E2B mounted destroy cannot dispatch kill after abort during inventory", async () => {
  const f = fixture();
  const client = await f.connect();
  const volume = await client.volumes.create({ name: "fixture_abort" });

  const box = await client.sandboxes.create({
    environment: Image.prepared("base"),
    mounts: [{ volume: volume.reference, path: "/mnt/data", access: "read-write" }],
  });

  let entered!: () => void;
  let release!: () => void;

  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  f.inventoryBarrier(async () => {
    entered();
    await barrier;
  });
  const controller = new AbortController();
  const destroying = box.submitDestroy({ storage: "allow-unconfirmed", signal: controller.signal });
  await started;
  controller.abort();
  release();
  await expect(destroying).rejects.toMatchObject({ code: "WAIT_ABORTED" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.calls.kill).toBe(0);
  expect(f.boxes.has(box.id)).toBe(true);
  await client.close();
});

test("E2B deletion revalidates native generation after the durable barrier", async () => {
  const f = fixture();

  const client = await f.connect("fixture-key", (ref) => {
    if (ref.kind === "snapshot_delete") f.replaceBuild();
  });

  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  const result = await source.snapshot({ preserve: "filesystem+memory" });
  await expect(result.snapshot.delete()).rejects.toBeInstanceOf(OutcomeUnknownError);
  expect(f.calls.snapshotDelete).toBe(0);
  expect(f.snapshots.size).toBe(1);
  await client.close();
});

test("E2B deletion refuses a newly shared native template after the durable barrier", async () => {
  const f = fixture();

  const client = await f.connect("fixture-key", (ref) => {
    if (ref.kind === "snapshot_delete") f.shareTemplate();
  });

  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  const result = await source.snapshot({ preserve: "filesystem+memory" });
  await expect(result.snapshot.delete()).rejects.toBeInstanceOf(OutcomeUnknownError);
  expect(f.calls.snapshotDelete).toBe(0);
  await client.close();
});

test("E2B recovery cannot invent capture generation when first tag evidence was unavailable", async () => {
  const f = fixture();
  const client = await f.connect();
  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  f.modes.tagsDenied = true;
  const operation = await source.submitSnapshot({ preserve: "filesystem+memory" });
  await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
  f.modes.tagsDenied = false;
  f.replaceBuild();
  await expect((await client.recover(operation.reference)).wait()).rejects.toBeInstanceOf(
    OutcomeUnknownError,
  );
  expect(f.calls.capture).toBe(1);
  expect(f.calls.snapshotDelete).toBe(0);
  await client.close();
});
