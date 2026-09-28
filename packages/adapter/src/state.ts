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

export const SnapshotRequest = z.strictObject({
  preserve: z.enum(["filesystem", "filesystem+memory"]),
  maxInterruption: z.enum(["none", "pause", "stop", "terminate"]).optional(),
  sourceAfter: z.enum(["unchanged", "stopped", "destroyed"]).optional(),
  consistency: z.enum(["crash-consistent", "caller-quiesced"]).optional(),
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
  preserve: SnapshotRequest.shape.preserve,
  sourceStates: z.array(SandboxState).min(1).max(8),
  interruption: z.enum(["none", "pause", "stop", "terminate"]),
  sourceAfter: z.enum(["unchanged", "stopped", "destroyed"]),
  connections: z.enum(["preserved", "dropped", "unknown"]),
  consistency: z.enum(["crash-consistent", "caller-quiesced"]),
  mountHandling: z.enum(["none", "excluded", "unknown"]),
  minimumRetentionSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export type SnapshotProfile = z.infer<typeof SnapshotProfile>;

export const SnapshotSupport = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("supported"),
    value: z.strictObject({ profiles: z.array(SnapshotProfile).max(128) }),
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
  snapshots: {
    capture: Support<{ profiles: SnapshotProfile[] }>;
    restore: Support<never>;
    inspect: Support<never>;
    list: Support<never>;
    delete: Support<never>;
  };
  volumes: Support<never>;
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

  return {
    snapshots: {
      capture,
      restore: unsupportedState(),
      inspect: unsupportedState(),
      list: unsupportedState(),
      delete: unsupportedState(),
    },
    volumes: unsupportedState(),
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

  const matches = support.value.profiles.filter(
    (profile) =>
      profile.preserve === input.preserve &&
      interruption.indexOf(profile.interruption) <=
        interruption.indexOf(input.maxInterruption ?? "pause") &&
      profile.consistency === (input.consistency ?? "crash-consistent"),
  );

  if (!matches.length)
    return {
      status: "unsupported",
      reason: "No profile satisfies the exact preservation and lifecycle requirements",
    };

  if (state === "unknown") return { status: "unknown", reason: "Source state is unknown" };
  const sources = matches.filter((profile) => profile.sourceStates.includes(state));

  if (!sources.length)
    return { status: "unavailable", reason: "No matching profile accepts the source state" };

  const requestedAfter = input.sourceAfter ?? "unchanged";
  const expectedState = requestedAfter === "unchanged" ? state : requestedAfter;

  const valid = sources.filter(
    (profile) =>
      (profile.sourceAfter === "unchanged" ? state : profile.sourceAfter) === expectedState,
  );

  if (!valid.length)
    return {
      status: "unsupported",
      reason: "No profile satisfies the requested source lifecycle outcome",
    };
  const minimum = input.retention?.minimumSeconds ?? 0;

  const profile = valid.find(
    (profile) =>
      minimum === 0 ||
      (profile.minimumRetentionSeconds !== undefined && profile.minimumRetentionSeconds >= minimum),
  );

  if (!profile)
    return valid.some((profile) => profile.minimumRetentionSeconds === undefined)
      ? { status: "unknown", reason: "Minimum retention is not established" }
      : { status: "unsupported", reason: "Minimum retention cannot be satisfied" };

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

export type Capabilities = Omit<
  z.infer<typeof Capabilities>,
  "snapshots" | "volumes" | "suspension"
> &
  StateCapabilities;

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
