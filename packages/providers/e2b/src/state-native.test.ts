import { expect, test } from "bun:test";
import { z } from "zod";
import { ResourceReference } from "sandbar-adapter";
import {
  Sandbar,
  SandbarError,
  Image,
  OutcomeUnknownError,
  WaitAbortedError,
  type AdapterRecoveryReference,
} from "sandbar-sdk";
import { createE2BAdapter } from "./index";
import {
  E2BVolumeCreateRejected,
  createSdkTransport,
  type E2BTransport,
  type E2BRecord,
} from "./transport";

function fixture() {
  const boxes = new Map<string, E2BRecord>();
  const snapshots = new Map<string, { snapshotId: string; names: string[] }>();
  const volumes = new Map<string, { volumeId: string; name: string }>();
  let generation = "11111111-1111-4111-8111-111111111111";
  let retainedGeneration: string | undefined;
  const createRequests: { templateId: string; allowInternetAccess: boolean }[] = [];
  let createObservation: "missing" | "id" | "scope" | "submission" | "operation" | undefined;
  let extraTag = false;
  let postCaptureRead: (() => void) | undefined;
  let inventoryBarrier: (() => Promise<void>) | undefined;
  let getBarrier: (() => Promise<void>) | undefined;
  let deleteReadStage: "template" | "address" | "dependencies" | "volume" | undefined;
  let deleteReadBarrier: (() => Promise<void>) | undefined;

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
    deleteNotFound: false,
    keepDeletedResource: false,
    loseKill: false,
    omitMounts: false,
    betaDenied: false,
    tagsDenied: false,
    aliasShadowed: false,
    loseRestore: false,
    // SAFETY: The fixture injects only Error instances or no failure.
    volumeCreateFailure: undefined as Error | undefined,
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
      createRequests.push({
        templateId: input.templateId,
        allowInternetAccess: input.allowInternetAccess,
      });
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

      if (modes.loseRestore && input.metadata.sandbar_snapshot)
        throw new Error("Restore acknowledgement lost");

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
      if (deleteReadStage === "dependencies") await deleteReadBarrier?.();

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
      async template(id) {
        if (deleteReadStage === "template") await deleteReadBarrier?.();

        if (!snapshots.has(`${id}:default`)) return null;

        return {
          templateId: id,
          names: extraTag ? ["shared"] : [],
          public: false,
          builds: [
            { buildId: generation, status: "ready" },
            ...(retainedGeneration
              ? [{ buildId: retainedGeneration, status: "ready" as const }]
              : []),
          ],
        };
      },
      async verifyAddress() {
        if (deleteReadStage === "address") await deleteReadBarrier?.();

        if (modes.aliasShadowed)
          throw new Error("Snapshot address shadowed by another template alias");
      },
      async tags() {
        if (modes.tagsDenied) throw new Error("Native tag evidence unavailable");

        return [
          { tag: "default", buildId: generation },
          ...(extraTag ? [{ tag: "shared", buildId: generation }] : []),
          ...(retainedGeneration ? [{ tag: "captured", buildId: retainedGeneration }] : []),
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

        if (!modes.keepDeletedResource) snapshots.delete(`${id}:default`);

        if (modes.deleteNotFound) return false;

        if (modes.loseDelete) throw new Error("Acknowledgement lost after deletion");

        return true;
      },
      async createVolume(name) {
        calls.volumeCreate++;

        if (modes.volumeCreateFailure) throw modes.volumeCreateFailure;
        const volume = { volumeId: `volume_${calls.volumeCreate}`, name };
        volumes.set(volume.volumeId, volume);

        return volume;
      },
      async volume(id) {
        if (deleteReadStage === "volume") await deleteReadBarrier?.();

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

        const deleted = modes.keepDeletedResource ? false : volumes.delete(id);

        return modes.deleteNotFound ? false : deleted;
      },
    },
  };

  const connect = (
    apiKey = "fixture-key",
    onReference?: (ref: AdapterRecoveryReference) => void,
    teamId?: string,
  ) =>
    Sandbar.connect({
      adapter: createE2BAdapter(() => transport),
      config: teamId ? { teamId } : {},
      credentials: { apiKey },
      onReference,
    });

  return {
    connect,
    transport,
    boxes,
    snapshots,
    volumes,
    calls,
    modes,
    createRequests,
    moveDefault() {
      retainedGeneration = generation;
      generation = "22222222-2222-4222-8222-222222222222";
    },
    postCaptureRead(value: () => void) {
      postCaptureRead = value;
    },
    deleteReadBarrier(stage: typeof deleteReadStage, callback: () => Promise<void>) {
      deleteReadStage = stage;
      deleteReadBarrier = callback;
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
      generation = "22222222-2222-4222-8222-222222222222";
    },
    createObservation(value: typeof createObservation) {
      createObservation = value;
    },
  };
}

