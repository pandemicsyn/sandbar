import { filesystem, directoryValue, statValue } from "./filesystem";
import { createHash } from "node:crypto";
import { z } from "zod";
import { NotFoundError, type Disk, type Machine, type Snapshot } from "@boxd-sh/sdk";
import {
  AdapterError,
  AdapterFilesystemError,
  MAX_DIRECTORY_ENTRIES,
  MAX_DIRECTORY_NAME_BYTES,
  AdapterCheckpointError,
  assertResourceScope,
  defineAdapter,
  resolveSnapshot,
  ResourceMinimums,
  sandboxReference,
  smallestSize,
  unknownSandboxFacts,
  type AdapterSession,
  type AttemptContext,
  type CreateInput,
  type DestroyInput,
  type MountSpec,
  type Fact,
  type ObserveContext,
  type ReadContext,
  type RecoveryAttempt,
  type ResourceReference,
  type Sandbox,
  type SandboxInfo,
  type SandboxResources,
  type SandboxState,
  type SnapshotInfo,
  type SnapshotProfile,
  type VolumeInfo,
} from "@sandbar-sdk/adapter";
import {
  BOXD_ENDPOINT,
  MAX_BYTES,
  createNativeClient,
  definitiveRejection,
  createRejection,
  nativeError,
  type BoxdNativeClient,
  type CallContext,
} from "./transport";

const Configuration = z
  .strictObject({
    org: z.string().min(1).max(128),
    /** Required consent: boxd offers unrestricted egress only. */
    network: z.literal("internet").optional(),
    /** @deprecated Use `network`. */
    networkPolicy: z.literal("internet").optional(),
    image: z.string().min(1).max(1024).optional(),
    preview: z
      .strictObject({
        access: z.enum(["protected", "public"]).default("public"),
        ports: z
          .array(z.number().int().min(1).max(65535))
          .min(1)
          .max(16)
          .refine((ports) => new Set(ports).size === ports.length, "Preview ports must be unique")
          .default([3000]),
      })
      .default({ access: "public", ports: [3000] }),
    /** Minimum size; the smallest boxd size class that meets it is used. */
    resources: ResourceMinimums.optional(),
    /** @deprecated Use `resources: { vcpus }`. */
    size: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional(),
    lifetimeSeconds: z.number().int().min(60).safe().default(900),
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
  })
  .superRefine((value, ctx) => {
    if (value.resources !== undefined && value.size !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["resources"],
        message: "Supply resources or the deprecated size, not both",
      });

    if ((value.network === undefined) === (value.networkPolicy === undefined))
      ctx.addIssue({
        code: "custom",
        path: ["network"],
        message: 'Configure network: "internet"; boxd does not offer blocked egress',
      });
  })
  .transform(({ network, ...value }) => ({
    ...value,
    networkPolicy: network ?? value.networkPolicy ?? "internet",
  }));

/** boxd size classes, smallest first: each vCPU comes with 4 GiB of memory. */
const SIZES = [1, 2, 4, 8].map((vcpus) => ({ vcpus, memoryMiB: vcpus * 4096 }));

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

const SnapshotId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);

const Generation = z.number().int().positive().safe();

/** The deterministic per-attempt name is checkpointed before capture so a lost response can be found. */
const CaptureToken = z.strictObject({
  name: z.string().regex(/^sandbar-snapshot-[0-9a-f]{24}$/),
  source: Id,
  id: SnapshotId.optional(),
  version: Generation.optional(),
});

const SnapshotDeleteToken = z.strictObject({ id: SnapshotId });

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

/** The machine's effective size; boxd reports zeros when a response does not carry it. */
function machineSize(machine: Machine): Fact<SandboxResources> {
  const vcpus = Number(machine.resources?.vcpu);
  const memoryMiB = Math.floor(Number(machine.resources?.memoryBytes) / 1024 ** 2);

  return Number.isFinite(vcpus) && vcpus > 0 && Number.isFinite(memoryMiB) && memoryMiB > 0
    ? { status: "known", value: { vcpus, memoryMiB } }
    : { status: "unknown", reason: "boxd did not report the machine size" };
}

function nativeName(submission: string): string {
  return `sandbar-${createHash("sha256").update(submission).digest("hex").slice(0, 24)}`;
}

/**
 * A boxd snapshot name holds only its latest version, so every capture gets its own name;
 * the reference also pins the captured version as its generation.
 */
