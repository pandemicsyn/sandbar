import { z } from "zod";
import { AdapterError } from "./errors";
import type { CreateInput, ReadContext, RuntimeSession, Sandbox } from "./index";

export const ResourceKind = z.enum([
  "sandbox",
  "image",
  "snapshot",
  "volume",
  "volume-version",
  "mount",
  "session",
]);

export type ResourceKind = z.infer<typeof ResourceKind>;

export const ResourceScope = z.strictObject({
  authority: z.strictObject({ kind: z.string().min(1).max(64), id: z.string().min(1).max(512) }),
  partition: z
    .record(z.string().min(1).max(64), z.string().max(2048))
    .refine((value) => Object.keys(value).length <= 32),
});

export const ResourceReference = z.strictObject({
  version: z.literal(1),
  kind: ResourceKind,
  provider: z.string().min(1).max(128),
  scope: ResourceScope,
  nativeId: z.string().min(1).max(512),
  // Required evidence when the adapter's native locator can be reused; never synthesized.
  generation: z.string().min(1).max(512).optional(),
  ownership: z.enum(["borrowed", "verified-created", "unknown"]),
  /** Historical observations retained by the application; never provider authorization. */
  history: z
    .json()
    .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 4096)
    .optional(),
  /** Legacy receipt data; new historical observations use history. */
  receipt: z.string().min(1).max(4096).optional(),
  service: z
    .strictObject({
      url: z.url().refine((value) => {
        const url = new URL(value);

        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === "https:" || url.protocol === "http:")
        );
      }, "Service URL must be an HTTP(S) endpoint without credentials, query, or fragment"),
      projectId: z.string().min(1).max(128),
      connectionId: z.string().min(1).max(128),
    })
    .optional(),
});

export type ResourceReference<K extends ResourceKind = ResourceKind> = Omit<
  z.infer<typeof ResourceReference>,
  "kind"
> & { kind: K };

export function validateResourceReference<K extends ResourceKind>(
  reference: ResourceReference<K>,
): ResourceReference<K> {
  const parsed = ResourceReference.safeParse(reference);

  if (!parsed.success) throw new AdapterError("INVALID_ARGUMENT", "Invalid resource reference");

  // SAFETY: strict parsing preserves the caller's validated resource kind.
  return structuredClone(parsed.data) as ResourceReference<K>;
}

export function assertResourceScope(
  reference: ResourceReference,
  binding: {
    provider: string;
    scope: z.infer<typeof ResourceScope>;
    service?: ResourceReference["service"];
  },
): void {
  const ref = validateResourceReference(reference);
  const scope = ResourceScope.parse(binding.scope);

  const canonical = (value: z.infer<typeof ResourceScope>) =>
    JSON.stringify([
      value.authority.kind,
      value.authority.id,
      Object.entries(value.partition).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]);

  if (
    ref.provider !== binding.provider ||
    canonical(ref.scope) !== canonical(scope) ||
    JSON.stringify(
      ref.service && [ref.service.url, ref.service.projectId, ref.service.connectionId],
    ) !==
      JSON.stringify(
        binding.service && [
          binding.service.url,
          binding.service.projectId,
          binding.service.connectionId,
        ],
      )
  )
    throw new AdapterError("CONFLICT", "Resource belongs to a different verified binding");
}

/** Compare known native identity, including generation; ownership is evidence, not identity. */
export function assertResourceIdentity(
  actual: ResourceReference,
  expected: ResourceReference,
): void {
  const ref = validateResourceReference(actual);
  const target = validateResourceReference(expected);
  assertResourceScope(ref, target);

  if (
    ref.kind !== target.kind ||
    ref.nativeId !== target.nativeId ||
    ref.generation !== target.generation
  )
    throw new AdapterError("CONFLICT", "Resource identity or generation differs");
}

export type Support<T> =
  | { status: "supported"; value: T }
  | { status: "unsupported"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "unknown"; reason: string };

