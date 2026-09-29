import { expect, test } from "bun:test";
import { z } from "zod";
import { ResourceReference } from "sandbar-adapter";
import {
  Sandbar,
  Image,
  OutcomeUnknownError,
  WaitAbortedError,
  type AdapterRecoveryReference,
} from "sandbar-sdk";
import { createE2BAdapter } from "./index";
import { createSdkTransport, type E2BTransport, type E2BRecord } from "./transport";

function fixture() {
  const boxes = new Map<string, E2BRecord>();
  const snapshots = new Map<string, { snapshotId: string; names: string[] }>();
  const volumes = new Map<string, { volumeId: string; name: string }>();
  let generation = "build_one";
  let createObservation: "missing" | "id" | "scope" | "submission" | "operation" | undefined;
  let extraTag = false;
  let postCaptureRead: (() => void) | undefined;
  let inventoryBarrier: (() => Promise<void>) | undefined;
  let getBarrier: (() => Promise<void>) | undefined;

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
    loseKill: false,
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
      await getBarrier?.();

      if (calls.capture) postCaptureRead?.();

      const box = boxes.get(id);

      if (!box || createObservation === "missing") return null;

      if (createObservation === "id") return { ...box, id: "other_box" };

      if (createObservation)
        return {
          ...box,
          metadata: { ...box.metadata, ["sandbar_" + createObservation]: "foreign" },
        };

      return box;
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

      const deleted = boxes.delete(id);

      if (modes.loseKill) throw new Error("Lost kill response");

      return deleted;
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

  const connect = (apiKey = "fixture-key", onReference?: (ref: AdapterRecoveryReference) => void) =>
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
    postCaptureRead(value: () => void) {
      postCaptureRead = value;
    },
    getBarrier(value: () => Promise<void>) {
      getBarrier = value;
    },
    inventoryBarrier(value: () => Promise<void>) {
      inventoryBarrier = value;
    },
    shareTemplate() {
      extraTag = true;
    },
    replaceBuild() {
      generation = "build_two";
    },
    createObservation(value: typeof createObservation) {
      createObservation = value;
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

  const result = await source.snapshot({ requirements: { preserve: "filesystem+memory" } });
  expect(result.source).toEqual({ state: "running", connections: "dropped" });
  expect(result.snapshot.reference.generation).toBe("build_one");
  expect(f.calls.capture).toBe(1);
  const saved = structuredClone(result.snapshot.reference);
  await source.destroy();
  await client.close();
  const reopened = await f.connect();
  const snapshot = await reopened.snapshots.get(saved);
  expect((await snapshot.inspect()).mountHandling).toBe("none");
  expect((await reopened.capabilities()).snapshots.restore.status).toBe("unsupported");
  await expect(snapshot.restore({ networkPolicy: "blocked" })).rejects.toMatchObject({
    code: "UNSUPPORTED",
    effect: "none",
  });
  f.replaceBuild();
  await expect(snapshot.inspect()).rejects.toMatchObject({ code: "CONFLICT" });
  expect(f.calls.create).toBe(1);
  await reopened.close();
});

