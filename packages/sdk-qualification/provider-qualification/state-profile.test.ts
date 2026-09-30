import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  defineAdapter,
  SnapshotInfo,
  type VolumeInfo,
  ResourceReference,
  type MountSpec,
} from "sandbar-adapter";
import { Sandbar } from "sandbar-sdk";
import { LedgerStore } from "./ledger";
import { runState, reconcileState } from "./state-profile";
import { parseReport, renderLiveMatrix } from "./report";
import { assertStateEvidence } from "./state-evidence";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(
  options: {
    dropVolumeWrite?: boolean;
    dropSourceChange?: boolean;
    dropRestoredChange?: boolean;
    aliasRestoredFilesystem?: boolean;
    stoppedSource?: boolean;
    loseCapture?: boolean;
    partialCapture?: boolean;
    compactCustody?: "snapshot" | "failed-snapshot" | "volume";
    pendingNativeCapture?: boolean;
    partialReferenceCapture?: boolean;
    borrowed?: boolean;
    checkpointFailure?: boolean;
    memory?: boolean;
    restoreUnsupported?: boolean;
    readOnly?: "enforced" | "leaky";
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-state-qualification-"));
  directories.push(directory);

  const ledger = new LedgerStore(
    directory,
    crypto.randomUUID(),
    options.checkpointFailure
      ? async (state) => {
          if (state.stateMutations?.some((entry) => entry.creation))
            throw new Error("Custody unavailable");
        }
      : undefined,
  );

  await ledger.initialize("daytona", { kind: "borrowed-prepared", class: "fixture" });
  const scope = { authority: { kind: "fixture", id: "account" }, partition: {} };

  const boxes = new Map<
    string,
    { state: "running" | "stopped"; files: Map<string, Uint8Array>; mounts: MountSpec[] }
  >();

  const snapshots = new Map<string, { info: SnapshotInfo; files: Map<string, Uint8Array> }>();
  const volumes = new Map<string, { info: VolumeInfo; files: Map<string, Uint8Array> }>();
  let index = 0;
  const calls = { capture: 0, restore: 0, volumeDelete: 0, create: 0, peak: 0 };

  const ref = (kind: "snapshot" | "volume", nativeId: string): ResourceReference => ({
    version: 1,
    kind,
    provider:
      options.pendingNativeCapture || options.compactCustody
        ? "daytona"
        : "fixture.state.lifecycle",
    scope,
    nativeId,
    ownership: "verified-created",
  });

  const volume = (id: string): VolumeInfo => ({
    reference: ref("volume", id),
    name: id,
    state: "ready",
    filesystem: "object-backed",
    visibility: "unknown",
    durability: "unknown",
    locking: "unknown",
    rename: "unknown",
    conflicts: "unknown",
  });

  if (options.borrowed)
    volumes.set("borrowed", {
      info: volume("borrowed"),
      files: new Map([["/existing", new Uint8Array([7])]]),
    });

  const fileMap = (id: string, path: string) => {
    const box = boxes.get(id);

    if (!box) throw new Error("Compute missing");
    const mount = box.mounts.find((mount) => path.startsWith(mount.path + "/"));

    return mount ? volumes.get(mount.volume.nativeId)!.files : box.files;
  };

  const allocate = (files: Map<string, Uint8Array>, mounts: MountSpec[] = []) => {
    const id = `box_${++index}`;
    boxes.set(id, {
      state: "running",
      files: new Map([...files].map(([path, bytes]) => [path, bytes.slice()])),
      mounts,
    });
    calls.peak = Math.max(calls.peak, boxes.size);

    return { id, state: "running" as const, mounts };
  };

  const adapter = defineAdapter({
    name:
      options.pendingNativeCapture || options.compactCustody
        ? "daytona"
        : "fixture.state.lifecycle",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope,
        supports: {
          images: ["prepared"],
          network: ["blocked"],
          exec: { commands: ["shell"], maxOutputBytes: 1024 },
          fileWrite: { overwrite: true, noClobber: true },
        },
        async create(input) {
          calls.create++;

          return allocate(new Map(), input.mounts);
        },
        async destroy(box) {
          boxes.delete(box.id);

          return { computeStopped: true, retainedResources: [] };
        },
        async inspect(box) {
          const value = boxes.get(box.id);

          return value ? { id: box.id, state: value.state } : null;
        },
        async snapshotProfiles() {
          return {
            status: "supported",
            value: {
              profiles: [
                {
                  id: "cold",
                  preserve: options.memory ? "filesystem+memory" : "filesystem",
                  sourceStates: ["running", "stopped"],
                  interruption: options.memory ? "pause" : "stop",
                  sourceAfter: options.stoppedSource ? "stopped" : "unchanged",
                  connections: "dropped",
                  consistency: "unknown",
                  mountHandling: "none",
                  restoreExecution: options.memory ? "resume" : "fresh",
                },
              ],
              defaultProfileId: "cold",
            },
          };
        },
        snapshotCapture: {
          recovery: {
            version: 1,
            token: z.union([
              z.strictObject({
                captureState: z.enum(["accepted", "completed"]),
                snapshot: SnapshotInfo,
                restartFailure: z.string(),
              }),
              z.strictObject({
                captureState: z.enum(["completed", "failed"]),
                snapshotId: z.string(),
                sourceId: z.string(),
                snapshot: SnapshotInfo.extend({
                  reference: ResourceReference.omit({ scope: true }),
                }),
              }),
              z.strictObject({ snapshot: ResourceReference }),
            ]),
          },
          async submit(input, ctx) {
            calls.capture++;
            const box = boxes.get(input.sandbox.id)!;
            box.state = "running";

            const info: SnapshotInfo = {
              reference: ref("snapshot", "captured"),
              preserve: options.memory ? "filesystem+memory" : "filesystem",
              source: { id: input.sandbox.id, class: "container" },
              state: "ready",
              createdAt: null,
              expiration: "unknown",
              excludedPaths: [],
              mounts: [],
              mountHandling: "none",
              restore: {
                networkPolicies: ["blocked"],
                resources: false,
                mounts: false,
                independentLifecycle: true,
              },
              dependencies: [],
              restoreExecution: options.memory ? "resume" : "fresh",
              nativeDependencies: [],
              consistency: "unknown",
            };

            snapshots.set("captured", {
              info,
              files: new Map([...box.files].map(([path, bytes]) => [path, bytes.slice()])),
            });

            if (
              options.compactCustody === "snapshot" ||
              options.compactCustody === "failed-snapshot"
            ) {
              const { scope: _scope, ...reference } = info.reference;

              return ctx.pending(
                {
                  captureState:
                    options.compactCustody === "failed-snapshot" ? "failed" : "completed",
                  snapshotId: reference.nativeId,
                  sourceId: input.sandbox.id,
                  snapshot: JSON.parse(JSON.stringify({ ...info, reference })),
                },
                { pollAfterMs: 0 },
              );
            }

            if (options.partialReferenceCapture) {
              info.reference.generation = "fixture-build";
              info.reference.receipt = "fixture-signed-custody";
              boxes.delete(input.sandbox.id);

              return ctx.pending({ snapshot: info.reference }, { pollAfterMs: 0 });
            }

            if (options.loseCapture) return ctx.unknown("Acknowledgement lost");

            if (options.partialCapture || options.pendingNativeCapture)
              return ctx.pending(
                {
                  captureState: options.pendingNativeCapture ? "accepted" : "completed",
                  snapshot: JSON.parse(JSON.stringify(info)),
                  restartFailure: "Source restart rejected",
                },
                { pollAfterMs: 0 },
              );

            return {
              snapshot: info,
              source: { state: "running", connections: "dropped" },
              retainedResources: [info.reference],
              capture: {
                preserve: info.preserve!,
                interruption: info.restoreExecution === "resume" ? "pause" : "stop",
                restoreExecution: info.restoreExecution!,
              },
            };
          },
          async observe(_attempt, ctx) {
            return ctx.unknown("No acknowledged artifact identity");
          },
        },
        async snapshotInspect(reference) {
          return snapshots.get(reference.nativeId)!.info;
        },
        async snapshotRestore(input) {
          calls.restore++;

          const restored = allocate(snapshots.get(input.snapshot.nativeId)!.files);

          if (options.aliasRestoredFilesystem)
            boxes.get("box_1")!.files = boxes.get(restored.id)!.files;

          return restored;
        },
        async snapshotDelete(reference) {
          snapshots.delete(reference.nativeId);

          return { deleted: true, reference };
        },
        volumeCreate: {
          recovery: {
            version: 1,
            token: z.object({
              state: z.literal("accepted"),
              volume: ResourceReference.omit({ scope: true }),
            }),
          },
          async submit(input, ctx) {
            const info = volume(input.name);
            volumes.set(input.name, { info, files: new Map() });

            if (options.compactCustody === "volume") {
              const { scope: _scope, ...reference } = info.reference;

              return ctx.pending({ state: "accepted", volume: reference }, { pollAfterMs: 0 });
            }

            return info;
          },
          async observe(_attempt, ctx) {
            return ctx.unknown("Final result unavailable");
          },
        },
        async volumeInspect(reference) {
          return volumes.get(reference.nativeId)!.info;
        },
        async volumeDelete(reference) {
          calls.volumeDelete++;
          volumes.delete(reference.nativeId);

          return { deleted: true, reference };
        },
        async resourceCapabilities() {
          return {
            restore: options.restoreUnsupported
              ? { status: "unsupported", reason: "Immutable restore unavailable" }
              : {
                  status: "supported",
                  value: {
                    networkPolicies: ["blocked"],
                    resources: false,
                    mounts: false,
                    independentLifecycle: true,
                  },
                },
            volumes: {
              status: "supported",
              value: { create: true, inspect: true, list: false, delete: true },
            },
            mounts: {
              status: "supported",
              value: {
                timing: "create",
                access: options.readOnly ? ["read-write", "read-only"] : ["read-write"],
                subpaths: false,
                versions: false,
                durability: "unknown",
                compatibility: ["container"],
              },
            },
          };
        },
        async checkMounts() {
          return { status: "supported", value: {} };
        },
        async exec(input) {
          const script = input.command.kind === "shell" ? input.command.script : "";

          const stdout = script.includes("PROCESS_ABSENT")
            ? "PROCESS_ABSENT\n"
            : script.includes("READ_ONLY_REJECTED")
              ? options.readOnly === "enforced"
                ? "READ_ONLY_REJECTED\n"
                : "WRITE_ACCEPTED\n"
              : script.includes("s.recv(128)")
                ? `${(input.sandbox.id === "box_1" ? "a" : "b").repeat(32)}:1\n`
                : "";

          return {
            exitCode: 0,
            stdout: new TextEncoder().encode(stdout),
            stderr: new Uint8Array(),
            truncated: false,
          };
        },
        files: {
          maxBytes: 4096,
          async read(input) {
            return (
              fileMap(input.sandbox.id, input.path).get(input.path)?.slice() ?? new Uint8Array()
            );
          },
          async write(input) {
            const files = fileMap(input.sandbox.id, input.path);

            if (!input.overwrite && files.has(input.path)) throw new Error("Existing path");

            const dropWrite =
              (options.dropVolumeWrite && input.path.startsWith("/mnt/")) ||
              (options.dropSourceChange && snapshots.size > 0 && input.sandbox.id === "box_1") ||
              (options.dropRestoredChange && snapshots.size > 0 && input.sandbox.id === "box_2");

            if (!dropWrite) files.set(input.path, input.bytes.slice());

            return { bytesWritten: input.bytes.length };
          },
        },
      };
    },
  });

  const connect = (onReference: Parameters<typeof Sandbar.connect>[0]["onReference"]) =>
    Sandbar.connect({ adapter, config: {}, credentials: {}, onReference });

  return {
    ledger,
    connect,
    boxes,
    snapshots,
    volumes,
    calls,
    borrowed: options.borrowed
      ? { ...ref("volume", "borrowed"), ownership: "borrowed" as const }
      : undefined,
  };
}