export const SnapshotRequirements = z.strictObject({
  preserve: z.enum(["filesystem", "filesystem+memory"]).optional(),
  maxInterruption: z.enum(["none", "pause", "stop", "terminate"]).optional(),
  sourceAfter: z.enum(["unchanged", "stopped", "destroyed"]).optional(),
  consistency: z.enum(["crash-consistent", "caller-quiesced"]).optional(),
});

export type SnapshotRequirements = z.infer<typeof SnapshotRequirements>;

export const SnapshotRequest = z.strictObject({
  requirements: SnapshotRequirements.optional(),
  consistency: z.literal("caller-quiesced").optional(),
  retention: z
    .strictObject({
      minimumSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      cleanupAfterSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .refine(
      (value) =>
        value.minimumSeconds === undefined ||
        value.cleanupAfterSeconds === undefined ||
        value.cleanupAfterSeconds >= value.minimumSeconds,
    )
    .optional(),
});

export type SnapshotRequest = z.infer<typeof SnapshotRequest>;

export const SandboxState = z.enum([
  "creating",
  "running",
  "stopped",
  "suspended",
  "restoring",
  "destroying",
  "destroyed",
  "unknown",
]);

export type SandboxState = z.infer<typeof SandboxState>;

export const SnapshotProfile = z.strictObject({
  id: z.string().min(1).max(128),
  preserve: z.enum(["filesystem", "filesystem+memory"]),
  sourceStates: z.array(SandboxState).min(1).max(8),
  interruption: z.enum(["none", "pause", "stop", "terminate"]),
  sourceAfter: z.enum(["unchanged", "stopped", "destroyed"]),
  connections: z.enum(["preserved", "dropped", "unknown"]),
  consistency: z.enum(["crash-consistent", "caller-quiesced", "unknown"]),
  restoreExecution: z.enum(["fresh", "resume"]),
  mountHandling: z.enum(["none", "excluded", "unknown"]),
  minimumRetentionSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export type SnapshotProfile = z.infer<typeof SnapshotProfile>;

export const MountSpec = z.strictObject({
  volume: ResourceReference.refine((ref) => ref.kind === "volume"),
  path: z
    .string()
    .min(2)
    .max(4096)
    .refine(
      (path) =>
        path.startsWith("/") &&
        !path.includes("\0") &&
        !path.includes("//") &&
        !path.endsWith("/") &&
        !path.split("/").some((part) => part === "." || part === "..") &&
        !["proc", "sys", "dev", "boot", "etc", "bin", "sbin", "lib", "lib64"].includes(
          path.split("/")[1]!,
        ),
    ),
  access: z.enum(["read-write", "read-only"]).default("read-write"),
  subpath: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (path) =>
        !path.startsWith("/") &&
        !path.includes("\0") &&
        !path.includes("//") &&
        !path.split("/").some((part) => part === "." || part === ".."),
    )
    .optional(),
});

export type MountSpec = z.infer<typeof MountSpec>;

export const VolumeCreateInput = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export type VolumeCreateInput = z.infer<typeof VolumeCreateInput>;

export const VolumeInfo = z.strictObject({
  reference: ResourceReference.refine((ref) => ref.kind === "volume"),
  name: z.string().min(1).max(128),
  state: z.enum(["creating", "ready", "deleting", "unknown"]),
  filesystem: z.literal("object-backed"),
  visibility: z.enum(["immediate", "unknown"]),
  durability: z.literal("unknown"),
  locking: z.literal("unknown"),
  rename: z.literal("unknown"),
  conflicts: z.enum(["last-writer-wins", "unknown"]),
});

export type VolumeInfo = z.infer<typeof VolumeInfo>;

export const RestoreRequest = z.strictObject({
  networkPolicy: z.string().min(1).max(128),
  requireIndependentLifecycle: z.boolean().optional(),
  resources: z
    .strictObject({
      vcpu: z.number().int().positive().optional(),
      memoryMiB: z.number().int().positive().optional(),
      diskMiB: z.number().int().positive().optional(),
    })
    .optional(),
  mounts: z
    .record(
      z.string(),
      z.discriminatedUnion("action", [
        z.strictObject({ action: z.literal("omit") }),
        z.strictObject({ action: z.literal("share") }),
        z.strictObject({ action: z.literal("replace"), mount: MountSpec }),
      ]),
    )
    .optional(),
});

export type RestoreRequest = z.infer<typeof RestoreRequest>;

export const SnapshotInfo = z.strictObject({
  reference: ResourceReference.refine((ref) => ref.kind === "snapshot"),
  preserve: z.enum(["filesystem", "filesystem+memory"]).nullable(),
  restoreExecution: z.enum(["fresh", "resume"]).nullable(),
  consistency: z.enum(["crash-consistent", "caller-quiesced", "unknown"]),
  source: z
    .strictObject({ id: z.string().min(1).max(512), class: z.string().min(1).max(128) })
    .nullable(),
  state: z.enum(["creating", "ready", "deleting", "unknown"]),
  createdAt: z.iso.datetime().nullable(),
  expiration: z.literal("unknown"),
  excludedPaths: z.array(z.string().max(4096)).max(128).nullable(),
  mounts: z.array(MountSpec).max(32),
  mountHandling: z.enum(["none", "unknown", "excluded"]),
  restore: z.strictObject({
    networkPolicies: z.array(z.string()).max(32),
    resources: z.boolean(),
    mounts: z.boolean(),
    independentLifecycle: z.boolean(),
  }),
  dependencies: z.array(ResourceReference).max(128),
  nativeDependencies: z
    .array(z.strictObject({ kind: z.string().min(1).max(128), id: z.string().min(1).max(512) }))
    .max(128)
    .nullable(),
});

export type SnapshotInfo = z.infer<typeof SnapshotInfo>;

export const SnapshotCaptureInput = z.strictObject({
  sandbox: z.strictObject({
    id: z.string().min(1).max(512),
    reference: ResourceReference.extend({ kind: z.literal("sandbox") }).optional(),
  }),
  request: SnapshotRequest,
  expectation: z.strictObject({ profile: SnapshotProfile, sourceState: SandboxState }).optional(),
});

export type SnapshotCaptureInput = z.infer<typeof SnapshotCaptureInput>;

export const SnapshotCaptureValue = z.strictObject({
  snapshot: SnapshotInfo,
  capture: z.strictObject({
    preserve: SnapshotProfile.shape.preserve,
    interruption: SnapshotProfile.shape.interruption,
    restoreExecution: SnapshotProfile.shape.restoreExecution,
  }),
  source: z.strictObject({
    state: SandboxState,
    connections: SnapshotProfile.shape.connections,
    observedAt: z.iso.datetime().optional(),
  }),
  retainedResources: z.array(ResourceReference).max(128),
});

export type SnapshotCaptureValue = z.infer<typeof SnapshotCaptureValue>;

/** Known native results accompanying an incomplete operation; never dispatch authority. */
export const OperationOutcome = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("snapshot_capture"),
      status: z.enum(["partial", "unknown"]),
      snapshot: ResourceReference.extend({ kind: z.literal("snapshot") }).optional(),
      capture: SnapshotCaptureValue.shape.capture.optional(),
      source: SnapshotCaptureValue.shape.source.optional(),
      restart: z
        .strictObject({ status: z.enum(["failed", "uncertain", "not-submitted"]) })
        .optional(),
    })
    .refine(
      (outcome) =>
        (outcome.status !== "partial" && outcome.restart?.status !== "failed") ||
        (!!outcome.snapshot && !!outcome.capture),
      "Confirmed partial capture requires a snapshot identity and capture result",
    )
    .refine(
      (outcome) => outcome.restart?.status !== "failed" || outcome.status === "partial",
      "A definitive restart failure requires a partial capture outcome",
    ),
  z.strictObject({
    kind: z.literal("destroy"),
    status: z.literal("unknown"),
    retainedVolumes: z.array(ResourceReference.extend({ kind: z.literal("volume") })),
  }),
]);