test("E2B captures, restores the saved UUID after source deletion, and rejects a missing build", async () => {
  const f = fixture();
  const client = await f.connect();

  const source = await client.sandboxes.create({
    environment: Image.prepared("base"),
    networkPolicy: "blocked",
  });

  const result = await source.snapshot();
  const saved = structuredClone(result.snapshot.reference);
  expect(saved.nativeId).toBe("snap_one");
  expect(saved.generation).toBe("11111111-1111-4111-8111-111111111111");
  await source.destroy();
  await client.close();
  const reopened = await f.connect();

  try {
    const snapshot = await reopened.snapshots.get(saved);
    expect((await snapshot.inspect()).mountHandling).toBe("none");
    expect((await reopened.capabilities()).snapshots.restore.status).toBe("supported");
    const restored = await snapshot.restore({ networkPolicy: "blocked" });
    expect(f.boxes.get(restored.id)?.metadata.sandbar_snapshot).toBe(
      `snap_one:${saved.generation}`,
    );
    await restored.destroy();
    f.replaceBuild();
    await expect(snapshot.inspect()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.calls).toMatchObject({ create: 2, capture: 1 });
  } finally {
    await reopened.close();
  }
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

test("E2B explicit borrowed template deletion checks scope and confirms native absence", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const result = await source.snapshot();
    const foreign = structuredClone(result.snapshot.reference);
    foreign.provider = "daytona";
    await expect(
      Promise.resolve().then(() => client.snapshots.delete(foreign)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const missing = structuredClone(result.snapshot.reference);
    delete missing.history;
    missing.ownership = "borrowed";
    expect(f.calls.snapshotDelete).toBe(0);
    await source.destroy();
    await client.snapshots.delete(missing);
    expect(f.calls.snapshotDelete).toBe(1);
    expect(f.snapshots.size).toBe(0);
    expect((await client.capabilities()).snapshots.delete.status).toBe("supported");
  } finally {
    await client.close();
  }
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

test("E2B snapshot deletion cannot dispatch through a mutable generation", async () => {
  const f = fixture();

  const client = await f.connect("fixture-key", (ref) => {
    if (ref.kind === "snapshot_delete") f.replaceBuild();
  });

  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  const result = await source.snapshot({ requirements: { preserve: "filesystem+memory" } });
  await expect(result.snapshot.delete()).rejects.toMatchObject({
    code: "OUTCOME_UNKNOWN",
  });
  expect(f.calls.snapshotDelete).toBe(0);
  expect(f.snapshots.size).toBe(1);
  await client.close();
});

test("E2B snapshot deletion cannot dispatch through a shared template", async () => {
  const f = fixture();

  const client = await f.connect("fixture-key", (ref) => {
    if (ref.kind === "snapshot_delete") f.shareTemplate();
  });

  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  const result = await source.snapshot({ requirements: { preserve: "filesystem+memory" } });
  await expect(result.snapshot.delete()).rejects.toMatchObject({
    code: "OUTCOME_UNKNOWN",
  });
  expect(f.calls.snapshotDelete).toBe(0);
  await client.close();
});

test.each(["verified-created", "borrowed"] as const)(
  "E2B forged %s history cannot widen deletion to another build",
  async (ownership) => {
    const f = fixture();
    const client = await f.connect();

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      const snapshot = (await source.snapshot()).snapshot;
      await source.destroy();
      f.moveDefault();
      const selected = structuredClone(snapshot.reference);
      selected.ownership = ownership;
      selected.history = {
        version: 1,
        kind: "snapshot",
        provenance: "application-retained",
        nativeId: selected.nativeId,
        generation: selected.generation!,
        deletion: {
          templateId: selected.nativeId,
          public: false,
          names: [],
          builds: [selected.generation!, "22222222-2222-4222-8222-222222222222"],
        },
      };

      await expect(client.snapshots.delete(selected)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(f.calls.snapshotDelete).toBe(0);
      expect(f.snapshots.size).toBe(1);
    } finally {
      await client.close();
    }
  },
);

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
      generation: "11111111-1111-4111-8111-111111111111",
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
        reference: {
          ownership: "verified-created",
          generation: "11111111-1111-4111-8111-111111111111",
        },
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
        nativeId: "snap_one",
        generation: "11111111-1111-4111-8111-111111111111",
        ownership: "verified-created",
      });
      expect(saved.history).toMatchObject({ provenance: "application-retained" });
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
      token: {
        selector: `${capture.snapshot.reference.nativeId}:${capture.snapshot.reference.generation}`,
        state: "uncertain",
      },
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

test("E2B pinned restore survives default movement but cleanup rejects expanded template", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const snapshot = (await source.snapshot()).snapshot;
    f.moveDefault();
    expect((await snapshot.inspect()).reference.generation).toBe(snapshot.reference.generation);
    const restored = await snapshot.restore({ networkPolicy: "blocked" });
    expect(f.createRequests.at(-1)).toEqual({
      templateId: `snap_one:${snapshot.reference.generation}`,
      allowInternetAccess: false,
    });
    await restored.destroy();
    await source.destroy();
    await expect(snapshot.delete()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.calls.snapshotDelete).toBe(0);
  } finally {
    await client.close();
  }
});