const selected = new Set(["snapshot-roundtrip", "volume-persistence"] as const);

test("state workflow records each resource independently, preserves snapshot isolation, and deletes owned storage", async () => {
  const f = await fixture();

  const steps = await runState(f.connect, f.ledger, "base", {
    provider: "daytona",
    network: "blocked",
    selected,
    signal: AbortSignal.timeout(5000),
    cleanupWaitMs: 1000,
  });

  expect(
    steps
      .filter(
        (step) => step.scenario === "snapshot-roundtrip" || step.scenario === "volume-persistence",
      )
      .map((step) => step.status),
  ).toEqual(["passed", "passed"]);
  expect(f.calls.peak).toBe(2);
  expect(f.calls.capture).toBe(1);
  expect(f.calls.restore).toBe(2);
  expect(f.boxes.size).toBe(0);
  expect(f.snapshots.size).toBe(0);
  expect(f.volumes.size).toBe(0);
  const state = await f.ledger.read();
  expect(state.cleanup).toBe("confirmed");
  expect(state.stateMutations?.filter((entry) => entry.creation).length).toBe(7);
  expect(
    state.stateMutations
      ?.filter((entry) => entry.creation)
      .every((entry) => entry.cleanup === "confirmed"),
  ).toBe(true);
});

test.each(["source", "restored"] as const)(
  "a dropped %s post-capture write cannot certify snapshot isolation",
  async (target) => {
    const f = await fixture({
      dropSourceChange: target === "source",
      dropRestoredChange: target === "restored",
    });

    const steps = await runState(f.connect, f.ledger, "base", {
      provider: "daytona",
      network: "blocked",
      selected: new Set(["snapshot-roundtrip"]),
      signal: AbortSignal.timeout(5000),
      cleanupWaitMs: 1000,
    });

    expect(steps.find((step) => step.scenario === "snapshot-roundtrip")?.status).toBe("failed");
    expect(
      steps.find((step) => step.scenario === "snapshot-roundtrip")?.stateEvidence,
    ).toBeUndefined();
  },
);