export type OperationOutcome = z.infer<typeof OperationOutcome>;

export const SnapshotRestoreInput = z.strictObject({
  snapshot: ResourceReference.refine((ref) => ref.kind === "snapshot"),
  request: RestoreRequest,
});

export type SnapshotRestoreInput = z.infer<typeof SnapshotRestoreInput>;

export const ArtifactDeletionResult = z.strictObject({
  deleted: z.literal(true),
  reference: ResourceReference,
});

export type ArtifactDeletionResult = z.infer<typeof ArtifactDeletionResult>;

export const MountCapabilities = z.strictObject({
  timing: z.literal("create"),
  access: z
    .array(z.enum(["read-write", "read-only"]))
    .min(1)
    .max(2),
  subpaths: z.boolean(),
  versions: z.literal(false),
  durability: z.literal("unknown"),
  compatibility: z.array(z.string()).max(32),
});

export type MountCapabilities = z.infer<typeof MountCapabilities>;

export const RestoreCapabilities = z.strictObject({
  networkPolicies: z.array(z.string()).max(32),
  resources: z.boolean(),
  mounts: z.boolean(),
  independentLifecycle: z.boolean(),
});

export type RestoreCapabilities = z.infer<typeof RestoreCapabilities>;

export const VolumeCapabilities = z.strictObject({
  create: z.boolean(),
  inspect: z.boolean(),
  list: z.boolean(),
  delete: z.boolean(),
});