test("E2B snapshot history reopens after source loss and credential rotation with verified team scope", async () => {
  const f = fixture();
  const client = await f.connect("original-key", undefined, "team-fixture");
  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  const saved = JSON.parse(JSON.stringify((await source.snapshot()).snapshot.reference));
  await source.destroy();
  await client.close();
  const reopened = await f.connect("rotated-key", undefined, "team-fixture");

  try {
    const snapshot = await reopened.snapshots.get(saved);
    const restored = await snapshot.restore({ networkPolicy: "internet" });
    expect(f.createRequests.at(-1)).toEqual({
      templateId: `snap_one:${saved.generation}`,
      allowInternetAccess: true,
    });
    await restored.destroy();
    await snapshot.delete();
    expect(f.calls.snapshotDelete).toBe(1);
  } finally {
    await reopened.close();
  }
});

test("E2B snapshot alias shadowing blocks restore and cleanup without native effects", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const snapshot = (await source.snapshot()).snapshot;
    f.modes.aliasShadowed = true;
    await expect(snapshot.restore({ networkPolicy: "blocked" })).rejects.toThrow("shadowed");
    await expect(snapshot.delete()).rejects.toThrow("shadowed");
    expect(f.calls).toMatchObject({ create: 1, snapshotDelete: 0 });
  } finally {
    await client.close();
  }
});

test("E2B lost restore acknowledgement recovers exact dispatched selector without create replay", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const snapshot = (await source.snapshot()).snapshot;
    f.modes.loseRestore = true;
    const operation = await snapshot.submitRestore({ networkPolicy: "blocked" });
    await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    const saved = JSON.parse(JSON.stringify(operation.reference));
    const reopened = await f.connect();

    try {
      const recovered = await (await reopened.recover(saved)).wait();
      expect(recovered).toMatchObject({ id: "box_2" });
      expect(f.calls.create).toBe(2);
    } finally {
      await reopened.close();
    }
  } finally {
    await client.close();
  }
});