function snapshotName(submission: string): string {
  return `sandbar-snapshot-${createHash("sha256").update(submission).digest("hex").slice(0, 24)}`;
}

/** Memory and disk are captured together during a brief pause; the source keeps running. */
const profile: SnapshotProfile = {
  id: "boxd-memory",
  preserve: "filesystem+memory",
  sourceStates: ["running"],
  interruption: "pause",
  sourceAfter: "unchanged",
  // boxd does not document what the pause does to open connections; claim nothing.
  connections: "unknown",
  consistency: "unknown",
  restoreExecution: "resume",
  mountHandling: "none",
};

const snapshotSupport = {
  status: "supported" as const,
  value: { profiles: [profile], defaultProfileId: profile.id },
};

/** Restores replay the captured size and network and cannot attach disks. */
const restoreSupport = {
  networkPolicies: ["internet"],
  resources: false,
  mounts: false,
  independentLifecycle: true,
};

const REPLACED =
  "boxd restored a machine from a different snapshot version; inspect it without replay";

function readContext(signal: AbortSignal, seconds = 30): ReadContext {
  return { signal, deadline: Date.now() + seconds * 1000 };
}

function unavailable(): never {
  throw new AdapterError("NOT_FOUND", "boxd resource is unavailable in the verified org");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native thrown values are normalized and redacted at this error boundary.
function rejection(ctx: AttemptContext, error: unknown) {
  const native = nativeError(error);

  if (error instanceof AdapterFilesystemError && error.details.effect !== "none")
    return ctx.unknown(
      "boxd filesystem operation may have changed the requested path; do not replay",
    );

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
      // Unmet minimums reject before any provider IO.
      const vcpu = config.resources
        ? smallestSize("boxd", SIZES, config.resources).vcpus
        : config.size;

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
        resources: machineSize(machine),
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

      const partialRestore = (
        token: Created,
        identity: { operationId: string; submissionId: string },
      ) => ({
        kind: "snapshot_restore" as const,
        status: "unknown" as const,
        sandbox: sandboxReference("boxd", scope, token.id, {
          operation: identity.operationId,
          submission: identity.submissionId,
        }),
        mounts: [],
      });

      const checkpointCreate = async (
        token: Created,
        ctx: AttemptContext<Created>,
        partial: typeof partialCreate | typeof partialRestore = partialCreate,
      ) => {
        try {
          await ctx.checkpoint(token);
        } catch (error) {
          if (error instanceof AdapterCheckpointError) error.outcome = partial(token, ctx);
          throw error;
        }
      };

      const createdResult = async (
        token: Created,
        creation: { operation: string; submission: string },
        ctx: ReadContext,
        mounts: MountSpec[],
        expected?: { id: string; version: number },
      ) => {
        const machine = await find(token.id, ctx);

        if (!machine || machine.status !== "running") return null;

        if (config.preview.access === "public" && machine.botProtection !== false) return null;

        if (machine.name !== nativeName(creation.submission))
          throw new AdapterError(
            "CONFLICT",
            "boxd create UUID no longer matches the acknowledged attempt",
          );

        // boxd restores by snapshot id, which always names its latest version.
        if (
          expected &&
          (machine.source?.kind !== "snapshot" ||
            machine.source.id !== expected.id ||
            machine.source.version !== expected.version)
        )
          return "replaced" as const;

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

      /** Create from an image, or restore an exact snapshot generation; then expiry and readiness. */
      const launch = async (
        source:
          | { image: string; mounts: MountSpec[] }
          | { snapshot: { id: string; version: number } },
        ctx: AttemptContext<Created>,
      ) => {
        const mounts = "image" in source ? source.mounts : [];
        const expected = "snapshot" in source ? source.snapshot : undefined;
        const partial = expected ? partialRestore : partialCreate;

        const proxies =
          config.preview.access === "public"
            ? config.preview.ports.map((port) => ({ name: `sandbar-${port}`, port }))
            : undefined;

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
                await checkpointCreate(acknowledged, ctx, partial);
              },
            },
            () =>
              native.machines.create(
                "image" in source
                  ? {
                      image: source.image,
                      name: nativeName(ctx.submissionId),
                      org: org.slug,
                      isolated: true,
                      config: {
                        vcpu,
                        proxies,
                        autoSuspendTimeout: 0,
                        volumes: source.mounts.map((mount) => ({
                          diskId: mount.volume.nativeId,
                          mountPath: mount.path,
                          readOnly: mount.access === "read-only",
                        })),
                      },
                    }
                  : {
                      // A restore replays the captured size; boxd refuses sizing here.
                      fromSnapshot: source.snapshot.id,
                      name: nativeName(ctx.submissionId),
                      org: org.slug,
                      isolated: true,
                      config: { proxies, autoSuspendTimeout: 0 },
                    },
              ),
          );
        } catch (error) {
          if (error instanceof AdapterCheckpointError) throw error;

          if (acknowledged)
            return ctx.unknown(
              "boxd machine exists; creation metadata could not be verified",
              partial(acknowledged, ctx),
            );
          const rejected = createRejection(error, [credentials.apiKey]);

          return rejected
            ? ctx.reject(rejected.code, rejected.message)
            : ctx.unknown("boxd create response was not confirmed; do not replay");
        }

        if (!Id.safeParse(machine.id).success)
          return acknowledged
            ? ctx.unknown(
                "boxd machine exists; creation metadata has no usable machine UUID",
                partial(acknowledged, ctx),
              )
            : ctx.unknown("boxd create acknowledgement has no usable machine UUID");

        const token: Created = acknowledged ?? {
          id: machine.id,
          stage: "created",
        };

        if (!acknowledged) await checkpointCreate(token, ctx, partial);

        if (
          machine.id !== token.id ||
          machine.org?.id !== org.id ||
          machine.name !== nativeName(ctx.submissionId)
        )
          return ctx.unknown(
            "boxd machine exists; creation metadata differs from the acknowledged attempt",
            partial(token, ctx),
          );

        try {
          const expiry = await native.run(readContext(ctx.signal), () =>
            native.machines.setDeleteAfter(token.id, config.lifetimeSeconds),
          );

          if (!expiry)
            return ctx.unknown(
              "boxd machine exists; expiry was not acknowledged",
              partial(token, ctx),
            );
          token.stage = "expiry-installed";
        } catch {
          return ctx.unknown(
            "boxd machine exists; expiry response is unconfirmed",
            partial(token, ctx),
          );
        }

        await checkpointCreate(token, ctx, partial);

        try {
          await requireMachine({ id: token.id }, readContext(ctx.signal));

          if (config.preview.access === "public")
            await native.run(readContext(ctx.signal), () =>
              native.machines.setBotProtection(token.id, false),
            );
          await native.run({ ...readContext(ctx.signal), maxBytes: 32 }, () =>
            native.machines.waitUntilReady(token.id, { timeout: 30000, pollInterval: 500 }),
          );
          token.stage = "ready";
        } catch {
          return ctx.unknown(
            "boxd machine exists but guest readiness was not confirmed; inspect without replay",
            partial(token, ctx),
          );
        }

        await checkpointCreate(token, ctx, partial);

        try {
          const result = await createdResult(
            token,
            { operation: ctx.operationId, submission: ctx.submissionId },
            readContext(ctx.signal),
            mounts,
            expected,
          );

          return result === "replaced"
            ? ctx.unknown(REPLACED, partial(token, ctx))
            : (result ?? ctx.pending(token, { pollAfterMs: 500 }));
        } catch {
          return ctx.pending(token);
        }
      };

      const observeLaunch = async (
        attempt: RecoveryAttempt,
        ctx: ObserveContext<Created>,
        expected?: { id: string; version: number },
      ) => {
        const partial = expected ? partialRestore : partialCreate;
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
                partial(token.data, attempt),
              );
          } catch {
            return ctx.unknown(
              "boxd acknowledged machine metadata could not be verified",
              partial(token.data, attempt),
            );
          }

          return ctx.unknown(
            "boxd machine UUID is known but setup readiness is unconfirmed; inspect without replay",
            partial(token.data, attempt),
          );
        }

        const result = await createdResult(
          token.data,
          { operation: attempt.operationId, submission: attempt.submissionId },
          ctx,
          attempt.mounts ?? [],
          expected,
        );

        return result === "replaced"
          ? ctx.unknown(REPLACED, partial(token.data, attempt))
          : (result ?? ctx.pending(token.data, { pollAfterMs: 500 }));
      };

      const snapshotRef = (
        id: string,
        version: number | null,
        ownership: ResourceReference["ownership"] = "unknown",
      ): ResourceReference<"snapshot"> => {
        const ref: ResourceReference<"snapshot"> = {
          version: 1,
          kind: "snapshot",
          provider: "boxd",
          scope,
          nativeId: SnapshotId.parse(id),
          ownership,
        };

        if (version !== null) ref.generation = String(version);

        return ref;
      };

      /** The captured version a reference pins; restore and delete require one. */
      const checkedSnapshot = (ref: ResourceReference, pinned = true) => {
        assertResourceScope(ref, { provider: "boxd", scope });
        const generation = ref.generation === undefined ? undefined : Number(ref.generation);

        if (
          ref.kind !== "snapshot" ||
          !SnapshotId.safeParse(ref.nativeId).success ||
          (generation === undefined
            ? pinned
            : !Generation.safeParse(generation).success || String(generation) !== ref.generation)
        )
          throw new AdapterError("CONFLICT", "Invalid boxd snapshot identity");

        return generation;
      };

      /** A snapshot by id or name, or null once boxd no longer has it. */
      const findSnapshot = async (key: string, ctx: ReadContext): Promise<Snapshot | null> => {
        try {
          return await native.run(ctx, () => native.snapshots.get(key, { org: org.slug }));
        } catch (error) {
          if (
            error instanceof NotFoundError ||
            (error instanceof AdapterError && error.code === "NOT_FOUND")
          )
            return null;
          throw error;
        }
      };

      /** The snapshot at the referenced version; boxd keeps only the latest one per name. */
      const pinnedSnapshot = async (ref: ResourceReference, ctx: ReadContext) => {
        const version = checkedSnapshot(ref);
        const snapshot = await findSnapshot(ref.nativeId, ctx);

        if (!snapshot) throw new AdapterError("NOT_FOUND", "boxd snapshot is unavailable");

        if (snapshot.id !== ref.nativeId)
          throw new AdapterError("CONFLICT", "boxd returned a different snapshot identity");

        if (snapshot.status !== "ready" || snapshot.version !== version)
          throw new AdapterError(
            "CONFLICT",
            snapshot.status === "ready"
              ? "boxd snapshot was saved again; the referenced version no longer exists"
              : `boxd snapshot is ${snapshot.status}`,
          );

        return { snapshot, version };
      };

      const snapshotInfo = (
        snapshot: Snapshot,
        ref: ResourceReference = snapshotRef(snapshot.id, snapshot.version),
        source: string | null = null,
      ): SnapshotInfo => ({
        reference: ref,
        preserve: "filesystem+memory",
        restoreExecution: "resume",
        consistency: "unknown",
        source: source === null ? null : { id: source, class: "boxd-machine" },
        state:
          snapshot.status === "ready"
            ? "ready"
            : snapshot.status === "pending"
              ? "creating"
              : "unknown",
        // updatedAt moves with each saved version; this name only ever holds one.
        createdAt: snapshot.updatedAt?.toISOString() ?? null,
        expiration: "unknown",
        excludedPaths: null,
        mounts: [],
        mountHandling: ref.ownership === "verified-created" ? "none" : "unknown",
        restore: restoreSupport,
        dependencies: [],
        nativeDependencies: null,
      });

      const captureOutcome = (token: z.infer<typeof CaptureToken>) => ({
        kind: "snapshot_capture" as const,
        status: "unknown" as const,
        snapshot:
          token.id === undefined
            ? undefined
            : snapshotRef(token.id, token.version ?? null, "verified-created"),
      });

      /** Capture finishes when the attempt's name reports its captured version ready. */
      const captureResult = async (
        token: z.infer<typeof CaptureToken>,
        ctx: ReadContext,
        settle: Pick<ObserveContext<z.infer<typeof CaptureToken>>, "pending" | "unknown">,
      ) => {
        const snapshot = await findSnapshot(token.id ?? token.name, ctx);

        if (!snapshot)
          return settle.unknown(
            token.id === undefined
              ? "boxd snapshot response was lost and no snapshot carries this attempt; list snapshots without replay"
              : "boxd snapshot disappeared before it completed",
            captureOutcome(token),
          );

        if (snapshot.name !== token.name || (token.id !== undefined && snapshot.id !== token.id))
          return settle.unknown(
            "boxd snapshot identity differs from the attempt",
            captureOutcome(token),
          );
        const known = { ...token, id: snapshot.id };
        const expected = token.version ?? 1;

        if (snapshot.status === "failed")
          return settle.unknown(
            "boxd snapshot failed; delete it if it remains",
            captureOutcome(known),
          );

        if ((snapshot.version ?? 0) > expected)
          return settle.unknown(
            "boxd snapshot name was saved again during capture; inspect without replay",
            captureOutcome(known),
          );

        if (snapshot.status !== "ready" || snapshot.version !== expected)
          return settle.pending(known, { pollAfterMs: 500 });

        return {
          snapshot: snapshotInfo(
            snapshot,
            snapshotRef(snapshot.id, expected, "verified-created"),
            token.source,
          ),
          capture: {
            preserve: profile.preserve,
            interruption: profile.interruption,
            restoreExecution: profile.restoreExecution,
          },
          source: { state: "running" as const, connections: profile.connections },
          retainedResources: [snapshotRef(snapshot.id, expected, "verified-created")],
        };
      };

      const session: AdapterSession<
        CreateInput,
        DestroyPrepared,
        import("@sandbar-sdk/adapter").ExecInput,
        import("@sandbar-sdk/adapter").FileWriteInput,
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
          fileWrite: { overwrite: true, noClobber: true },
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
          submit: (input, ctx) =>
            launch({ image: input.image.value, mounts: input.mounts ?? [] }, ctx),
          observe: (attempt, ctx) => observeLaunch(attempt, ctx),
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
        async sandboxList(input, ctx) {
          const machines = await native.run(ctx, () => native.machines.list({ org: org.slug }));

          if (machines.some((machine) => machine.org?.id !== org.id))
            throw new AdapterError("CONFLICT", "boxd inventory org mismatch");
          const listed = page(machines, input);

          return {
            // boxd lists every machine in the verified org and records no Sandbar creation
            // correlation, so listed references claim no ownership.
            coverage: "provider-scope" as const,
            items: listed.items.map((machine) => ({
              id: machine.id,
              state: state(machine.status),
              reference: Id.safeParse(machine.id).success
                ? { ...reference("sandbox", machine.id), ownership: "unknown" as const }
                : null,
            })),
            nextCursor: listed.nextCursor,
          };
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
          finiteStdin: "bytes",
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
              stdin: input.stdin,
              output: { stdout: [], stderr: [] },
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
              if (call.confirmedExit !== undefined)
                return {
                  exitCode: call.confirmedExit,
                  stdout: Buffer.concat(call.output?.stdout ?? []),
                  stderr: Buffer.concat(call.output?.stderr ?? []),
                  truncated: true,
                };

              return rejection(ctx, error);
            }
          },
        },
        async preview(input, ctx) {
          if (config.preview.access !== "public")
            throw new AdapterError(
              "UNSUPPORTED",
              "boxd preview.access protected keeps browser protection on and exposes no preview routes; use preview.access public, the default",
            );

          if (!config.preview.ports.includes(input.port))
            throw new AdapterError(
              "UNSUPPORTED",
              "This preview port was not configured at adapter setup",
            );
          const machine = await requireMachine(input.sandbox, ctx);

          if (machine.status !== "running" || machine.botProtection !== false)
            throw new AdapterError(
              "CONFLICT",
              "boxd preview requires running compute with browser protection disabled",
            );
          const proxies = await native.run(ctx, () => native.machines.proxies.list(machine.id));

          if (proxies.some((route) => route.machineId !== machine.id))
            throw new AdapterError("CONFLICT", "boxd preview machine identity differs");

          const route = proxies.find(
            (route) =>
              route.name === `sandbar-${input.port}` &&
              route.port === input.port &&
              route.portMode === "locked",
          );

          if (!route)
            throw new AdapterError(
              "UNSUPPORTED",
              "Configure a public preview port at adapter setup; no existing pinned route serves this port",
            );

          if (!/^[a-z0-9.-]+$/.test(route.domain) || !route.domain.endsWith(`.${cluster.zone}`))
            throw new AdapterError(
              "CONFLICT",
              "boxd preview domain differs from the verified cluster",
            );

          return { access: "public", url: `https://${route.domain}` };
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
              if (input.bytes.length > MAX_BYTES)
                throw new AdapterError("CAPACITY", "boxd file exceeds the write bound");
              await requireMachine(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              try {
                if (!input.overwrite) {
                  return z
                    .object({ bytesWritten: z.number().int().nonnegative() })
                    .parse(
                      await filesystem(native, input.sandbox.id).run(
                        "write",
                        input.path,
                        "",
                        false,
                        readContext(ctx.signal),
                        "",
                        input.bytes,
                      ),
                    );
                }

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
          async list(input, ctx) {
            await requireMachine(input.sandbox, ctx);

            return directoryValue(
              await filesystem(native, input.sandbox.id).run("list", input.path, "", false, ctx),
            ).entries;
          },
          async stat(input, ctx) {
            await requireMachine(input.sandbox, ctx);

            return statValue(
              await filesystem(native, input.sandbox.id).run(
                "stat",
                input.path,
                "",
                input.followSymlinks,
                ctx,
              ),
            );
          },
          async exists(input, ctx) {
            await requireMachine(input.sandbox, ctx);

            return z
              .object({ exists: z.boolean() })
              .parse(
                await filesystem(native, input.sandbox.id).run(
                  "exists",
                  input.path,
                  "",
                  false,
                  ctx,
                ),
              ).exists;
          },
          async readStream(input, ctx) {
            await requireMachine(input.sandbox, ctx);

            return filesystem(native, input.sandbox.id).read(input.path, ctx);
          },
          async writeStream(input, ctx) {
            await requireMachine(input.sandbox, ctx);

            return filesystem(native, input.sandbox.id).write(
              input.path,
              input.bytes,
              input.overwrite,
              ctx,
            );
          },
          async copy(input, ctx) {
            await requireMachine(input.sandbox, ctx);

            return filesystem(native, input.sandbox.id).transfer(
              "copy",
              input.source,
              input.destination,
              input.overwrite,
              ctx,
            );
          },
          async move(input, ctx) {
            await requireMachine(input.sandbox, ctx);

            return filesystem(native, input.sandbox.id).transfer(
              "move",
              input.source,
              input.destination,
              input.overwrite,
              ctx,
            );
          },
          makeDirectory: {
            async prepare(input, ctx) {
              await requireMachine(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              try {
                await filesystem(native, input.sandbox.id).run(
                  "mkdir",
                  input.path,
                  "",
                  input.recursive,
                  readContext(ctx.signal),
                );

                return { acknowledged: true };
              } catch (error) {
                return rejection(ctx, error);
              }
            },
          },
          remove: {
            async prepare(input, ctx) {
              await requireMachine(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              try {
                await filesystem(native, input.sandbox.id).run(
                  "remove",
                  input.path,
                  "",
                  input.recursive,
                  readContext(ctx.signal),
                );

                return { acknowledged: true };
              } catch (error) {
                return rejection(ctx, error);
              }
            },
          },
        },
        snapshotProfiles: async () => snapshotSupport,
        snapshotCapture: {
          recovery: { version: 1, token: CaptureToken },
          async prepare(input, ctx) {
            const machine = await requireMachine(input.sandbox, ctx);
            const plan = resolveSnapshot(snapshotSupport, input.request, state(machine.status));

            if (plan.status !== "supported") throw new AdapterError("UNSUPPORTED", plan.reason);

            if (input.request.retention?.cleanupAfterSeconds !== undefined)
              throw new AdapterError("UNSUPPORTED", "boxd has no scheduled snapshot deletion");

            // Restores cannot attach disks, and boxd does not say what a capture keeps of them.
            if (
              (await disks(ctx)).some((disk) =>
                disk.attachments.some((attachment) => attachment.machineId === machine.id),
              )
            )
              throw new AdapterError(
                "UNSUPPORTED",
                "boxd snapshots of machines with mounted disks are not supported",
              );

            return input;
          },
          async submit(input, ctx) {
            const token: z.infer<typeof CaptureToken> = {
              name: snapshotName(ctx.submissionId),
              source: Id.parse(input.sandbox.id),
            };

            await ctx.checkpoint(token);

            let created: Awaited<ReturnType<typeof native.snapshots.create>>;

            try {
              created = await native.run(readContext(ctx.signal), () =>
                native.snapshots.create(token.source, token.name),
              );
            } catch (error) {
              return definitiveRejection(error) ? rejection(ctx, error) : ctx.pending(token);
            }

            if (
              created.name !== token.name ||
              !SnapshotId.safeParse(created.id).success ||
              !Generation.safeParse(created.version).success
            )
              return ctx.unknown(
                "boxd snapshot acknowledgement differs from the attempt; do not replay",
                captureOutcome(token),
              );
            const known = { ...token, id: created.id, version: created.version };
            await ctx.checkpoint(known);

            try {
              return await captureResult(known, readContext(ctx.signal), ctx);
            } catch {
              return ctx.pending(known, { pollAfterMs: 500 });
            }
          },
          async observe(attempt, ctx) {
            const token = CaptureToken.safeParse(attempt.token);

            if (!token.success || token.data.source !== attempt.sandbox?.id)
              return ctx.unknown("boxd capture identity is unavailable; do not replay");

            return captureResult(token.data, ctx, ctx);
          },
        },
        snapshotRestore: {
          recovery: { version: 1, token: CreateToken },
          async prepare(input, ctx) {
            if (input.request.resources || input.request.mounts?.length)
              throw new AdapterError(
                "UNSUPPORTED",
                "boxd restores keep the captured size and cannot attach disks",
              );

            if (!restoreSupport.networkPolicies.includes(input.request.networkPolicy))
              throw new AdapterError("UNSUPPORTED", "boxd restores require internet policy");
            await pinnedSnapshot(input.snapshot, ctx);

            return input;
          },
          submit: (input, ctx) =>
            launch(
              {
                snapshot: {
                  id: input.snapshot.nativeId,
                  version: checkedSnapshot(input.snapshot)!,
                },
              },
              ctx,
            ),
          async observe(attempt, ctx) {
            if (!attempt.resource)
              return ctx.unknown("boxd restore snapshot identity is unavailable; do not replay");

            return observeLaunch(attempt, ctx, {
              id: attempt.resource.nativeId,
              version: checkedSnapshot(attempt.resource)!,
            });
          },
        },
        async snapshotInspect(ref, ctx) {
          const version = checkedSnapshot(ref, false);
          const snapshot = await findSnapshot(ref.nativeId, ctx);

          if (!snapshot) throw new AdapterError("NOT_FOUND", "boxd snapshot is unavailable");

          if (snapshot.id !== ref.nativeId)
            throw new AdapterError("CONFLICT", "boxd returned a different snapshot identity");

          if (version !== undefined && snapshot.version !== null && snapshot.version !== version)
            throw new AdapterError(
              "CONFLICT",
              "boxd snapshot was saved again; the referenced version no longer exists",
            );

          return snapshotInfo(snapshot, ref);
        },
        snapshotListCoverage: "provider-scope",
        async snapshotList(input, ctx) {
          const listed = page(
            await native.run(ctx, () => native.snapshots.list({ org: org.slug })),
            input,
          );

          return {
            // Listed snapshots carry no Sandbar creation evidence.
            items: listed.items.map((snapshot) => snapshotInfo(snapshot)),
            nextCursor: listed.nextCursor,
            coverage: "provider-scope" as const,
          };
        },
        snapshotDelete: {
          recovery: { version: 1, token: SnapshotDeleteToken },
          async prepare(ref, ctx) {
            await pinnedSnapshot(ref, ctx);

            return ref;
          },
          async submit(ref, ctx) {
            const token = { id: ref.nativeId };
            await ctx.checkpoint(token);

            try {
              await native.run(readContext(ctx.signal), () =>
                native.snapshots.delete(token.id, { org: org.slug }),
              );
            } catch (error) {
              return definitiveRejection(error) ? rejection(ctx, error) : ctx.pending(token);
            }

            try {
              if (!(await findSnapshot(token.id, readContext(ctx.signal))))
                return { deleted: true as const, reference: ref };
            } catch {
              /* Deletion is acknowledged; confirmation continues through observation. */
            }

            return ctx.pending(token, { pollAfterMs: 500 });
          },
          async observe(attempt, ctx) {
            const token = SnapshotDeleteToken.safeParse(attempt.token);
            const ref = attempt.resource;

            if (!token.success || !ref || token.data.id !== ref.nativeId)
              return ctx.unknown("boxd snapshot deletion identity is unavailable; do not replay");
            checkedSnapshot(ref);

            return (await findSnapshot(token.data.id, ctx))
              ? ctx.pending(token.data, { pollAfterMs: 500 })
              : { deleted: true as const, reference: ref };
          },
        },
        async resourceCapabilities() {
          return {
            restore: { status: "supported", value: restoreSupport },
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
            value: { minSeconds: 60, stepSeconds: 1, scope: "sandbox" },
          };
        },
        renew: {
          async prepare(input, ctx) {
            await requireMachine(input.sandbox, ctx);
            const forSeconds = input.forSeconds ?? config.lifetimeSeconds;

            if (forSeconds < 60)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                "boxd expiry window must be at least 60 seconds",
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