test("stopped-source profiles are blocked before capture for two-way isolation qualification", async () => {
  const f = await fixture({ stoppedSource: true });

  const steps = await runState(f.connect, f.ledger, "base", {
    provider: "daytona",
    network: "blocked",
    selected: new Set(["snapshot-roundtrip"]),
    signal: AbortSignal.timeout(5000),
    cleanupWaitMs: 1000,
  });

  const result = steps.find((step) => step.scenario === "snapshot-roundtrip");
  expect(result?.status).toBe("unsupported");
  expect(result?.stateEvidence).toBeUndefined();
  expect(f.calls.capture).toBe(0);
  expect(f.calls.restore).toBe(0);
  expect(f.boxes.size).toBe(0);
  expect((await f.ledger.read()).cleanup).toBe("confirmed");
});

test("aliased source and restored filesystems cannot certify snapshot isolation", async () => {
  const f = await fixture({ aliasRestoredFilesystem: true });

  const steps = await runState(f.connect, f.ledger, "base", {
    provider: "daytona",
    network: "blocked",
    selected: new Set(["snapshot-roundtrip"]),
    signal: AbortSignal.timeout(5000),
    cleanupWaitMs: 1000,
  });

  const result = steps.find((step) => step.scenario === "snapshot-roundtrip");
  expect(result?.status).toBe("failed");
  expect(result?.stateEvidence).toBeUndefined();
  expect(f.calls.restore).toBe(1);
  expect(f.boxes.size).toBe(0);
  expect(f.snapshots.size).toBe(0);
  expect((await f.ledger.read()).cleanup).toBe("confirmed");
});

