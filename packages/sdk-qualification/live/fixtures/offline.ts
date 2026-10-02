import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  defineAdapter,
  SnapshotInfo,
  type VolumeInfo,
  ResourceReference,
  sandboxReference,
  type MountSpec,
} from "sandbar-adapter";
import { Sandbar } from "sandbar-sdk";
import { LedgerStore } from "../../provider-qualification/ledger";

const directories: string[] = [];

export async function disposeFixtures() {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
}

export async function fixture(
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
    unknownRestore?: boolean;
    mountsUnsupported?: boolean;
    volumeFailure?: "rejected" | "uncertain";
    readyAfterInspect?: number;
    readOnly?: "enforced" | "leaky";
    inventoryMisses?: number;
    failCreate?: boolean;
    failDelete?: boolean;
    createDelayMs?: number;
    failClose?: boolean;
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

  const calls = {
    inventory: 0,
    capture: 0,
    restore: 0,
    volumeDelete: 0,
    volumeCreate: 0,
    create: 0,
    destroy: 0,
    peak: 0,
  };

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

  let volumeInspections = 0;

  const adapter = defineAdapter({
    name:
      options.pendingNativeCapture || options.compactCustody
        ? "daytona"
        : "fixture.state.lifecycle",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      host.onClose(() => {
        if (options.failClose) throw Error("Fixture release failed");
      });

      return {
        scope,
        supports: {
          images: ["prepared"],
          network: ["blocked"],
          exec: { commands: ["shell", "argv"], maxOutputBytes: 4096 },
          fileWrite: { overwrite: true, noClobber: true },
        },
        async create(input) {
          calls.create++;

          if (options.failCreate) throw new Error("Fixture setup failed");

          if (options.createDelayMs)
            await new Promise((resolve) => setTimeout(resolve, options.createDelayMs));

          return allocate(new Map(), input.mounts);
        },
        async destroy(box) {
          calls.destroy++;

          if (options.failDelete) throw new Error("Fixture cleanup failed");
          boxes.delete(box.id);

          return { computeStopped: true, retainedResources: [] };
        },
        async inventory() {
          calls.inventory++;

          if (calls.inventory <= (options.inventoryMisses ?? 0)) return { items: [] };

          return { items: [...boxes].map(([id]) => ({ id, state: "running" as const })) };
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
        async snapshotRestore(input, ctx) {
          calls.restore++;

          const restored = allocate(snapshots.get(input.snapshot.nativeId)!.files);

          if (options.aliasRestoredFilesystem)
            boxes.get("box_1")!.files = boxes.get(restored.id)!.files;

          if (options.unknownRestore)
            return ctx.unknown("Mount verification unavailable", {
              kind: "snapshot_restore",
              status: "unknown",
              mounts: [],
              sandbox: sandboxReference(ref("snapshot", "unused").provider, scope, restored.id, {
                operation: ctx.operationId,
                submission: ctx.submissionId,
              }),
            });

          return restored;
        },
        async snapshotDelete(reference) {
          snapshots.delete(reference.nativeId);

          return { deleted: true, reference };
        },
        volumeCreate: {
          recovery: {
            version: 1,
            token: z.union([
              z.object({
                state: z.literal("accepted"),
                volume: ResourceReference.omit({ scope: true }),
              }),
              z.object({ state: z.enum(["uncertain", "rejected"]) }),
            ]),
          },
          async submit(input, ctx) {
            calls.volumeCreate++;

            if (options.volumeFailure) {
              await ctx.checkpoint({ state: options.volumeFailure });

              return options.volumeFailure === "rejected"
                ? ctx.reject("UNAVAILABLE", "Native volume creation rejected (403)")
                : ctx.unknown("Original acknowledgement/status unavailable");
            }

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
          volumeInspections++;
          const info = volumes.get(reference.nativeId)!.info;

          return {
            ...info,
            state:
              options.readyAfterInspect !== undefined &&
              volumeInspections <= options.readyAfterInspect
                ? ("creating" as const)
                : ("ready" as const),
          };
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
            mounts: options.mountsUnsupported
              ? { status: "unsupported", reason: "Immutable mounts unavailable" }
              : {
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
          const script =
            input.command.kind === "shell" ? input.command.script : input.command.argv.join(" ");

          if (script.includes("exit 7"))
            return {
              exitCode: 7,
              stdout: new Uint8Array(),
              stderr: new TextEncoder().encode("fail"),
              truncated: false,
            };

          const stdout = script.includes("QUAL_VALUE")
            ? script.includes("argv-ok") || input.env?.QUAL_VALUE === "argv-ok"
              ? "argument with spaces|argv-ok"
              : "shell-ok"
            : script.includes("PROCESS_ABSENT")
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
            stderr:
              input.command.kind === "argv" && script.includes("QUAL_VALUE")
                ? new TextEncoder().encode("err")
                : new Uint8Array(),
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
          async write(input, ctx) {
            const files = fileMap(input.sandbox.id, input.path);

            if (!input.overwrite && files.has(input.path))
              return ctx.reject("CONFLICT", "Existing path");

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

  const connect = (
    onReference: Parameters<typeof Sandbar.connect>[0]["onReference"],
    onDiagnostic?: Parameters<typeof Sandbar.connect>[0]["onDiagnostic"],
  ) => Sandbar.connect({ adapter, config: {}, credentials: {}, onReference, onDiagnostic });

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