for (const kind of ["snapshot_capture", "snapshot_restore", "volume_create"] as const) {
  test(`E2B cancellation during ${kind} checkpoint persists no-dispatch recovery`, async () => {
    const f = fixture();
    const controller = new AbortController();
    let armed = false;
    let saved: AdapterRecoveryReference | undefined;

    const client = await f.connect(
      "fixture-key",
      (reference) => {
        if (!armed || reference.kind !== kind || !reference.token) return;
        saved = JSON.parse(JSON.stringify(reference));
        controller.abort();
      },
      "team-fixture",
    );

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      const snapshot = kind === "snapshot_restore" ? (await source.snapshot()).snapshot : undefined;
      armed = true;

      try {
        if (kind === "snapshot_capture")
          await (await source.submitSnapshot(undefined, { signal: controller.signal })).wait();
        else if (kind === "snapshot_restore")
          await (
            await snapshot!.submitRestore(
              { networkPolicy: "blocked" },
              { signal: controller.signal },
            )
          ).wait();
        else await client.volumes.create({ name: "cancelled" }, { signal: controller.signal });
        throw Error("Expected cancellation");
      } catch (error) {
        expect(
          error instanceof WaitAbortedError ||
            (error instanceof SandbarError && error.effect === "none"),
        ).toBe(true);
      }

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(saved?.token).toMatchObject({ state: "rejected" });
      expect(f.calls.capture).toBe(kind === "snapshot_restore" ? 1 : 0);
      expect(f.calls.create).toBe(1);
      expect(f.calls.volumeCreate).toBe(0);
      const before = structuredClone(f.calls);
      const reopened = await f.connect("rotated-key", undefined, "team-fixture");

      try {
        const recovered = await reopened.recover(saved!);
        await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
        await recovered.continue();
        await expect(recovered.wait()).rejects.toMatchObject({
          code: "UNAVAILABLE",
          effect: "none",
        });
        expect(f.calls).toEqual(before);
      } finally {
        await reopened.close();
      }
    } finally {
      await client.close();
    }
  });
}

test("E2B caller-selected borrowed volume deletion does not require creation history", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const original = await client.volumes.create({ name: "selected" });
    const selected = JSON.parse(JSON.stringify(original.reference));
    selected.ownership = "borrowed";
    delete selected.history;
    await client.volumes.delete(selected);
    expect(f.calls.volumeDelete).toBe(1);
  } finally {
    await client.close();
  }
});

for (const rejectCheckpoint of [false, true]) {
  test(
    "e2b volume ACK is persisted and recoverable with fresh credentials: " + rejectCheckpoint,
    async () => {
      const f = fixture();
      let saved: AdapterRecoveryReference | undefined;

      const callback = async (reference: AdapterRecoveryReference) => {
        if (reference.kind !== "volume_create") return;

        const token = z
          .object({ state: z.literal("accepted"), volume: z.object({ nativeId: z.string() }) })
          .safeParse(reference.token);

        if (!token.success) return;
        saved = JSON.parse(JSON.stringify(reference));
        expect(token.data.volume.nativeId).toBeTruthy();

        if (rejectCheckpoint) throw Error("Application persistence failed after ACK");
      };

      const client = await f.connect("first-key", callback, "team-fixture");

      try {
        if (rejectCheckpoint)
          await expect(client.volumes.create({ name: "durable-volume" })).rejects.toBeInstanceOf(
            OutcomeUnknownError,
          );
        else await client.volumes.create({ name: "durable-volume" });
        expect(saved).toBeDefined();
        expect(f.calls.volumeCreate).toBe(1);
        const reopened = await f.connect("rotated-key", undefined, "team-fixture");

        try {
          const volume = await (await reopened.recover(saved!)).wait();
          expect(volume).toMatchObject({ reference: { kind: "volume" } });
          expect(f.calls.volumeCreate).toBe(1);
          const native = [...f.volumes.values()][0]!;
          native.name = "replacement-name";
          await expect((await reopened.recover(saved!)).wait()).rejects.toBeInstanceOf(
            OutcomeUnknownError,
          );
          expect(f.calls.volumeCreate).toBe(1);
        } finally {
          await reopened.close();
        }
      } finally {
        await client.close();
      }
    },
  );
}