test("a dropped volume write cannot certify persistence", async () => {
  const f = await fixture({ dropVolumeWrite: true });

  const steps = await runState(f.connect, f.ledger, "base", {
    provider: "daytona",
    network: "blocked",
    selected: new Set(["volume-persistence"]),
    signal: AbortSignal.timeout(5000),
    cleanupWaitMs: 1000,
  });

  expect(steps.find((step) => step.scenario === "volume-persistence")?.status).toBe("failed");
  expect(
    steps.find((step) => step.scenario === "volume-persistence")?.stateEvidence,
  ).toBeUndefined();
  expect(f.volumes.size).toBe(0);
});

test("borrowed volume is retained, unrelated bytes survive, and run data uses a unique no-clobber path", async () => {
  const f = await fixture({ borrowed: true });

  const steps = await runState(f.connect, f.ledger, "base", {
    provider: "daytona",
    network: "blocked",
    selected: new Set(["volume-persistence"]),
    signal: AbortSignal.timeout(5000),
    cleanupWaitMs: 1000,
    borrowedVolume: f.borrowed,
  });

  expect(steps.find((step) => step.scenario === "volume-persistence")?.status).toBe("passed");
  expect(f.calls.volumeDelete).toBe(0);
  expect(f.volumes.get("borrowed")?.files.get("/existing")).toEqual(new Uint8Array([7]));
  expect([...f.volumes.get("borrowed")!.files.keys()]).toContain(
    `/mnt/sandbar-state/sandbar_${f.ledger.runId.replaceAll("-", "")}.bin`,
  );
});

