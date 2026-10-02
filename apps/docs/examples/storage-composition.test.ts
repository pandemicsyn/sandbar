import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter, type MountSpec, type SnapshotProfile } from "sandbar-adapter";
import { Sandbar } from "sandbar-sdk";
import {
  createWriter,
  seedData,
  capturePrivateState,
  reopenStorage,
  restoreWithData,
  restorePrivateOnly,
} from "./storage-composition";

test("compiled storage examples select shared, independent and private state through fresh handles", async () => {
  const scope = { authority: { kind: "account", id: "fixture" }, partition: {} };
  const files = new Map<string, Uint8Array>();
  const boxes = new Map<string, MountSpec[]>();
  const volumeIds: string[] = [];
  const nativeRestores: string[][] = [];

  const profile: SnapshotProfile = {
    id: "cold",
    preserve: "filesystem",
    interruption: "stop",
    sourceStates: ["running"],
    sourceAfter: "unchanged",
    consistency: "unknown",
    connections: "dropped",
    mountHandling: "none",
    restoreExecution: "fresh",
  };

  const reference = (kind: "snapshot" | "volume", nativeId: string) => ({
    version: 1 as const,
    kind,
    provider: "example.storage",
    scope,
    nativeId,
    ownership: "verified-created" as const,
  });

  let captureSource = "";

  const snapshotInfo = () => ({
    reference: reference("snapshot", "snapshot-001"),
    preserve: "filesystem" as const,
    restoreExecution: "fresh" as const,
    consistency: "unknown" as const,
    source: { id: captureSource, class: "container" },
    state: "ready" as const,
    createdAt: null,
    expiration: "unknown" as const,
    excludedPaths: null,
    mounts: [],
    mountHandling: "none" as const,
    restore: {
      networkPolicies: ["daytona-default"],
      resources: false,
      mounts: true,
      independentLifecycle: true,
    },
    dependencies: [],
    nativeDependencies: [],
  });

  const volumeInfo = (id: string) => ({
    reference: reference("volume", id),
    name: id,
    state: "ready" as const,
    filesystem: "object-backed" as const,
    visibility: "immediate" as const,
    durability: "unknown" as const,
    locking: "unknown" as const,
    rename: "unknown" as const,
    conflicts: "unknown" as const,
  });

  const location = (box: string, path: string) => {
    const mount = boxes.get(box)?.find((m) => path.startsWith(m.path + "/"));

    return mount ? `${mount.volume.nativeId}:${path.slice(mount.path.length)}` : `${box}:${path}`;
  };

  const adapter = defineAdapter({
    name: "example.storage",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope,
        defaultImage: { kind: "prepared", value: "report-worker-v1" },
        supports: {
          images: ["prepared"],
          network: ["daytona-default"],
          fileWrite: { overwrite: true, noClobber: true },
        },
        async create(input) {
          const id = `box-${boxes.size + 1}`;
          boxes.set(id, input.mounts ?? []);

          return { id, state: "running" as const, mounts: input.mounts };
        },
        async destroy(box) {
          boxes.delete(box.id);

          return { computeStopped: true, retainedResources: [] };
        },
        async inspect(box) {
          return { id: box.id, state: "running" as const };
        },
        async checkMounts() {
          return { status: "supported" as const, value: {} };
        },
        files: {
          maxBytes: 1048576,
          async write(input) {
            files.set(location(input.sandbox.id, input.path), input.bytes);

            return { bytesWritten: input.bytes.length };
          },
          async read(input) {
            return files.get(location(input.sandbox.id, input.path)) ?? new Uint8Array();
          },
        },
        async snapshotProfiles() {
          return {
            status: "supported" as const,
            value: { profiles: [profile], defaultProfileId: profile.id },
          };
        },
        async snapshotSource() {
          return { state: "running" as const };
        },
        async snapshotInspect() {
          return snapshotInfo();
        },
        async snapshotCapture(input) {
          captureSource = input.sandbox.id;
          files.set(
            "snapshot:/tmp/app-version.txt",
            files.get(location(input.sandbox.id, "/tmp/app-version.txt"))!,
          );

          return {
            snapshot: snapshotInfo(),
            retainedResources: [],
            capture: {
              preserve: "filesystem" as const,
              interruption: "stop" as const,
              restoreExecution: "fresh" as const,
            },
            source: {
              state: "running" as const,
              observedAt: new Date().toISOString(),
              connections: "dropped" as const,
            },
          };
        },
        snapshotRestore: {
          mountInput: "specs" as const,
          async submit(input) {
            const id = `restored-${nativeRestores.length}`;
            boxes.set(id, input.request.mounts ?? []);
            nativeRestores.push((input.request.mounts ?? []).map((m) => m.volume.nativeId));
            files.set(`${id}:/tmp/app-version.txt`, files.get("snapshot:/tmp/app-version.txt")!);

            return { id, state: "running" as const, mounts: input.request.mounts };
          },
        },
        async volumeCreate() {
          const id = `volume-${volumeIds.length + 1}`;
          volumeIds.push(id);

          return volumeInfo(id);
        },
        async volumeInspect(ref) {
          return volumeInfo(ref.nativeId);
        },
      };
    },
  });

  const connect = () => Sandbar.connect({ adapter, config: {}, credentials: {} });
  let client = await connect();

  try {
    const data = await client.volumes.create({ name: "customer-data" });
    const writer = await createWriter(client, data);
    await seedData(writer);
    const base = await client.sandboxes.create({ networkPolicy: "daytona-default" });
    const captured = await capturePrivateState(base);

    const saved = JSON.parse(
      JSON.stringify({ snapshot: captured.snapshot.reference, data: data.reference }),
    );

    await base.destroy();
    await client.close();
    client = await connect();
    const reopened = await reopenStorage(client, saved);
    const shared = await restoreWithData(reopened.snapshot, reopened.data);
    expect(await shared.readTextFile("/data/report.json")).toBe('{"total":7}');
    const emptyData = await client.volumes.create({ name: "experiment-data" });
    const independent = await restoreWithData(reopened.snapshot, emptyData);
    expect(await independent.readTextFile("/data/report.json")).toBe("");
    await independent.writeTextFile("/data/report.json", "experiment", { overwrite: true });
    expect(await shared.readTextFile("/data/report.json")).toBe('{"total":7}');
    const privateOnly = await restorePrivateOnly(reopened.snapshot);

    for (const box of [shared, independent, privateOnly])
      expect(await box.readTextFile("/tmp/app-version.txt")).toBe("v1");
    expect(nativeRestores).toEqual([["volume-1"], ["volume-2"], []]);
    expect(volumeIds).toEqual(["volume-1", "volume-2"]);
  } finally {
    await client.close();
  }
});