test("E2B restore accepts empty mount and resource maps without native overrides", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const captured = await source.snapshot();

    const restored = await captured.snapshot.restore({
      networkPolicy: "blocked",
      mounts: {},
      resources: {},
    });

    expect(restored.id).not.toBe(source.id);
    expect(f.createRequests.at(-1)).toEqual({
      templateId: `snap_one:${captured.snapshot.reference.generation}`,
      allowInternetAccess: false,
    });
    expect(f.boxes.get(restored.id)?.volumeMounts).toEqual([]);
    await expect(
      captured.snapshot.restore({ networkPolicy: "blocked", resources: { vcpu: 1 } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", effect: "none" });
    expect(f.calls.create).toBe(2);
  } finally {
    await client.close();
  }
});

for (const kind of ["snapshot", "volume"] as const) {
  for (const barrier of ["reject-before", "abort-before", "reject-after"] as const) {
    test(`E2B ${kind} delete ${barrier} checkpoints custody without replay`, async () => {
      const f = fixture();
      const controller = new AbortController();
      let saved: AdapterRecoveryReference | undefined;

      const client = await f.connect(
        "first-key",
        (reference) => {
          if (reference.kind !== `${kind}_delete`) return;
          const token = z.object({ accepted: z.boolean() }).safeParse(reference.token);

          if (!token.success) {
            saved = JSON.parse(JSON.stringify(reference));

            return;
          }

          expect(f.calls[kind === "snapshot" ? "snapshotDelete" : "volumeDelete"]).toBe(
            token.data.accepted ? 1 : 0,
          );

          if (barrier === "abort-before" && !token.data.accepted) controller.abort();
          else if (
            (barrier === "reject-before" && !token.data.accepted) ||
            (barrier === "reject-after" && token.data.accepted)
          )
            throw Error("Persistence unavailable");
          saved = JSON.parse(JSON.stringify(reference));
        },
        "team-fixture",
      );

      try {
        const artifact =
          kind === "snapshot"
            ? (
                await (
                  await client.sandboxes.create({ environment: Image.prepared("base") })
                ).snapshot()
              ).snapshot
            : await client.volumes.create({ name: "checkpointed" });

        try {
          const operation = await artifact.submitDelete({ signal: controller.signal });
          await operation.wait({ signal: controller.signal });
          throw Error("Expected interrupted deletion");
        } catch (error) {
          if (barrier === "abort-before")
            expect(error).toMatchObject({ code: "UNAVAILABLE", effect: "none" });
          else expect(error).toBeInstanceOf(OutcomeUnknownError);
        }

        expect(saved).toBeDefined();

        if (barrier === "abort-before")
          expect(saved!.token).toMatchObject({ accepted: false, stage: "rejected" });

        if (barrier === "reject-after")
          expect(saved!.token).toMatchObject({ accepted: false, stage: "uncertain" });
        expect(f.calls[kind === "snapshot" ? "snapshotDelete" : "volumeDelete"]).toBe(
          barrier === "reject-after" ? 1 : 0,
        );
        const reopened = await f.connect("rotated-key", undefined, "team-fixture");

        try {
          const recovered = await reopened.recover(saved!);

          if (barrier === "reject-after") {
            expect(await recovered.wait()).toMatchObject({ deleted: true });
            const legacy = structuredClone(saved!);
            legacy.token = { accepted: false };
            await expect((await reopened.recover(legacy)).wait()).rejects.toBeInstanceOf(
              OutcomeUnknownError,
            );

            if (kind === "volume") {
              f.modes.betaDenied = true;
              await expect((await reopened.recover(saved!)).wait()).rejects.toBeDefined();
            }
          } else await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
          expect(f.calls[kind === "snapshot" ? "snapshotDelete" : "volumeDelete"]).toBe(
            barrier === "reject-after" ? 1 : 0,
          );
        } finally {
          await reopened.close();
        }
      } finally {
        await client.close();
      }
    });
  }
}

for (const kind of ["snapshot", "volume"] as const) {
  test.each([false, true])(
    `E2B ${kind} false delete result verifies absence without replay: present %s`,
    async (present) => {
      const f = fixture();
      const client = await f.connect("fixture-key", undefined, "team-fixture");

      try {
        const artifact =
          kind === "snapshot"
            ? (
                await (
                  await client.sandboxes.create({ environment: Image.prepared("base") })
                ).snapshot()
              ).snapshot
            : await client.volumes.create({ name: "false-delete" });

        f.modes.deleteNotFound = true;
        f.modes.keepDeletedResource = present;
        const operation = await artifact.submitDelete();
        expect(operation.reference.token).toMatchObject({ accepted: false, stage: "uncertain" });
        const reopened = await f.connect("rotated-key", undefined, "team-fixture");

        try {
          const recovered = await reopened.recover(operation.reference);

          if (present) {
            expect(await recovered.observe()).toBeNull();
            await expect((await recovered.continue()).wait()).rejects.toBeInstanceOf(
              OutcomeUnknownError,
            );
          } else expect(await recovered.wait()).toMatchObject({ deleted: true });
          expect(kind === "snapshot" ? f.calls.snapshotDelete : f.calls.volumeDelete).toBe(1);
        } finally {
          await reopened.close();
        }
      } finally {
        await client.close();
      }
    },
  );
}

test.each(["template", "address", "dependencies", "volume"] as const)(
  "E2B cancellation interrupts submit-time delete preflight: %s",
  async (stage) => {
    const f = fixture();
    const controller = new AbortController();
    let saved: AdapterRecoveryReference | undefined;
    let release: (() => void) | undefined;

    const client = await f.connect(
      "fixture-key",
      (reference) => {
        if (reference.kind !== (stage === "volume" ? "volume_delete" : "snapshot_delete")) return;
        saved = structuredClone(reference);

        if (!reference.token)
          f.deleteReadBarrier(
            stage,
            () =>
              new Promise<void>((resolve) => {
                release = resolve;
                setTimeout(() => controller.abort(), 0);
              }),
          );
      },
      "team-fixture",
    );

    try {
      const artifact =
        stage === "volume"
          ? await client.volumes.create({ name: "cancelled-preflight" })
          : (
              await (
                await client.sandboxes.create({ environment: Image.prepared("base") })
              ).snapshot()
            ).snapshot;

      await expect(artifact.delete({ signal: controller.signal })).rejects.toMatchObject({
        code: "UNAVAILABLE",
        effect: "none",
      });
      expect(saved?.token).toMatchObject({
        accepted: false,
        stage: "rejected",
        rejection: "before-dispatch",
        resource: { nativeId: artifact.reference.nativeId },
      });
      const reopened = await f.connect("rotated-key", undefined, "team-fixture");

      try {
        const recovered = await reopened.recover(saved!);
        await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
        await expect((await recovered.continue()).wait()).rejects.toMatchObject({
          code: "UNAVAILABLE",
          effect: "none",
        });
        release?.();
        await Promise.resolve();
        await Promise.resolve();
        expect(f.calls.snapshotDelete + f.calls.volumeDelete).toBe(0);
      } finally {
        await reopened.close();
      }
    } finally {
      release?.();
      await client.close();
    }
  },
);

test("E2B delete cancellation keeps a compact token for large valid references", async () => {
  const f = fixture();
  const controller = new AbortController();
  let saved: AdapterRecoveryReference | undefined;
  let release: (() => void) | undefined;

  const client = await f.connect(
    "fixture-key",
    (reference) => {
      if (reference.kind !== "volume_delete") return;
      saved = structuredClone(reference);

      if (!reference.token)
        f.deleteReadBarrier(
          "volume",
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
              setTimeout(() => controller.abort(), 0);
            }),
        );
    },
    "team-fixture",
  );

  try {
    const volume = await client.volumes.create({ name: "large-reference" });
    const selected = structuredClone(volume.reference);
    selected.history = { padding: "x".repeat(3000) };
    selected.receipt = "x".repeat(4096);
    await expect(
      client.volumes.delete(selected, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
    expect(saved?.token).toMatchObject({
      stage: "rejected",
      resource: { nativeId: selected.nativeId },
    });
    expect(new TextEncoder().encode(JSON.stringify(saved?.token)).length).toBeLessThan(4096);
    const reopened = await f.connect("rotated-key", undefined, "team-fixture");

    try {
      await expect(
        (await (await reopened.recover(saved!)).continue()).wait(),
      ).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
      expect(f.calls.volumeDelete).toBe(0);
    } finally {
      await reopened.close();
    }
  } finally {
    release?.();
    await client.close();
  }
});

for (const status of [400, 401, 403] as const) {
  test(`E2B volume create HTTP ${status} persists rejection without replay`, async () => {
    const f = fixture();
    f.modes.volumeCreateFailure = new E2BVolumeCreateRejected(status);
    let saved: AdapterRecoveryReference | undefined;

    const client = await f.connect("fixture-key", (ref) => {
      saved = JSON.parse(JSON.stringify(ref));
    });

    try {
      await expect(client.volumes.create({ name: "denied" })).rejects.toMatchObject({
        effect: "none",
      });
      expect(saved?.token).toMatchObject({ state: "rejected", rejectionStatus: status });
      const reopened = await f.connect("fixture-key");

      try {
        const operation = await reopened.recover(saved!);
        await operation.continue();
        await expect(operation.wait()).rejects.toMatchObject({
          effect: "none",
          code: status === 400 ? "INVALID_ARGUMENT" : "UNAVAILABLE",
        });
        expect(f.calls.volumeCreate).toBe(1);
        expect(f.volumes.size).toBe(0);
      } finally {
        await reopened.close();
      }
    } finally {
      await client.close();
    }
  });
}

for (const status of [201, 400, 401, 403, 429, 500]) {
  test(`E2B volume transport preserves HTTP ${status} without mutation retry`, async () => {
    let calls = 0;

    // SAFETY: The fixture implements the fetch shape used by the transport.
    const fetcher = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ name: "native-volume" }));

        return Response.json(
          status === 201
            ? { volumeID: "native-id", name: "native-volume" }
            : { message: "native detail" },
          { status },
        );
      },
      { preconnect() {} },
    ) as typeof fetch;

    const transport = createSdkTransport("fixture-key", fetcher);

    if (status === 201)
      expect(await transport.state!.createVolume("native-volume")).toEqual({
        volumeId: "native-id",
        name: "native-volume",
      });
    else {
      try {
        await transport.state!.createVolume("native-volume");
        throw new Error("Expected native failure");
      } catch (error) {
        expect(error instanceof E2BVolumeCreateRejected).toBe([400, 401, 403].includes(status));
      }
    }

    expect(calls).toBe(1);
  });
}