test("lost capture remains in custody, preserves its source, blocks new admission, and never repeats capture", async () => {
  const f = await fixture({ loseCapture: true });
  await runState(f.connect, f.ledger, "base", {
    provider: "daytona",
    network: "blocked",
    selected,
    signal: AbortSignal.timeout(5000),
    cleanupWaitMs: 1000,
  });
  expect((await f.ledger.read()).cleanup).toBe("unresolved");
  expect(f.boxes.size).toBe(1);
  expect(f.snapshots.size).toBe(1);
  expect(f.calls.capture).toBe(1);
  await expect(f.ledger.requirePreviousCleanup()).rejects.toThrow("unresolved resources");
  const state = await f.ledger.read();

  const client = await f.connect(async (reference) => {
    await f.ledger.update((value) => ({
      ...value,
      stateMutations: [
        ...(value.stateMutations ?? []),
        { role: value.stateRole ?? "cleanup", reference, creation: false, cleanup: "not-required" },
      ],
    }));
  });

  await reconcileState(client, f.ledger, 100);
  expect(f.calls.capture).toBe(1);
  expect((await f.ledger.read()).stateMutations?.filter((entry) => entry.creation).length).toBe(
    state.stateMutations?.filter((entry) => entry.creation).length,
  );
  await client.close();
});

test("custody checkpoint failure prevents native state allocation", async () => {
  const f = await fixture({ checkpointFailure: true });
  await expect(
    runState(f.connect, f.ledger, "base", {
      provider: "daytona",
      network: "blocked",
      selected,
      signal: AbortSignal.timeout(5000),
      cleanupWaitMs: 1000,
    }),
  ).rejects.toThrow("Custody unavailable");
  expect(f.calls.create).toBe(0);
  expect(f.calls.capture).toBe(0);
  expect(f.volumes.size).toBe(0);
});