export type VolumeCapabilities = z.infer<typeof VolumeCapabilities>;

export const InventoryInput = z.strictObject({
  limit: z.number().int().min(1).max(100),
  cursor: z.string().max(4096).optional(),
});

export type InventoryInput = z.infer<typeof InventoryInput>;

export const DestroyInput = z.strictObject({
  id: z.string().min(1).max(512),
  reference: ResourceReference.extend({ kind: z.literal("sandbox") }).optional(),
  storage: z.enum(["require-durable", "allow-unconfirmed"]).optional(),
});

export type DestroyInput = z.infer<typeof DestroyInput>;

export const MountDurability = z.strictObject({
  volume: ResourceReference,
  path: z.string(),
  status: z.enum(["durable", "unconfirmed"]),
});

export const SnapshotSupport = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("supported"),
    value: z.strictObject({
      profiles: z.array(SnapshotProfile).max(128),
      defaultProfileId: z.string().min(1).max(128),
    }),
  }),
  ...(["unsupported", "unavailable", "unknown"] as const).map((status) =>
    z.strictObject({ status: z.literal(status), reason: z.string().min(1).max(1024) }),
  ),
]);

export type SnapshotPlan = {
  profile: SnapshotProfile;
  sourceState: SandboxState;
  retention: { minimumSeconds: number | null; cleanup: "manual" };
  restoreRestrictions: "unknown";
};

export type CreatePlan = {
  image: CreateInput["image"];
  networkPolicy: string;
  snapshot?: SnapshotPlan;
};

export type StateCapabilities = {
  lifecycle: { reopen: Support<{}>; inspect: Support<{}> };
  snapshots: {
    capture: Support<{ profiles: SnapshotProfile[]; defaultProfileId: string }>;
    restore: Support<RestoreCapabilities>;
    inspect: Support<{}>;
    list: Support<{ coverage: "provider-scope" | "sandbar-managed" }>;
    delete: Support<{}>;
  };
  volumes: Support<VolumeCapabilities>;
  mounts: Support<MountCapabilities>;
  suspension: Support<never>;
};

export const unsupportedState = (): Support<never> => ({
  status: "unsupported",
  reason: "Operation is not implemented",
});

function readBeforeDeadline<T>(
  read: (context: ReadContext) => Promise<T>,
  context: ReadContext,
): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));

      return;
    }

    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      action();
    };

    const onAbort = () => finish(() => reject(signal.reason));

    const timer = setTimeout(
      () => {
        const error = new AdapterError("TIMEOUT", "Adapter capability deadline exceeded");
        controller.abort(error);
        finish(() => reject(error));
      },
      Math.max(0, context.deadline - Date.now()),
    );

    context.signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw signal.reason;

        return read({ ...context, signal });
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}

