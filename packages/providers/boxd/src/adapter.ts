import { createHash } from "node:crypto";
import { z } from "zod";
import type { Disk, Machine } from "@boxd-sh/sdk";
import {
  AdapterError,
  AdapterCheckpointError,
  MAX_DIRECTORY_ENTRIES,
  MAX_DIRECTORY_NAME_BYTES,
  assertResourceScope,
  defineAdapter,
  sandboxReference,
  unknownSandboxFacts,
  type AdapterSession,
  type AttemptContext,
  type CreateInput,
  type DestroyInput,
  type ReadContext,
  type ResourceReference,
  type Sandbox,
  type SandboxInfo,
  type SandboxState,
  type VolumeInfo,
} from "sandbar-adapter";
import {
  BOXD_ENDPOINT,
  MAX_BYTES,
  createNativeClient,
  definitiveRejection,
  nativeError,
  type BoxdNativeClient,
  type CallContext,
} from "./transport";

const Configuration = z.strictObject({
  org: z.string().min(1).max(128),
  networkPolicy: z.literal("internet"),
  image: z.string().min(1).max(1024).optional(),
  lifetimeSeconds: z.number().int().min(60).max(3600).default(900),
  volumes: z
    .strictObject({
      sizeBytes: z
        .number()
        .int()
        .min(1024 ** 3)
        .max(1024 ** 4)
        .default(10 * 1024 ** 3),
    })
    .default({ sizeBytes: 10 * 1024 ** 3 }),
});

const Credentials = z.strictObject({ apiKey: z.string().min(1) });

const Id = z.uuid();

const CreateToken = z.strictObject({
  id: Id,
  stage: z.enum(["created", "expiry-installed", "ready"]),
});

const DestroyToken = z.strictObject({
  id: Id,
  mounts: z.array(z.strictObject({ id: Id, path: z.string().max(4096) })).max(128),
});

const DiskToken = z.strictObject({ id: Id });

type Created = z.infer<typeof CreateToken>;

type DestroyPrepared = DestroyInput & { mounts: { id: string; path: string }[] };

function state(native: Machine["status"]): SandboxState {
  switch (native) {
    case "running":
      return "running";
    case "suspended":
    case "hibernated":
      return "suspended";
    case "stopped":
      return "stopped";
    case "pending":
    case "starting":
      return "creating";
    case "destroyed":
      return "destroyed";
    default:
      return "unknown";
  }
}

function nativeName(submission: string): string {
  return `sandbar-${createHash("sha256").update(submission).digest("hex").slice(0, 24)}`;
}

function readContext(signal: AbortSignal, seconds = 30): ReadContext {
  return { signal, deadline: Date.now() + seconds * 1000 };
}

function unavailable(): never {
  throw new AdapterError("NOT_FOUND", "boxd resource is unavailable in the verified org");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native thrown values are normalized and redacted at this error boundary.
function rejection(ctx: AttemptContext, error: unknown) {
  const native = nativeError(error);

  return definitiveRejection(native)
    ? ctx.reject(native.code, native.message)
    : ctx.unknown("boxd response was not confirmed; do not replay");
}

function page<T extends { id: string }>(items: T[], input: { cursor?: string; limit: number }) {
  const cursor = input.cursor === undefined ? 0 : Number(input.cursor);

  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new AdapterError("INVALID_ARGUMENT", "Invalid boxd inventory cursor");
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));

  return {
    items: sorted.slice(cursor, cursor + input.limit),
    nextCursor: cursor + input.limit < sorted.length ? String(cursor + input.limit) : undefined,
  };
}