test("RAM certification requires process observations and confirmed storage teardown", () => {
  const fs = {
    probe: "snapshot-roundtrip-v3" as const,
    preserve: "filesystem" as const,
    captureMode: "native-default" as const,
    restoreExecution: "fresh" as const,
    sourceProcesses: "ended" as const,
    freshExecution: "verified-missing-guest-process" as const,
    sourceState: "running" as const,
    capturedBytes: true as const,
    newIdentity: true as const,
    metadataInspected: true as const,
    serializedReferenceReopened: true as const,
    freshConnectionAfterSourceDeletion: true as const,
    restoredWriteIndependent: true as const,
    sourceWriteIndependent: true,
    secondRestoreOriginalBytes: true as const,
    memory: "not-applicable" as const,
    ownedArtifactDeleted: true as const,
  };

  expect(() =>
    assertStateEvidence("snapshot-roundtrip", { ...fs, preserve: "filesystem+memory" }),
  ).toThrow("observable independent memory");

  expect(() =>
    assertStateEvidence("snapshot-roundtrip", { ...fs, sourceWriteIndependent: false }),
  ).toThrow("two-way filesystem write isolation");
  expect(() =>
    assertStateEvidence("snapshot-roundtrip", { ...fs, sourceState: "stopped" }),
  ).toThrow("two-way filesystem write isolation");

  const record = {
    schemaVersion: 1,
    provider: "daytona",
    scenario: "snapshot-roundtrip",
    mode: "live",
    status: "passed",
    sdkCommit: "a".repeat(40),
    harnessCommit: "a".repeat(40),
    sdkVersion: "0.1.0",
    nativeVersion: "fixture",
    runtime: "bun 1.3.14",
    platform: "macos",
    timestamp: "2026-09-28T00:00:00Z",
    configuration: {
      imageClass: "prepared",
      network: "blocked-requested",
      regionClass: "fixture",
      stateProbe: "snapshot-roundtrip-v3",
      preserve: "filesystem",
      restoreExecution: "fresh",
      sourceAfter: "running",
    },
    stateEvidence: fs,
    evidenceRef: "fixture/state",
    runCleanup: "confirmed",
  };

  expect(() =>
    parseReport({ schemaVersion: 1, records: [{ ...record, runCleanup: "incomplete" }] }),
  ).toThrow("confirmed resource teardown");
  expect(() =>
    parseReport({
      schemaVersion: 1,
      records: [
        { ...record, configuration: { ...record.configuration, preserve: "filesystem+memory" } },
      ],
    }),
  ).toThrow("preservation differs");
  expect(renderLiveMatrix([parseReport({ schemaVersion: 1, records: [record] })])).toContain(
    "snapshot-roundtrip",
  );
});

for (const enforcement of ["enforced", "leaky"] as const)
  test(`advertised read-only is ${enforcement} through native rejection and byte assertions`, async () => {
    const f = await fixture({ readOnly: enforcement });

    const steps = await runState(f.connect, f.ledger, "base", {
      provider: "daytona",
      network: "blocked",
      selected: new Set(["volume-persistence"]),
      signal: AbortSignal.timeout(5000),
      cleanupWaitMs: 1000,
    });

    const result = steps.find((step) => step.scenario === "volume-persistence");
    expect(result?.status).toBe(enforcement === "enforced" ? "passed" : "failed");
    expect(f.calls.create).toBe(3);
    expect(f.boxes.size).toBe(0);
    expect(f.volumes.size).toBe(0);
  });

test("a filesystem clone cannot certify a claimed memory capture", async () => {
  const f = await fixture({ memory: true });

  const steps = await runState(f.connect, f.ledger, "base", {
    provider: "e2b",
    network: "blocked",
    selected: new Set(["snapshot-roundtrip"]),
    signal: AbortSignal.timeout(5000),
    cleanupWaitMs: 1000,
  });

  expect(steps.find((step) => step.scenario === "snapshot-roundtrip")?.status).toBe("failed");
  expect(
    steps.find((step) => step.scenario === "snapshot-roundtrip")?.stateEvidence,
  ).toBeUndefined();
  expect(f.calls.capture).toBe(1);
  expect(f.snapshots.size).toBe(0);
});

test("partial acknowledged capture retains owned artifact custody and cleans source before storage", async () => {
  const f = await fixture({ partialCapture: true });

  const steps = await runState(f.connect, f.ledger, "base", {
    provider: "daytona",
    network: "blocked",
    selected: new Set(["snapshot-roundtrip"]),
    signal: AbortSignal.timeout(5000),
    cleanupWaitMs: 1000,
  });

  expect(steps.find((step) => step.scenario === "snapshot-roundtrip")?.status).toBe("failed");
  const state = await f.ledger.read();
  expect(
    state.stateMutations?.find((entry) => entry.role === "snapshot/capture")?.resource,
  ).toMatchObject({ kind: "snapshot" });
  expect(state.cleanup).toBe("confirmed");
  expect(f.snapshots.size).toBe(0);
  expect(f.boxes.size).toBe(0);
  expect(f.calls.capture).toBe(1);
});