test("E2B lost capture acknowledgement is observed without a second capture or guessed ownership", async () => {
  const f = fixture();
  f.modes.loseCapture = true;
  const client = await f.connect();
  const source = await client.sandboxes.create({ environment: Image.prepared("base") });

  const operation = await source.submitSnapshot({
    requirements: { preserve: "filesystem+memory" },
  });

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
  const result = await source.snapshot({ requirements: { preserve: "filesystem+memory" } });
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
  const volume = await client.volumes.create({ name: "fixture-volume" });

  const box = await client.sandboxes.create({ environment: Image.prepared("base") });
  f.boxes.get(box.id)!.volumeMounts = [{ path: "/mnt/data", name: "fixture-volume" }];

  await expect(box.destroy()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(f.calls.kill).toBe(0);
  const result = await box.destroy({ storage: "allow-unconfirmed" });
  expect(result.computeStopped).toBe(true);
  expect(result.mountDurability).toBeUndefined();
  expect(result.retainedResources).toEqual(["e2b-volume-name:fixture-volume"]);
  expect(f.volumes.size).toBe(1);
  await volume.delete();
  expect(f.volumes.size).toBe(0);
  await client.close();
});

test("E2B rejects name-only mounts before create and refuses legacy mount recovery", async () => {
  const f = fixture();
  const client = await f.connect();
  const volume = await client.volumes.create({ name: "fixture-mount" });
  const mounts = [volume.at("/mnt/data")];
  expect((await client.capabilities()).mounts?.status).toBe("unsupported");
  await expect(
    client.sandboxes.create({ environment: Image.prepared("base"), mounts }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED", effect: "none" });
  expect(f.calls.create).toBe(0);
  const operation = await client.sandboxes.submitCreate({ environment: Image.prepared("base") });
  await operation.wait();
  const reference = { ...structuredClone(operation.reference), mounts };
  const recovered = await client.recover(reference);

  expect(Object.isFrozen(recovered.reference.mounts)).toBe(true);
  expect(Reflect.set(recovered.reference.mounts![0]!.volume, "nativeId", "replacement")).toBe(
    false,
  );
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
  const volume = await client.volumes.create({ name: "fixture-scope" });
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

test("E2B mounted destroy cannot dispatch kill after abort during native observation", async () => {
  const f = fixture();
  const client = await f.connect();
  const volume = await client.volumes.create({ name: "fixture-abort" });

  const box = await client.sandboxes.create({ environment: Image.prepared("base") });
  f.boxes.get(box.id)!.volumeMounts = [{ path: "/mnt/data", name: (await volume.inspect()).name! }];

  let entered!: () => void;
  let release!: () => void;

  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  f.getBarrier(async () => {
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
  const result = await source.snapshot({ requirements: { preserve: "filesystem+memory" } });
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
  const result = await source.snapshot({ requirements: { preserve: "filesystem+memory" } });
  await expect(result.snapshot.delete()).rejects.toBeInstanceOf(OutcomeUnknownError);
  expect(f.calls.snapshotDelete).toBe(0);
  await client.close();
});

test("E2B recovery cannot invent capture generation when first tag evidence was unavailable", async () => {
  const f = fixture();
  const client = await f.connect();
  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  f.modes.tagsDenied = true;

  const operation = await source.submitSnapshot({
    requirements: { preserve: "filesystem+memory" },
  });

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

test("E2B cancellation after capture acknowledgement retains generation custody and recovers without capture replay", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.postCaptureRead(() => controller.abort());
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    let failure: unknown;

    try {
      await source.snapshot(undefined, { signal: controller.signal });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WaitAbortedError);

    if (!(failure instanceof WaitAbortedError)) throw new Error("Expected wait abort");
    expect(failure.reference.token).toMatchObject({
      generation: "build_one",
      sourceId: source.id,
      consistency: "unknown",
    });
    const recovered = await (await client.recover(failure.reference)).wait();
    expect(recovered).toMatchObject({
      source: { state: "running" },
      capture: { restoreExecution: "resume" },
    });

    const reference = z
      .object({ snapshot: z.object({ reference: ResourceReference }) })
      .parse(recovered).snapshot.reference;

    await source.destroy();
    const reopened = await f.connect();

    try {
      const snapshot = await reopened.snapshots.get(reference);
      expect(await snapshot.inspect()).toMatchObject({
        restoreExecution: "resume",
        consistency: "unknown",
        reference: { ownership: "verified-created", generation: "build_one" },
      });
      await snapshot.delete();
    } finally {
      await reopened.close();
    }

    expect(f.snapshots.size).toBe(0);
    expect(f.calls.capture).toBe(1);
  } finally {
    await client.close();
  }
});

for (const lostKill of [false, true]) {
  test(`E2B explicit compute cleanup survives unavailable volume inventory: lost kill ${lostKill}`, async () => {
    const f = fixture();
    const client = await f.connect();

    try {
      const volume = await client.volumes.create({ name: "cleanup-retained" });

      const box = await client.sandboxes.create({ environment: Image.prepared("base") });
      f.boxes.get(box.id)!.volumeMounts = [
        { path: "/mnt/work", name: (await volume.inspect()).name! },
      ];

      f.modes.betaDenied = true;
      f.modes.loseKill = lostKill;
      await expect(box.destroy()).rejects.toMatchObject({ code: "UNSUPPORTED", effect: "none" });
      expect(f.calls.kill).toBe(0);
      const result = await box.destroy({ storage: "allow-unconfirmed" });
      expect(result).toMatchObject({
        computeStopped: true,
        retainedResources: ["e2b-volume-name:cleanup-retained"],
      });
      expect(result.mountDurability).toBeUndefined();
      expect(f.calls.kill).toBe(1);
      expect(f.boxes.size).toBe(0);
      expect(f.volumes.size).toBe(1);
      expect(f.calls.volumeDelete).toBe(0);
    } finally {
      await client.close();
    }
  });
}

test("direct custody references recursively freeze capture profiles and resource scope", async () => {
  const f = fixture();
  const checked = new Set<string>();

  const client = await f.connect("fixture-key", (reference) => {
    if (reference.capture) {
      expect(Object.isFrozen(reference.capture.profile.sourceStates)).toBe(true);
      expect(Reflect.set(reference.capture.profile, "preserve", "filesystem")).toBe(false);
      checked.add("capture");
    }

    if (reference.resource) {
      expect(Reflect.set(reference.resource.scope.authority, "id", "foreign")).toBe(false);
      expect(Reflect.set(reference.resource, "nativeId", "replacement")).toBe(false);
      checked.add("resource");
    }

    if (reference.mounts?.length) {
      expect(Reflect.set(reference.mounts[0]!.volume, "nativeId", "replacement")).toBe(false);
      expect(() => reference.mounts!.push(reference.mounts![0]!)).toThrow(TypeError);
      checked.add("mounts");
    }
  });

  try {
    const volume = await client.volumes.create({ name: "frozen-custody" });
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const captured = await source.snapshot();

    await source.destroy();
    await captured.snapshot.delete();
    await volume.delete();
    expect([...checked].sort()).toEqual(["capture", "resource"]);
  } finally {
    await client.close();
  }
});

for (const mode of ["expires-during-read", "expires-after-cancel"] as const) {
  test(`E2B acknowledged snapshot custody survives source loss: ${mode}`, async () => {
    const f = fixture();
    const controller = new AbortController();
    let client = await f.connect();

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      f.postCaptureRead(() => {
        if (mode === "expires-during-read") f.boxes.delete(source.id);
        else controller.abort();
      });
      let failure: unknown;

      try {
        await source.snapshot({ consistency: "caller-quiesced" }, { signal: controller.signal });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(
        mode === "expires-after-cancel" ? WaitAbortedError : OutcomeUnknownError,
      );

      if (!(failure instanceof WaitAbortedError) && !(failure instanceof OutcomeUnknownError))
        throw new Error("Expected uncertain capture with custody");
      const recovery = structuredClone(failure.reference);
      const saved = z.object({ snapshot: ResourceReference }).parse(recovery.token).snapshot;
      expect(saved).toMatchObject({
        nativeId: "snap_one:default",
        generation: "build_one",
        ownership: "verified-created",
      });
      expect(saved.receipt).toBeString();
      f.boxes.delete(source.id);
      await client.close();
      client = await f.connect();
      await expect((await client.recover(recovery)).wait()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
      });
      const snapshot = await client.snapshots.get(saved);
      expect(await snapshot.inspect()).toMatchObject({
        consistency: "caller-quiesced",
        mountHandling: "none",
        source: { id: source.id },
      });
      await snapshot.delete();
      expect(f.calls).toMatchObject({ capture: 1, snapshotDelete: 1, kill: 0 });
    } finally {
      await client.close();
    }
  });
}

test("public snapshot and volume handle scopes are immutable cloned references", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const volume = await client.volumes.create({ name: "immutable-handle" });
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const captured = await source.snapshot();

    for (const handle of [volume, captured.snapshot]) {
      expect(Object.isFrozen(handle.reference)).toBe(true);
      expect(Object.isFrozen(handle.reference.scope)).toBe(true);
      expect(Object.isFrozen(handle.reference.scope.authority)).toBe(true);
      expect(Object.isFrozen(handle.reference.scope.partition)).toBe(true);
      expect(Reflect.set(handle.reference.scope.authority, "id", "foreign")).toBe(false);
      expect(Reflect.set(handle.reference.scope.partition, "endpoint", "foreign")).toBe(false);
      const persisted = structuredClone(handle.reference);
      expect(Reflect.set(persisted.scope.authority, "id", "foreign")).toBe(true);
      expect((await handle.inspect()).reference).toEqual(handle.reference);
    }

    await source.destroy();
    await captured.snapshot.delete();
    await volume.delete();
    expect(f.calls).toMatchObject({ snapshotDelete: 1, volumeDelete: 1 });
  } finally {
    await client.close();
  }
});

test("E2B unsigned capture tokens cannot acquire owned snapshot references during recovery", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.postCaptureRead(() => controller.abort());
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    let failure: unknown;

    try {
      await source.snapshot(undefined, { signal: controller.signal });
    } catch (error) {
      failure = error;
    }

    if (!(failure instanceof WaitAbortedError)) throw new Error("Expected wait abort with custody");
    const reference = structuredClone(failure.reference);
    const token = z.object({ snapshot: ResourceReference }).passthrough().parse(reference.token);
    const { snapshot: _snapshot, ...unsigned } = token;
    reference.token = unsigned;
    await expect((await client.recover(reference)).wait()).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(f.calls).toMatchObject({ capture: 1, snapshotDelete: 0 });
  } finally {
    await client.close();
  }
});

for (const mode of ["missing", "id", "scope", "submission", "operation"] as const) {
  test(`E2B ordinary create refuses unconfirmed native observation: ${mode}`, async () => {
    const f = fixture();
    f.createObservation(mode);
    const client = await f.connect();

    try {
      const operation = await client.sandboxes.submitCreate({
        environment: Image.prepared("base"),
      });

      await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(f.calls.create).toBe(1);
    } finally {
      await client.close();
    }
  });
}

test("E2B old pending restore cannot confirm a reassigned native build", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const capture = await source.snapshot();
    const create = await client.sandboxes.submitCreate({ environment: Image.prepared("base") });
    await create.wait();

    const reference = {
      ...structuredClone(create.reference),
      kind: "snapshot_restore" as const,
      resource: structuredClone(capture.snapshot.reference),
      tokenVersion: 1,
      token: { snapshotId: capture.snapshot.reference.nativeId },
    };

    f.replaceBuild();
    await expect((await client.recover(reference)).wait()).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    expect(f.calls.create).toBe(2);
  } finally {
    await client.close();
  }
});

test("E2B cleanup never adopts a replacement volume with a reused mount name", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const original = await client.volumes.create({ name: "reused-mount" });
    const box = await client.sandboxes.create({ environment: Image.prepared("base") });
    f.boxes.get(box.id)!.volumeMounts = [{ path: "/mnt/data", name: "reused-mount" }];
    await original.delete();
    const replacement = await client.volumes.create({ name: "reused-mount" });
    const result = await box.destroy({ storage: "allow-unconfirmed" });
    expect(result.retainedResources).toEqual(["e2b-volume-name:reused-mount"]);
    expect(result.mountDurability).toBeUndefined();
    expect(result.retainedResources).not.toContain(`e2b-volume:${replacement.reference.nativeId}`);
    expect(f.volumes.has(replacement.reference.nativeId)).toBe(true);
    expect(f.calls.kill).toBe(1);
    expect(f.calls.volumeDelete).toBe(1);
    await replacement.delete();
  } finally {
    await client.close();
  }
});