export async function stateCapabilities(
  session: RuntimeSession,
  target: { sandbox?: Sandbox; create?: CreateInput },
  context: ReadContext,
): Promise<StateCapabilities> {
  const capture =
    session.snapshotCapture && session.snapshotProfiles
      ? SnapshotSupport.parse(
          await readBeforeDeadline(
            (readContext) => session.snapshotProfiles!(structuredClone(target), readContext),
            context,
          ),
        )
      : unsupportedState();

  const resources = session.resourceCapabilities
    ? await readBeforeDeadline(
        (ctx) => session.resourceCapabilities!(structuredClone(target), ctx),
        context,
      )
    : { restore: unsupportedState(), volumes: unsupportedState(), mounts: unsupportedState() };

  const implemented = (yes: boolean): Support<{}> =>
    yes ? { status: "supported", value: {} } : unsupportedState();

  return {
    lifecycle: { reopen: implemented(!!session.reopen), inspect: implemented(!!session.inspect) },
    snapshots: {
      capture,
      restore: session.snapshotRestore ? resources.restore : unsupportedState(),
      inspect: implemented(!!session.snapshotInspect),
      list: session.snapshotList
        ? session.snapshotListCoverage
          ? { status: "supported", value: { coverage: session.snapshotListCoverage } }
          : { status: "unknown", reason: "Snapshot inventory coverage is not established" }
        : unsupportedState(),
      delete: implemented(!!session.snapshotDelete),
    },
    volumes:
      resources.volumes.status === "supported"
        ? {
            status: "supported",
            value: {
              create: resources.volumes.value.create && !!session.volumeCreate,
              inspect: resources.volumes.value.inspect && !!session.volumeInspect,
              list: resources.volumes.value.list && !!session.volumeList,
              delete: resources.volumes.value.delete && !!session.volumeDelete,
            },
          }
        : resources.volumes,
    mounts: session.checkMounts ? resources.mounts : unsupportedState(),
    suspension: unsupportedState(),
  };
}

export function resolveSnapshot(
  support: StateCapabilities["snapshots"]["capture"],
  request: SnapshotRequest,
  state: SandboxState,
): Support<SnapshotPlan> {
  const evidence = SnapshotSupport.safeParse(support);

  if (!evidence.success)
    throw new AdapterError("INVALID_ARGUMENT", "Invalid snapshot capability evidence");
  support = evidence.data;
  const parsed = SnapshotRequest.safeParse(request);

  if (!parsed.success) throw new AdapterError("INVALID_ARGUMENT", "Invalid snapshot requirement");

  if (support.status !== "supported") return support;
  const input = parsed.data;
  const interruption = ["none", "pause", "stop", "terminate"];

  const selected = support.value.profiles.find(
    (profile) => profile.id === support.value.defaultProfileId,
  );

  if (!selected)
    throw new AdapterError("INVALID_ARGUMENT", "Configured snapshot default profile is missing");
  const profile = structuredClone(selected);

  if (input.consistency === "caller-quiesced") profile.consistency = "caller-quiesced";
  const required = input.requirements;

  if (
    (required?.preserve !== undefined && profile.preserve !== required.preserve) ||
    (required?.maxInterruption !== undefined &&
      interruption.indexOf(profile.interruption) > interruption.indexOf(required.maxInterruption))
  )
    return {
      status: "unsupported",
      reason: "Configured default does not satisfy exact capture requirements",
    };

  if (required?.consistency !== undefined && profile.consistency !== required.consistency)
    return {
      status: profile.consistency === "unknown" ? "unknown" : "unsupported",
      reason: "Required capture consistency is not established",
    };

  if (state === "unknown") return { status: "unknown", reason: "Source state is unknown" };

  if (!profile.sourceStates.includes(state))
    return { status: "unavailable", reason: "Configured default cannot capture the source state" };

  if (
    required?.sourceAfter !== undefined &&
    (profile.sourceAfter === "unchanged" ? state : profile.sourceAfter) !==
      (required.sourceAfter === "unchanged" ? state : required.sourceAfter)
  )
    return {
      status: "unsupported",
      reason: "Configured default does not satisfy required source lifecycle",
    };
  const minimum = input.retention?.minimumSeconds ?? 0;

  if (minimum > 0 && profile.minimumRetentionSeconds === undefined)
    return { status: "unknown", reason: "Minimum retention is not established" };

  if (minimum > (profile.minimumRetentionSeconds ?? 0))
    return { status: "unsupported", reason: "Minimum retention cannot be satisfied" };

  return {
    status: "supported",
    value: {
      profile: structuredClone(profile),
      sourceState: state,
      retention: { minimumSeconds: profile.minimumRetentionSeconds ?? null, cleanup: "manual" },
      restoreRestrictions: "unknown",
    },
  };
}