/** Constructing a definition performs no provider IO. */
export function createBoxdAdapter(
  factory: (apiKey: string) => BoxdNativeClient = createNativeClient,
) {
  return defineAdapter({
    name: "boxd",
    displayName: "boxd",
    config: Configuration,
    credentials: Credentials,
    async connect({ config, credentials, host }) {
      const native = factory(credentials.apiKey);
      host.onClose(() => native.close());

      const [orgs, account, cluster] = await native.run(readContext(host.signal), () =>
        Promise.all([native.orgs.list(), native.account.get(), native.account.config()]),
      );

      if (!account.userId)
        throw new AdapterError("UNSUPPORTED", "boxd currently requires a member API key");
      const org = orgs.find((value) => value.id === config.org || value.slug === config.org);

      if (!org || !org.isDefault || !org.id || !cluster.zone)
        throw new AdapterError("FORBIDDEN", "Select the authenticated default boxd org");

      const scope = {
        authority: { kind: "org", id: org.id },
        partition: { endpoint: BOXD_ENDPOINT, zone: cluster.zone },
      };

      const reference = <K extends "sandbox" | "volume">(
        kind: K,
        id: string,
      ): ResourceReference<K> => ({
        version: 1,
        kind,
        provider: "boxd",
        scope,
        nativeId: Id.parse(id),
        ownership: "borrowed",
      });

      const checkedRef = (ref: ResourceReference, kind: "sandbox" | "volume") => {
        assertResourceScope(ref, { provider: "boxd", scope });

        if (
          ref.kind !== kind ||
          ref.generation !== undefined ||
          !Id.safeParse(ref.nativeId).success
        )
          throw new AdapterError("CONFLICT", "Invalid boxd native resource identity");
      };

      const find = async (id: string, ctx: ReadContext): Promise<Machine | null> => {
        Id.parse(id);

        try {
          const machine = await native.run(ctx, () => native.machines.get(id));

          if (machine.id !== id || machine.org?.id !== org.id)
            throw new AdapterError(
              "CONFLICT",
              "boxd machine identity differs from the verified org",
            );

          return machine;
        } catch (error) {
          if (error instanceof AdapterError && error.code === "NOT_FOUND") return null;
          throw error;
        }
      };

      const requireMachine = async (box: Sandbox, ctx: ReadContext) => {
        if (box.reference) checkedRef(box.reference, "sandbox");

        return (await find(box.id, ctx)) ?? unavailable();
      };

      const disks = (ctx: ReadContext) => native.run(ctx, () => native.disks.list());

      const findDisk = async (ref: ResourceReference, ctx: ReadContext) => {
        checkedRef(ref, "volume");

        return (await disks(ctx)).find((disk) => disk.id === ref.nativeId) ?? unavailable();
      };

      const volumeInfo = (
        disk: Pick<Disk, "id" | "name" | "status">,
        ref: ResourceReference = reference("volume", disk.id),
      ): VolumeInfo => ({
        reference: ref,
        name: disk.name,
        state: disk.status === "ready" || disk.status === "creating" ? disk.status : "unknown",
        filesystem: "block-backed",
        visibility: "unknown",
        durability: "unknown",
        locking: "unknown",
        rename: "unknown",
        conflicts: "unknown",
      });

      const observation = (
        machine: Machine,
        ref = reference("sandbox", machine.id),
      ): SandboxInfo => ({
        reference: ref,
        state: state(machine.status),
        nativeState: machine.status,
        observedAt: new Date().toISOString(),
        ...unknownSandboxFacts(),
        expires: machine.deleteAt
          ? {
              status: "known",
              at: machine.deleteAt.toISOString(),
              action: "destroy",
              scope: "sandbox",
            }
          : { status: "none" },
        idleStop:
          machine.idle.suspendAfter > 0
            ? { status: "known", value: { seconds: machine.idle.suspendAfter, action: "suspend" } }
            : machine.idle.hibernateAfter > 0
              ? {
                  status: "known",
                  value: { seconds: machine.idle.hibernateAfter, action: "suspend" },
                }
              : { status: "known", value: null },
      });

      const mountCheck = async (input: CreateInput, ctx: ReadContext) => {
        if (!input.mounts?.length) return;
        const available = await disks(ctx);

        for (const mount of input.mounts) {
          checkedRef(mount.volume, "volume");

          if (mount.subpath !== undefined)
            throw new AdapterError("UNSUPPORTED", "boxd disks mount whole filesystems only");

          const disk =
            available.find((value) => value.id === mount.volume.nativeId) ?? unavailable();

          if (disk.status !== "ready" || disk.attachments.length)
            throw new AdapterError("CONFLICT", "boxd disk must be ready and unattached");
        }
      };

      const partialCreate = (
        token: Created,
        identity: { operationId: string; submissionId: string },
      ) => ({
        kind: "create" as const,
        status: "partial" as const,
        sandbox: sandboxReference("boxd", scope, token.id, {
          operation: identity.operationId,
          submission: identity.submissionId,
        }),
        setup: {
          expiry: token.stage === "created" ? ("unconfirmed" as const) : ("acknowledged" as const),
          readiness: token.stage === "ready" ? ("acknowledged" as const) : ("unconfirmed" as const),
        },
      });

      const checkpointCreate = async (token: Created, ctx: AttemptContext<Created>) => {
        try {
          await ctx.checkpoint(token);
        } catch (error) {
          if (error instanceof AdapterCheckpointError) error.outcome = partialCreate(token, ctx);
          throw error;
        }
      };

      const createdResult = async (
        token: Created,
        creation: { operation: string; submission: string },
        ctx: ReadContext,
        mounts: import("sandbar-adapter").MountSpec[],
      ) => {
        const machine = await find(token.id, ctx);

        if (!machine || machine.status !== "running") return null;

        if (machine.name !== nativeName(creation.submission))
          throw new AdapterError(
            "CONFLICT",
            "boxd create UUID no longer matches the acknowledged attempt",
          );

        if (mounts.length) {
          const available = await disks(ctx);

          for (const mount of mounts) {
            if (
              !available
                .find((disk) => disk.id === mount.volume.nativeId)
                ?.attachments.some(
                  (attached) =>
                    attached.machineId === token.id &&
                    attached.mountPath === mount.path &&
                    attached.mountMode === (mount.access === "read-only" ? "ro" : "rw"),
                )
            )
              return null;
          }
        }

        return {
          id: token.id,
          reference: sandboxReference("boxd", scope, token.id, creation),
          state: "running" as const,
          mounts,
        };
      };

      const session: AdapterSession<
        CreateInput,
        DestroyPrepared,
        import("sandbar-adapter").ExecInput,
        import("sandbar-adapter").FileWriteInput,
        "argv" | "shell",
        Created
      > = {
        scope,
        defaultImage: { kind: "oci", value: config.image ?? cluster.defaultImage },
        defaultNetworkPolicy: config.networkPolicy,
        supports: {
          images: ["oci"],
          network: ["internet"],
          exec: { commands: ["argv", "shell"], maxOutputBytes: MAX_BYTES },
          fileWrite: { overwrite: true, noClobber: false },
        },
        create: {
          recovery: { version: 1, token: CreateToken },
          async prepare(input, ctx) {
            if (
              input.image.kind !== "oci" ||
              input.networkPolicy !== "internet" ||
              input.region !== undefined ||
              (input.labels && Object.keys(input.labels).length)
            )
              throw new AdapterError(
                "UNSUPPORTED",
                "boxd requires OCI images and internet policy; regions and labels are unavailable",
              );
            await mountCheck(input, ctx);

            return input;
          },
          async submit(input, ctx) {
            let machine: Machine;
            let acknowledged: Created | undefined;

            try {
              machine = await native.run(
                {
                  ...readContext(ctx.signal),
                  onCreate: async (id) => {
                    acknowledged = {
                      id: Id.parse(id),
                      stage: "created",
                    };
                    await checkpointCreate(acknowledged, ctx);
                  },
                },
                () =>
                  native.machines.create({
                    image: input.image.value,
                    name: nativeName(ctx.submissionId),
                    org: org.slug,
                    isolated: true,
                    config: {
                      autoSuspendTimeout: 0,
                      volumes: input.mounts?.map((mount) => ({
                        diskId: mount.volume.nativeId,
                        mountPath: mount.path,
                        readOnly: mount.access === "read-only",
                      })),
                    },
                  }),
              );
            } catch (error) {
              if (error instanceof AdapterCheckpointError) throw error;

              return acknowledged
                ? ctx.unknown(
                    "boxd machine exists; creation metadata could not be verified",
                    partialCreate(acknowledged, ctx),
                  )
                : rejection(ctx, error);
            }

            if (!Id.safeParse(machine.id).success)
              return acknowledged
                ? ctx.unknown(
                    "boxd machine exists; creation metadata has no usable machine UUID",
                    partialCreate(acknowledged, ctx),
                  )
                : ctx.unknown("boxd create acknowledgement has no usable machine UUID");

            const token: Created = acknowledged ?? {
              id: machine.id,
              stage: "created",
            };

            if (!acknowledged) await checkpointCreate(token, ctx);

            if (
              machine.id !== token.id ||
              machine.org?.id !== org.id ||
              machine.name !== nativeName(ctx.submissionId)
            )
              return ctx.unknown(
                "boxd machine exists; creation metadata differs from the acknowledged attempt",
                partialCreate(token, ctx),
              );

            try {
              const expiry = await native.run(readContext(ctx.signal), () =>
                native.machines.setDeleteAfter(token.id, config.lifetimeSeconds),
              );

              if (!expiry)
                return ctx.unknown(
                  "boxd machine exists; expiry was not acknowledged",
                  partialCreate(token, ctx),
                );
              token.stage = "expiry-installed";
            } catch {
              return ctx.unknown(
                "boxd machine exists; expiry response is unconfirmed",
                partialCreate(token, ctx),
              );
            }

            await checkpointCreate(token, ctx);

            try {
              await requireMachine({ id: token.id }, readContext(ctx.signal));
              await native.run({ ...readContext(ctx.signal), maxBytes: 32 }, () =>
                native.machines.waitUntilReady(token.id, { timeout: 30000, pollInterval: 500 }),
              );
              token.stage = "ready";
            } catch {
              return ctx.unknown(
                "boxd machine exists but guest readiness was not confirmed; inspect without replay",
                partialCreate(token, ctx),
              );
            }

            await checkpointCreate(token, ctx);

            try {
              return (
                (await createdResult(
                  token,
                  { operation: ctx.operationId, submission: ctx.submissionId },
                  readContext(ctx.signal),
                  input.mounts ?? [],
                )) ?? ctx.pending(token, { pollAfterMs: 500 })
              );
            } catch {
              return ctx.pending(token);
            }
          },
          async observe(attempt, ctx) {
            const token = CreateToken.safeParse(attempt.token);

            if (!token.success)
              return ctx.unknown(
                "boxd create UUID was not acknowledged; inspect inventory without replay",
              );

            if (token.data.stage !== "ready") {
              try {
                const machine = await find(token.data.id, ctx);

                if (!machine || machine.name !== nativeName(attempt.submissionId))
                  return ctx.unknown(
                    "boxd acknowledged machine is unavailable or no longer matches the attempt",
                    partialCreate(token.data, attempt),
                  );
              } catch {
                return ctx.unknown(
                  "boxd acknowledged machine metadata could not be verified",
                  partialCreate(token.data, attempt),
                );
              }

              return ctx.unknown(
                "boxd machine UUID is known but setup readiness is unconfirmed; inspect without replay",
                partialCreate(token.data, attempt),
              );
            }

            return (
              (await createdResult(
                token.data,
                { operation: attempt.operationId, submission: attempt.submissionId },
                ctx,
                attempt.mounts ?? [],
              )) ?? ctx.pending(token.data, { pollAfterMs: 500 })
            );
          },
        },
        async inspect(box, ctx) {
          const machine = await find(box.id, ctx);

          return machine ? { id: machine.id, ...observation(machine, box.reference) } : null;
        },
        async reopen(ref, ctx) {
          checkedRef(ref, "sandbox");

          return observation(await requireMachine({ id: ref.nativeId, reference: ref }, ctx), ref);
        },
        async inventory(input, ctx) {
          const machines = await native.run(ctx, () => native.machines.list({ org: org.slug }));

          if (machines.some((machine) => machine.org?.id !== org.id))
            throw new AdapterError("CONFLICT", "boxd inventory org mismatch");

          return page(
            machines.map((machine) => ({
              id: machine.id,
              state: machine.status === "running" ? ("running" as const) : ("unknown" as const),
            })),
            input,
          );
        },
        destroy: {
          recovery: { version: 1, token: DestroyToken },
          async prepare(input, ctx) {
            await requireMachine(input, ctx);

            const attached = (await disks(ctx)).filter((disk) =>
              disk.attachments.some((attachment) => attachment.machineId === input.id),
            );

            if (attached.length && input.storage !== "allow-unconfirmed")
              throw new AdapterError(
                "UNSUPPORTED",
                "boxd mount durability is unconfirmed; explicitly allow-unconfirmed to destroy compute",
              );

            const mounts = attached.flatMap((disk) =>
              disk.attachments
                .filter((attachment) => attachment.machineId === input.id)
                .map((attachment) => ({ id: disk.id, path: attachment.mountPath })),
            );

            if (Buffer.byteLength(JSON.stringify({ id: input.id, mounts })) > 4096)
              throw new AdapterError(
                "CAPACITY",
                "boxd retained mount identity exceeds recovery bound",
              );

            return { ...input, mounts };
          },
          async submit(input, ctx) {
            const token = { id: input.id, mounts: input.mounts };
            await ctx.checkpoint(token);

            try {
              await native.run(readContext(ctx.signal), () => native.machines.delete(input.id));
            } catch (error) {
              if (definitiveRejection(error)) return rejection(ctx, error);

              return ctx.pending(token);
            }

            try {
              if (!(await find(input.id, readContext(ctx.signal))))
                return {
                  computeStopped: true,
                  retainedResources: token.mounts.map((mount) => mount.id),
                  mountDurability: token.mounts.map((mount) => ({
                    volume: reference("volume", mount.id),
                    path: mount.path,
                    status: "unconfirmed" as const,
                  })),
                };
            } catch {
              /* Acknowledgement is not authoritative teardown evidence. */
            }

            return ctx.pending(token, { pollAfterMs: 500 });
          },
          async observe(attempt, ctx) {
            const token = DestroyToken.safeParse(attempt.token);

            if (!token.success || token.data.id !== attempt.sandbox?.id)
              return ctx.unknown("boxd deletion UUID is unavailable; do not replay");

            return (await find(token.data.id, ctx))
              ? ctx.pending(token.data, { pollAfterMs: 500 })
              : {
                  computeStopped: true,
                  retainedResources: token.data.mounts.map((mount) => mount.id),
                  mountDurability: token.data.mounts.map((mount) => ({
                    volume: reference("volume", mount.id),
                    path: mount.path,
                    status: "unconfirmed" as const,
                  })),
                };
          },
        },
        exec: {
          async prepare(input, ctx) {
            await requireMachine(input.sandbox, ctx);

            return input;
          },
          async submit(input, ctx) {
            const call: CallContext = {
              signal: ctx.signal,
              deadline: Date.now() + input.deadlineSeconds * 1000,
              maxBytes: input.maxOutputBytes,
              truncated: false,
            };

            try {
              const result = await native.run(call, () =>
                native.machines.exec(input.sandbox.id, {
                  command:
                    input.command.kind === "argv"
                      ? input.command.argv
                      : ["/bin/sh", "-c", input.command.script],
                  cwd: input.cwd,
                  env: input.env,
                  encoding: "buffer",
                }),
              );

              if (call.confirmedExit === undefined)
                return ctx.unknown("boxd command exit was not confirmed; do not replay");

              return {
                exitCode: call.confirmedExit,
                stdout: result.stdout,
                stderr: result.stderr,
                truncated: call.truncated === true,
              };
            } catch (error) {
              return rejection(ctx, error);
            }
          },
        },
        files: {
          maxBytes: MAX_BYTES,
          async read(input, ctx) {
            await requireMachine(input.sandbox, ctx);

            return native.run({ ...ctx, maxBytes: input.maxBytes ?? MAX_BYTES }, () =>
              native.machines.files.download(input.sandbox.id, input.path),
            );
          },
          write: {
            async prepare(input, ctx) {
              if (!input.overwrite)
                throw new AdapterError(
                  "UNSUPPORTED",
                  "boxd does not provide atomic no-clobber uploads",
                );

              if (input.bytes.length > MAX_BYTES)
                throw new AdapterError("CAPACITY", "boxd file exceeds the write bound");
              await requireMachine(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              try {
                const bytesWritten = await native.run(
                  { ...readContext(ctx.signal), uploadBytes: input.bytes.length },
                  () => native.machines.files.upload(input.sandbox.id, input.path, input.bytes),
                );

                return { bytesWritten };
              } catch (error) {
                return rejection(ctx, error);
              }
            },
          },
          async readDirectory(input, ctx) {
            await requireMachine(input.sandbox, ctx);

            const listing = await native.run(ctx, () =>
              native.machines.files.listDir(input.sandbox.id, input.path),
            );

            if (
              listing.truncated ||
              listing.entries.length > MAX_DIRECTORY_ENTRIES ||
              listing.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.name), 0) >
                MAX_DIRECTORY_NAME_BYTES
            )
              throw new AdapterError(
                "CAPACITY",
                "boxd directory listing exceeds the complete-listing bound",
              );

            return {
              entries: listing.entries.map((entry) => ({
                name: entry.name,
                type: entry.permissions.startsWith("l")
                  ? ("symlink" as const)
                  : entry.isDir
                    ? ("directory" as const)
                    : entry.permissions.startsWith("-")
                      ? ("file" as const)
                      : ("unknown" as const),
              })),
              completeness: "complete",
              observedAt: new Date().toISOString(),
            };
          },
          makeDirectory: {
            async prepare(input, ctx) {
              if (input.recursive)
                throw new AdapterError("UNSUPPORTED", "boxd mkdir requires an existing parent");
              await requireMachine(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              try {
                await native.run(readContext(ctx.signal), () =>
                  native.machines.files.mkdir(input.sandbox.id, input.path),
                );

                return { acknowledged: true };
              } catch (error) {
                return rejection(ctx, error);
              }
            },
          },
          remove: {
            async prepare(input, ctx) {
              if (!input.recursive)
                throw new AdapterError(
                  "UNSUPPORTED",
                  "boxd delete is recursive; opt in explicitly",
                );
              await requireMachine(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              try {
                await native.run(readContext(ctx.signal), () =>
                  native.machines.files.delete(input.sandbox.id, input.path),
                );

                return { acknowledged: true };
              } catch (error) {
                return rejection(ctx, error);
              }
            },
          },
        },
        async resourceCapabilities() {
          return {
            restore: {
              status: "unsupported",
              reason:
                "boxd snapshots are latest-only; exact generation restore/delete is not established",
            },
            volumes: {
              status: "supported",
              value: { create: true, inspect: true, list: true, delete: true },
            },
            mounts: {
              status: "supported",
              value: {
                timing: "create",
                access: ["read-only", "read-write"],
                subpaths: false,
                versions: false,
                durability: "unknown",
                compatibility: [],
              },
            },
          };
        },
        async checkMounts(input, ctx) {
          await mountCheck(input, ctx);

          return { status: "supported", value: {} };
        },
        volumeCreate: {
          recovery: { version: 1, token: DiskToken },
          async submit(input, ctx) {
            let disk: Awaited<ReturnType<typeof native.disks.create>>;

            try {
              disk = await native.run(readContext(ctx.signal), () =>
                native.disks.create(input.name, config.volumes.sizeBytes),
              );
            } catch (error) {
              return rejection(ctx, error);
            }

            if (!Id.safeParse(disk.id).success)
              return ctx.unknown("boxd disk UUID was not acknowledged");

            const ref = {
              ...reference("volume", disk.id),
              ownership: "verified-created" as const,
              receipt: JSON.stringify({ operation: ctx.operationId, submission: ctx.submissionId }),
            };

            return volumeInfo(disk, ref);
          },
        },
        async volumeInspect(ref, ctx) {
          return volumeInfo(await findDisk(ref, ctx), ref);
        },
        async volumeList(input, ctx) {
          const result = page(await disks(ctx), input);

          return {
            ...result,
            items: result.items.map((disk) => volumeInfo(disk)),
            coverage: "provider-scope",
          };
        },
        volumeDelete: {
          recovery: { version: 1, token: DiskToken },
          async prepare(ref, ctx) {
            const disk = await findDisk(ref, ctx);

            if (disk.attachments.length)
              throw new AdapterError("CONFLICT", "boxd disk is attached");

            return ref;
          },
          async submit(ref, ctx) {
            const token = { id: ref.nativeId };
            await ctx.checkpoint(token);

            try {
              await native.run(readContext(ctx.signal), () => native.disks.delete(ref.nativeId));

              return { deleted: true, reference: ref };
            } catch (error) {
              return definitiveRejection(error) ? rejection(ctx, error) : ctx.pending(token);
            }
          },
          async observe(attempt, ctx) {
            const token = DiskToken.safeParse(attempt.token);
            const ref = attempt.resource;

            if (!token.success || !ref || token.data.id !== ref.nativeId)
              return ctx.unknown("boxd disk deletion identity unavailable");
            checkedRef(ref, "volume");

            return (await disks(ctx)).some((disk) => disk.id === ref.nativeId)
              ? ctx.pending(token.data)
              : { deleted: true, reference: ref };
          },
        },
        async suspensionCapabilities() {
          return {
            status: "supported",
            value: {
              preserve: "filesystem+memory",
              processes: "preserved",
              connections: "preserved",
            },
          };
        },
        async resumeCapabilities() {
          return {
            status: "supported",
            value: { sourceStates: ["suspended"], setsSessionTimeout: false },
          };
        },
        suspend: {
          async prepare(input, ctx) {
            const machine = await requireMachine(input.sandbox, ctx);

            if (machine.status !== "running")
              throw new AdapterError("CONFLICT", "boxd pause requires a running machine");

            return { ...input, intent: { action: "suspend", preserve: "filesystem+memory" } };
          },
          async submit(input, ctx) {
            try {
              await native.run(readContext(ctx.signal), () =>
                native.machines.pause(input.sandbox.id),
              );
            } catch (error) {
              return rejection(ctx, error);
            }

            let observed: SandboxInfo | null = null;

            try {
              observed = observation(
                await requireMachine(input.sandbox, readContext(ctx.signal)),
                input.sandbox.reference,
              );
            } catch {
              /* Keep confirmed pause acknowledgement. */
            }

            if (observed?.state === "suspended")
              return {
                reference: input.sandbox.reference,
                preserve: "filesystem+memory",
                processes: "preserved",
                connections: "preserved",
                observation: observed,
              };

            return ctx.unknown("boxd pause completed; current state could not be observed", {
              kind: "sandbox_suspend",
              status: "partial",
              reference: input.sandbox.reference,
              acknowledged: true,
              preserve: "filesystem+memory",
              processes: "preserved",
              connections: "preserved",
              observation: observed,
            });
          },
        },
        resume: {
          async prepare(input, ctx) {
            const machine = await requireMachine(input.sandbox, ctx);

            if (!["suspended", "hibernated"].includes(machine.status))
              throw new AdapterError("CONFLICT", "boxd resume requires a sleeping machine");

            return { ...input, intent: { action: "resume" } };
          },
          async submit(input, ctx) {
            // Wake accepts standby and hibernation, avoiding a second mutation or
            // a replay if the sleep depth changed after preparation.
            try {
              await native.run(readContext(ctx.signal), () =>
                native.machines.wake(input.sandbox.id),
              );
            } catch (error) {
              return rejection(ctx, error);
            }

            let observed: SandboxInfo | null = null;

            try {
              observed = observation(
                await requireMachine(input.sandbox, readContext(ctx.signal)),
                input.sandbox.reference,
              );
            } catch {
              /* Keep confirmed wake acknowledgement. */
            }

            if (observed?.state === "running")
              return {
                reference: input.sandbox.reference,
                execution: "resumed",
                executionIdentity: observed.execution,
                connections: "preserved",
                observation: observed,
              };

            return ctx.unknown("boxd wake completed; current state could not be observed", {
              kind: "sandbox_resume",
              status: "partial",
              reference: input.sandbox.reference,
              acknowledged: true,
              execution: "resumed",
              executionIdentity: observed?.execution ?? {
                status: "unknown",
                reason: "Native execution identity is unavailable",
              },
              connections: "preserved",
              observation: observed,
            });
          },
        },
        async renewCapabilities() {
          return {
            status: "supported",
            value: { minSeconds: 60, maxSeconds: 3600, stepSeconds: 1, scope: "sandbox" },
          };
        },
        renew: {
          async prepare(input, ctx) {
            await requireMachine(input.sandbox, ctx);
            const forSeconds = input.forSeconds ?? config.lifetimeSeconds;

            if (forSeconds < 60 || forSeconds > 3600)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                "boxd expiry window must be 60–3600 seconds",
              );

            return { ...input, forSeconds };
          },
          async submit(input, ctx) {
            try {
              await native.run(readContext(ctx.signal), () =>
                native.machines.setDeleteAfter(input.sandbox.id, input.forSeconds),
              );
            } catch (error) {
              return rejection(ctx, error);
            }

            let observed: SandboxInfo | null = null;

            try {
              observed = observation(
                await requireMachine(input.sandbox, readContext(ctx.signal)),
                input.sandbox.reference,
              );
            } catch {
              /* Renewal acknowledgement does not depend on metadata. */
            }

            return {
              reference: input.sandbox.reference,
              requested: { forSeconds: input.forSeconds },
              acknowledged: true,
              observation: observed,
            };
          },
        },
      };

      return session;
    },
  });
}

export const boxdAdapter = createBoxdAdapter();