test("E2B ambiguous volume create remains uncertain without replay", async () => {
  const f = fixture();
  f.modes.volumeCreateFailure = new Error("Transport acknowledgement unavailable");
  let saved: AdapterRecoveryReference | undefined;

  const client = await f.connect("fixture-key", (ref) => {
    saved = JSON.parse(JSON.stringify(ref));
  });

  try {
    await expect(client.volumes.create({ name: "uncertain" })).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    expect(saved?.token).toMatchObject({ state: "uncertain" });
    const operation = await client.recover(saved!);
    await operation.continue();
    await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(f.calls.volumeCreate).toBe(1);
  } finally {
    await client.close();
  }
});

test("E2B volume rejection does not wait for body cancellation", async () => {
  // SAFETY: The fixture returns a real Response and implements the used fetch shape.
  const fetcher = Object.assign(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            return new Promise<void>(() => {});
          },
        }),
        { status: 403 },
      ),
    { preconnect() {} },
  ) as typeof fetch;

  const transport = createSdkTransport("fixture-key", fetcher);
  await expect(transport.state!.createVolume("denied")).rejects.toBeInstanceOf(
    E2BVolumeCreateRejected,
  );
});

test("E2B oversized native volume inventory reports capacity instead of a schema error", async () => {
  const values = Array.from({ length: 101 }, (_, i) => ({
    volumeID: `volume-${i}`,
    name: `name-${i}`,
  }));

  // SAFETY: The deterministic fixture implements the transport fetch shape.
  const fetcher = Object.assign(async () => Response.json(values), {
    preconnect() {},
  }) as typeof fetch;

  const native = createSdkTransport("fixture-key", fetcher);
  const f = fixture();
  f.transport.state!.volumes = native.state!.volumes;
  const client = await f.connect();

  try {
    await expect(client.volumes.list({ limit: 100 })).rejects.toMatchObject({
      code: "CAPACITY",
    });
  } finally {
    await client.close();
  }
});