export async function checkCreate(
  session: RuntimeSession,
  input: CreateInput,
  context: ReadContext,
): Promise<Support<CreatePlan>> {
  if (
    !session.supports.images.includes(input.image.kind) ||
    !session.supports.network.includes(input.networkPolicy)
  )
    return { status: "unsupported", reason: "Requested image or network policy is unsupported" };

  if (input.mounts?.length) {
    const mounts = z.array(MountSpec).max(32).parse(input.mounts);

    if (!session.checkMounts)
      return { status: "unsupported", reason: "Create-time mounts are not implemented" };

    const result = await readBeforeDeadline(
      (ctx) => session.checkMounts!({ ...input, mounts }, ctx),
      context,
    );

    if (result.status !== "supported") return result;
  }

  let snapshot: SnapshotPlan | undefined;

  if (input.requirements?.snapshot) {
    const caps = await stateCapabilities(session, { create: input }, context);
    const result = resolveSnapshot(caps.snapshots.capture, input.requirements.snapshot, "running");

    if (result.status !== "supported") return result;
    snapshot = result.value;
  }

  const value: CreatePlan = {
    image: structuredClone(input.image),
    networkPolicy: input.networkPolicy,
  };

  if (snapshot) value.snapshot = snapshot;

  return { status: "supported", value };
}

const AbsentSupport = z.strictObject({
  status: z.literal("unsupported"),
  reason: z.string().min(1).max(1024),
});

const supportSchema = <S extends z.ZodType>(value: S) =>
  z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("supported"), value }),
    ...(["unsupported", "unavailable", "unknown"] as const).map((status) =>
      z.strictObject({ status: z.literal(status), reason: z.string().min(1).max(1024) }),
    ),
  ]);

export const DirectCapabilities = z.strictObject({
  lifecycle: z
    .strictObject({
      reopen: supportSchema(z.strictObject({})),
      inspect: supportSchema(z.strictObject({})),
    })
    .optional(),
  commands: z.array(z.enum(["argv", "shell"])),
  images: z.array(z.enum(["prepared", "oci"])),
  network: z.array(z.string()),
  exec: z.boolean(),
  inspect: z.boolean(),
  inventory: z.boolean(),
  readFile: z.boolean(),
  writeFile: z.boolean(),
  maxOutputBytes: z.number().int().nonnegative(),
  maxFileBytes: z.number().int().nonnegative(),
  observedAt: z.iso.datetime(),
  snapshots: z.strictObject({
    capture: SnapshotSupport,
    restore: supportSchema(RestoreCapabilities),
    inspect: supportSchema(z.strictObject({})),
    list: supportSchema(
      z.strictObject({ coverage: z.enum(["provider-scope", "sandbar-managed"]) }),
    ),
    delete: supportSchema(z.strictObject({})),
  }),
  volumes: supportSchema(VolumeCapabilities),
  mounts: supportSchema(MountCapabilities).optional(),
  suspension: AbsentSupport,
});

export type DirectCapabilities = Omit<
  z.infer<typeof DirectCapabilities>,
  "snapshots" | "volumes" | "suspension"
> &
  Omit<StateCapabilities, "mounts"> & { mounts?: Support<MountCapabilities> };