test("partial E2B-style snapshot reference cleans storage after source expiry without certifying capture", async () => {
  const f = await fixture({ partialReferenceCapture: true, memory: true });

  const steps = await runState(f.connect, f.ledger, "base", {
    provider: "e2b",
    network: "blocked",
    selected: new Set(["snapshot-roundtrip"]),
    signal: AbortSignal.timeout(5000),
    cleanupWaitMs: 1000,
  });

  expect(steps.find((step) => step.scenario === "snapshot-roundtrip")?.status).toBe("failed");
  expect(
    steps.find((step) => step.scenario === "snapshot-roundtrip")?.stateEvidence,
  ).toBeUndefined();
  const state = await f.ledger.read();
  expect(
    state.stateMutations?.find((entry) => entry.role === "snapshot/capture")?.resource,
  ).toMatchObject({
    kind: "snapshot",
    ownership: "verified-created",
    generation: "fixture-build",
    receipt: "fixture-signed-custody",
  });
  expect(state.cleanup).toBe("confirmed");
  expect(f.snapshots.size).toBe(0);
  expect(f.boxes.size).toBe(0);
  expect(f.calls.capture).toBe(1);
});

test("snapshot roundtrip gates unsupported restore before any compute or retained capture", async () => {
  const f = await fixture({ restoreUnsupported: true });

  const steps = await runState(f.connect, f.ledger, "base", {
    provider: "daytona",
    network: "blocked",
    selected: new Set(["snapshot-roundtrip"]),
    signal: AbortSignal.timeout(5000),
  });

  expect(steps.find((s) => s.scenario === "snapshot-roundtrip")).toMatchObject({
    status: "unsupported",
  });
  expect(f.calls).toMatchObject({ create: 0, capture: 0, restore: 0 });
  expect((await f.ledger.read()).cleanup).toBe("not-required");
});

test("acknowledged in-progress Daytona capture retains custody without automatic source or artifact cleanup", async () => {
  const f = await fixture({ pendingNativeCapture: true });

  await runState(f.connect, f.ledger, "base", {
    provider: "daytona",
    network: "blocked",
    selected: new Set(["snapshot-roundtrip"]),
    signal: AbortSignal.timeout(5000),
    cleanupWaitMs: 1000,
  });
  const state = await f.ledger.read();

  expect(
    state.stateMutations?.find((entry) => entry.role === "snapshot/capture")?.resource,
  ).toMatchObject({ kind: "snapshot" });
  expect(state.cleanup).toBe("unresolved");
  expect(f.boxes.size).toBe(1);
  expect(f.snapshots.size).toBe(1);
});

for (const compactCustody of ["snapshot", "failed-snapshot", "volume"] as const) {
  test(`compact Daytona ${compactCustody} custody is retained and cleaned after a lost result`, async () => {
    const f = await fixture({ compactCustody });
    await runState(f.connect, f.ledger, "base", {
      provider: "daytona",
      network: "blocked",
      selected: new Set([
        compactCustody === "volume" ? "volume-persistence" : "snapshot-roundtrip",
      ]),
      signal: AbortSignal.timeout(5000),
      cleanupWaitMs: 1000,
    });
    const state = await f.ledger.read();

    const creation = state.stateMutations?.find(
      (entry) =>
        entry.role === (compactCustody === "volume" ? "volume/create" : "snapshot/capture"),
    );

    expect(creation?.resource).toMatchObject({
      provider: "daytona",
      kind: compactCustody === "volume" ? "volume" : "snapshot",
      ownership: "verified-created",
      scope: { authority: { kind: "fixture", id: "account" } },
    });
    expect(state.cleanup).toBe("confirmed");
    expect(f.snapshots.size).toBe(0);
    expect(f.volumes.size).toBe(0);
    expect(f.boxes.size).toBe(0);
  });
}