export const Capabilities = z.strictObject({
  commands: z.array(z.enum(["argv", "shell"])),
  images: z.array(z.enum(["prepared", "oci"])),
  network: z.array(z.string()),
  exec: z.boolean(),
  inspect: z.boolean(),
  inventory: z.boolean(),
  readFile: z.boolean(),
  writeFile: z.boolean(),
  maxOutputBytes: z.number().int().nonnegative(),
  maxFileBytes: z.number().int().nonnegative(),
  observedAt: z.iso.datetime(),
  snapshots: z.strictObject({
    capture: SnapshotSupport,
    restore: AbsentSupport,
    inspect: AbsentSupport,
    list: AbsentSupport,
    delete: AbsentSupport,
  }),
  volumes: AbsentSupport,
  suspension: AbsentSupport,
});

export type Capabilities = z.infer<typeof Capabilities>;

const SnapshotPlanSchema = z.strictObject({
  profile: SnapshotProfile,
  sourceState: SandboxState,
  retention: z.strictObject({
    minimumSeconds: z.number().int().nonnegative().nullable(),
    cleanup: z.literal("manual"),
  }),
  restoreRestrictions: z.literal("unknown"),
});

export const SnapshotCheck = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("supported"), value: SnapshotPlanSchema }),
  ...(["unsupported", "unavailable", "unknown"] as const).map((status) =>
    z.strictObject({ status: z.literal(status), reason: z.string().min(1).max(1024) }),
  ),
]);

export const CreateCheck = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("supported"),
    value: z.strictObject({
      image: z.strictObject({ kind: z.enum(["prepared", "oci"]), value: z.string() }),
      networkPolicy: z.string(),
      snapshot: SnapshotPlanSchema.optional(),
    }),
  }),
  ...(["unsupported", "unavailable", "unknown"] as const).map((status) =>
    z.strictObject({ status: z.literal(status), reason: z.string().min(1).max(1024) }),
  ),
]);

/** Current native observation; unknown deadlines never imply unlimited lifetime. */
export type SandboxReference = ResourceReference<"sandbox">;

export type Fact<T> = { status: "known"; value: T } | { status: "unknown"; reason: string };

export type Deadline =
  | {
      status: "known";
      at: string;
      action: "destroy" | "suspend";
      scope: "running-session" | "sandbox";
    }
  | { status: "none" }
  | { status: "unknown"; reason: string };

export interface SandboxInfo {
  reference: SandboxReference | null;
  state: SandboxState;
  nativeState: string | null;
  observedAt: string;
  expires: Deadline;
  idleStop: Fact<{ seconds: number; action: "stop" | "suspend" } | null>;
  retention: Fact<{ autoDeleteAfterStoppedSeconds: number | null }>;
  execution: Fact<{ nativeId: string }>;
}

/** Native creation selectors only; this reference carries no past observations. */
export function sandboxReference(
  provider: string,
  scope: import("./index").Scope,
  nativeId: string,
  creation: { operation: string; submission: string },
): SandboxReference {
  if (!creation.operation || !creation.submission)
    throw new AdapterError("CONFLICT", "Native sandbox creation correlation is missing");

  return validateResourceReference({
    version: 1,
    kind: "sandbox",
    provider,
    scope,
    nativeId,
    ownership: "verified-created",
    receipt: JSON.stringify(creation),
  });
}

export function assertSandboxReference(actual: SandboxReference, expected: SandboxReference): void {
  assertResourceIdentity(actual, expected);

  if (actual.receipt !== expected.receipt || expected.history !== undefined)
    throw new AdapterError("CONFLICT", "Native sandbox creation correlation differs");
}

export function unknownSandboxFacts() {
  return {
    expires: { status: "unknown" as const, reason: "Native expiry is unavailable" },
    idleStop: { status: "unknown" as const, reason: "Native idle policy is unavailable" },
    retention: { status: "unknown" as const, reason: "Native retention is unavailable" },
    execution: { status: "unknown" as const, reason: "Native execution identity is unavailable" },
  };
}

export function nativeDeadline(
  at: string | null | undefined,
  scope: "running-session" | "sandbox",
): Deadline {
  return at && z.iso.datetime({ offset: true }).safeParse(at).success
    ? { status: "known", at, action: "destroy", scope }
    : { status: "unknown", reason: "Native expiry is absent or invalid" };
}
