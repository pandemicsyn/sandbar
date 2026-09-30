import { z } from "zod";
import { resourceHistory } from "./resource-history";
import {
  AdapterError,
  AdapterCheckpointError,
  type OperationOutcome,
  type SnapshotCaptureValue,
  assertResourceScope,
  resolveSnapshot,
  ResourceReference,
  type AdapterSession,
  type Scope,
  type SnapshotInfo,
  type VolumeInfo,
  type SnapshotProfile,
  type ReadContext,
  type AttemptContext,
} from "sandbar-adapter";
import { E2BVolumeCreateRejected, type E2BTransport, type E2BRecord } from "./transport";

const VolumeCreateToken = z.strictObject({
  state: z.enum(["uncertain", "accepted", "rejected"]),
  name: z.string().min(1).max(128),
  volume: ResourceReference.optional(),
  rejectionStatus: z.union([z.literal(400), z.literal(401), z.literal(403)]).optional(),
});

const CaptureToken = z.strictObject({
  state: z.literal("rejected").optional(),
  snapshotId: z.string().max(512),
  sourceId: z.string().max(512),
  generation: z.string().max(512).optional(),
  snapshot: ResourceReference.optional(),
  consistency: z.enum(["crash-consistent", "caller-quiesced", "unknown"]),
});

const DeleteToken = z
  .strictObject({
    accepted: z.boolean(),
    stage: z.enum(["uncertain", "accepted", "rejected"]).optional(),
    rejection: z.literal("before-dispatch").optional(),
    resource: z
      .strictObject({
        kind: z.enum(["snapshot", "volume"]),
        provider: z.literal("e2b"),
        nativeId: z.string().min(1).max(512),
        generation: z.string().min(1).max(512).optional(),
      })
      .optional(),
  })
  .refine((token) => !token.stage || token.accepted === (token.stage === "accepted"));

function canObserveDelete(token: z.infer<typeof DeleteToken>) {
  return token.accepted || token.stage === "uncertain";
}

const restoreToken = z.strictObject({
  selector: z.string().min(1).max(256),
  state: z.enum(["uncertain", "accepted", "rejected"]),
  sandboxId: z.string().min(1).max(512).optional(),
});

export function e2bState(input: {
  scope: Scope;
  transport: E2BTransport;
  scopeMarker: string;
  timeoutSeconds: number;
  apiKey: string;
  find: (id: string) => Promise<E2BRecord | null>;
}) {
  const { scope, transport } = input;
  const state = transport.state;
  const history = resourceHistory();

  const ref = (
    kind: "snapshot" | "volume",
    id: string,
    ownership: ResourceReference["ownership"] = "unknown",
  ): ResourceReference => ({
    version: 1,
    kind,
    provider: "e2b",
    scope: structuredClone(scope),
    nativeId: id,
    ownership,
  });

  const check = (reference: ResourceReference) =>
    assertResourceScope(reference, { provider: "e2b", scope });

  const need = () => {
    if (!state) throw new AdapterError("UNSUPPORTED", "Native state transport is not installed");

    return state;
  };

  const knownSnapshots = new Map<string, { sourceId: string }>();

  function snapshotInfo(
    id: string,
    ownership: ResourceReference["ownership"] = "unknown",
  ): SnapshotInfo {
    return {
      reference: ref("snapshot", id, ownership),
      preserve: "filesystem+memory",
      consistency: "unknown",
      restoreExecution: "resume",
      source: knownSnapshots.has(id)
        ? { id: knownSnapshots.get(id)!.sourceId, class: "firecracker" }
        : null,
      state: "ready",
      createdAt: null,
      expiration: "unknown",
      excludedPaths: null,
      mounts: [],
      mountHandling: knownSnapshots.has(id) ? "none" : "unknown",
      restore: {
        networkPolicies: ["internet", "blocked"],
        resources: false,
        mounts: false,
        independentLifecycle: true,
      },
      dependencies: [],
      nativeDependencies: null,
    };
  }

  function volumeInfo(
    v: { volumeId: string; name: string },
    ownership: ResourceReference["ownership"] = "unknown",
  ): VolumeInfo {
    return {
      reference: ref("volume", v.volumeId, ownership),
      name: v.name,
      state: "ready",
      filesystem: "object-backed",
      visibility: "unknown",
      durability: "unknown",
      locking: "unknown",
      rename: "unknown",
      conflicts: "unknown",
    };
  }

  async function snapshotInspect(reference: ResourceReference) {
    check(reference);

    if (reference.kind !== "snapshot" || !/^[A-Za-z0-9_-]+$/.test(reference.nativeId))
      throw new AdapterError("INVALID_ARGUMENT", "Snapshot requires a raw template identity");

    if (!reference.generation || !z.uuid().safeParse(reference.generation).success)
      throw new AdapterError("UNAVAILABLE", "Original captured build identity is unavailable");
    const native = await need().template(reference.nativeId);

    if (!native) throw new AdapterError("NOT_FOUND", "Snapshot template is unavailable");

    if (native.templateId !== reference.nativeId)
      throw new AdapterError("CONFLICT", "Snapshot native template identity differs");
    const build = native.builds.find((build) => build.buildId === reference.generation);

    if (!build) throw new AdapterError("NOT_FOUND", "Captured snapshot build is unavailable");
    const tags = await need().tags(reference.nativeId);

    if (
      !tags.some((tag) => tag.buildId === reference.generation) ||
      tags.some((tag) => tag.tag === reference.generation && tag.buildId !== reference.generation)
    )
      throw new AdapterError(
        "CONFLICT",
        "Captured build is not addressable by its immutable selector",
      );
    await need().verifyAddress(reference.nativeId, native.names);
    const info = snapshotInfo(reference.nativeId, reference.ownership);
    info.reference.generation = reference.generation;
    info.state = build.status === "ready" ? "ready" : "unknown";
    const evidence = history.read(reference);

    if (
      evidence?.kind === "snapshot" &&
      evidence.preserve === "filesystem+memory" &&
      evidence.mounts === "none"
    ) {
      info.mountHandling = "none";
      info.consistency = evidence.consistency ?? "unknown";
      info.reference.history = reference.history;
      info.source = { id: evidence.sourceId!, class: evidence.sourceClass! };
    }

    return info;
  }

  async function deletionRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return read();
    signal.throwIfAborted();
    let abort!: () => void;

    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });

    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();

          return read();
        }),
        cancelled,
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async function rejectDeletion(reference: ResourceReference, ctx: AttemptContext) {
    if (reference.kind !== "snapshot" && reference.kind !== "volume")
      throw new AdapterError("INVALID_ARGUMENT", "Artifact deletion kind differs");

    const resource: NonNullable<z.infer<typeof DeleteToken>["resource"]> = {
      kind: reference.kind,
      provider: "e2b",
      nativeId: reference.nativeId,
    };

    if (reference.generation) resource.generation = reference.generation;
    await ctx.checkpoint({
      accepted: false,
      stage: "rejected",
      rejection: "before-dispatch",
      resource,
    });

    return ctx.reject("UNAVAILABLE", "Artifact deletion cancelled before dispatch");
  }

  function continueRejectedDeletion(kind: "snapshot" | "volume") {
    return async (attempt: import("sandbar-adapter").RecoveryAttempt, ctx: AttemptContext) => {
      const token = DeleteToken.safeParse(attempt.token);
      const ref = attempt.resource;
      const saved = token.success ? token.data.resource : undefined;

      if (
        !token.success ||
        token.data.stage !== "rejected" ||
        token.data.accepted ||
        !token.data.rejection ||
        !ref ||
        !saved ||
        ref.kind !== kind ||
        saved.kind !== kind ||
        ref.nativeId !== saved.nativeId ||
        ref.provider !== saved.provider ||
        ref.generation !== saved.generation
      )
        return ctx.unknown("Artifact deletion rejection evidence is unavailable; no replay");
      check(ref);

      return ctx.reject("UNAVAILABLE", "Artifact deletion cancelled before dispatch");
    };
  }

  async function deleteSnapshotPreflight(reference: ResourceReference, signal?: AbortSignal) {
    check(reference);

    if (reference.kind !== "snapshot" || !/^[A-Za-z0-9_-]+$/.test(reference.nativeId))
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "Snapshot deletion requires a raw containing-template identity",
      );
    const native = await deletionRead(() => need().template(reference.nativeId), signal);

    if (!native) throw new AdapterError("NOT_FOUND", "Snapshot template is unavailable");

    if (native.templateId !== reference.nativeId || native.public)
      throw new AdapterError(
        "CONFLICT",
        "Snapshot template identity or private visibility differs",
      );
    await deletionRead(() => need().verifyAddress(reference.nativeId, native.names), signal);
    const baseline = history.read(reference)?.deletion;

    if (
      reference.generation &&
      !native.builds.some((build) => build.buildId === reference.generation)
    )
      throw new AdapterError(
        "CONFLICT",
        "Original captured build is no longer in the containing template",
      );

    // Retained JSON history cannot authorize deleting other generations.
    if (native.builds.length !== 1)
      throw new AdapterError(
        "CONFLICT",
        "Snapshot deletion cannot expand into a shared multi-build template",
      );

    if (baseline) {
      if (
        baseline.templateId !== reference.nativeId ||
        baseline.public ||
        native.builds.length !== baseline.builds.length ||
        native.builds.some((build) => !baseline.builds.includes(build.buildId)) ||
        native.names.length !== baseline.names.length ||
        native.names.some((name) => !baseline.names.includes(name))
      )
        throw new AdapterError(
          "CONFLICT",
          "Snapshot containing template has expanded beyond retained history",
        );
    }

    const dependencies = await deletionRead(() => transport.list({}, 100), signal);

    if (
      dependencies.nextToken ||
      dependencies.items.some((box) => box.templateId === reference.nativeId)
    )
      throw new AdapterError(
        "CONFLICT",
        "Snapshot has native compute dependencies or incomplete inventory",
      );
  }

  async function restorePreflight(value: {
    snapshot: ResourceReference;
    request: { networkPolicy: string; resources?: unknown; mounts?: unknown };
  }) {
    const info = await snapshotInspect(value.snapshot);

    if (info.state !== "ready" || info.mountHandling !== "none")
      throw new AdapterError(
        "UNAVAILABLE",
        "Captured build readiness or mount history is unverified",
      );

    if (
      !["internet", "blocked"].includes(value.request.networkPolicy) ||
      (value.request.resources && Object.keys(value.request.resources).length > 0) ||
      (value.request.mounts && Object.keys(value.request.mounts).length > 0)
    )
      throw new AdapterError("UNSUPPORTED", "Restore policy or overrides are unsupported");

    return info;
  }

  async function volumeInspect(reference: ResourceReference) {
    check(reference);
    const value = await need().volume(reference.nativeId);

    if (value.volumeId !== reference.nativeId)
      throw new AdapterError("CONFLICT", "Volume identity differs");
    const info = volumeInfo(value, reference.ownership);
    const evidence = history.read(reference);

    if (evidence && evidence.name !== value.name)
      throw new AdapterError("CONFLICT", "Volume native name differs from acknowledged identity");

    if (evidence) info.reference.history = reference.history;

    return info;
  }

  async function profiles(target: { sandbox?: { id: string } }, _ctx: ReadContext) {
    if (!state)
      return {
        status: "unsupported" as const,
        reason: "Native capture transport is not installed",
      };

    if (!target.sandbox)
      return {
        status: "unknown" as const,
        reason: "Actual source envd/class/mount evidence is required",
      };
    const box = await input.find(target.sandbox.id);

    if (!box) return { status: "unavailable" as const, reason: "Source is unavailable" };

    if (box.volumeMounts?.length)
      return {
        status: "unsupported" as const,
        reason: "Memory captures with mounts are not implemented",
      };

    if (!box.envdVersion)
      return { status: "unknown" as const, reason: "Source envd eligibility unknown" };
    const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(box.envdVersion);

    if (!match) return { status: "unknown" as const, reason: "Source envd version unrecognized" };

    if (Number(match[1]) === 0 && Number(match[2]) < 5)
      return { status: "unavailable" as const, reason: "Snapshots require envd >= 0.5.0" };

    const profile: SnapshotProfile = {
      id: "e2b-memory-running",
      preserve: "filesystem+memory",
      sourceStates: ["running"],
      interruption: "pause",
      sourceAfter: "unchanged",
      connections: "dropped",
      consistency: "unknown",
      restoreExecution: "resume",
      mountHandling: "none",
    };

    return {
      status: "supported" as const,
      value: { profiles: [profile], defaultProfileId: profile.id },
    };
  }

  function captureOutcome(
    token: z.infer<typeof CaptureToken>,
    info?: SnapshotInfo,
    source?: SnapshotCaptureValue["source"],
  ): Extract<OperationOutcome, { kind: "snapshot_capture" }> {
    let snapshot: Extract<OperationOutcome, { kind: "snapshot_capture" }>["snapshot"];

    if (token.snapshot?.kind === "snapshot") snapshot = { ...token.snapshot, kind: "snapshot" };
    else if (token.snapshotId) {
      snapshot = { ...ref("snapshot", token.snapshotId), kind: "snapshot" };

      if (token.generation) snapshot.generation = token.generation;
    }

    const confirmed = info?.state === "ready" && !!snapshot?.generation;

    return {
      kind: "snapshot_capture",
      status: confirmed ? "partial" : "unknown",
      snapshot,
      capture: confirmed
        ? { preserve: "filesystem+memory", interruption: "pause", restoreExecution: "resume" }
        : undefined,
      source,
      restart: confirmed && source?.state !== "running" ? { status: "uncertain" } : undefined,
    };
  }

  const fields: Pick<
    AdapterSession,
    | "snapshotProfiles"
    | "snapshotCapture"
    | "snapshotInspect"
    | "snapshotListCoverage"
    | "snapshotList"
    | "snapshotDelete"
    | "snapshotRestore"
    | "volumeCreate"
    | "volumeInspect"
    | "volumeList"
    | "volumeDelete"
    | "resourceCapabilities"
    | "checkMounts"
  > = {
    snapshotProfiles: profiles,
    snapshotCapture: {
      recovery: { version: 1, token: CaptureToken },
      async prepare(value, ctx) {
        const box = await input.find(value.sandbox.id);

        const plan = resolveSnapshot(
          await profiles({ sandbox: value.sandbox }, ctx),
          value.request,
          box?.state === "running" ? "running" : "unknown",
        );

        if (plan.status !== "supported")
          throw new AdapterError(
            plan.status === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE",
            plan.reason,
          );

        return value;
      },
      async submit(value, ctx) {
        const box = await input.find(value.sandbox.id);

        const plan = resolveSnapshot(
          await profiles(
            { sandbox: value.sandbox },
            { signal: ctx.signal, deadline: Date.now() + 30000 },
          ),
          value.request,
          box?.state === "running" ? "running" : "unknown",
        );

        if (!box || plan.status !== "supported")
          return ctx.reject("UNAVAILABLE", "Source capture eligibility changed");

        if (ctx.signal.aborted)
          return ctx.reject("UNAVAILABLE", "Capture cancelled before dispatch");
        await ctx.checkpoint({
          snapshotId: "",
          sourceId: box.id,
          consistency: plan.value.profile.consistency,
        });

        if (ctx.signal.aborted) {
          await ctx.checkpoint({
            state: "rejected",
            snapshotId: "",
            sourceId: box.id,
            consistency: plan.value.profile.consistency,
          });

          return ctx.reject("UNAVAILABLE", "Capture cancelled before dispatch");
        }

        const created = await need().capture(box.id, undefined, ctx.signal);

        if (!/^[A-Za-z0-9_-]+:default$/.test(created.snapshotId))
          return ctx.unknown(
            "Snapshot returned alias instead of allocated native identity; storage may be retained",
          );
        const templateId = created.snapshotId.slice(0, -":default".length);
        knownSnapshots.set(templateId, { sourceId: box.id });

        const token: z.infer<typeof CaptureToken> = {
          snapshotId: templateId,
          sourceId: box.id,
          consistency: plan.value.profile.consistency,
        };

        // Save allocation identity before fallible generation reads. A later default lookup
        // cannot repair a missing first-generation observation.
        try {
          await ctx.checkpoint(token);
        } catch (error) {
          if (error instanceof AdapterCheckpointError) error.outcome = captureOutcome(token);
          throw error;
        }

        let info: SnapshotInfo | undefined;
        let actual: E2BRecord | null;
        let observedSource: SnapshotCaptureValue["source"] | undefined;

        try {
          const native = await need().template(templateId);
          const tags = await need().tags(templateId);

          if (
            !native ||
            native.templateId !== templateId ||
            native.public ||
            native.names.length ||
            native.builds.length !== 1 ||
            tags.length !== 1 ||
            tags[0]?.tag !== "default" ||
            tags[0]?.buildId !== native.builds[0]?.buildId ||
            !z.uuid().safeParse(native.builds[0]?.buildId).success
          )
            return ctx.unknown(
              "Allocated snapshot build identity is unconfirmed; do not adopt a later default",
              captureOutcome(token),
            );
          token.generation = native.builds[0]!.buildId;
          const captured = ref("snapshot", templateId, "verified-created");
          captured.generation = token.generation;
          info = await snapshotInspect(captured);
          info.consistency = token.consistency;
          info.reference.history = history.issue({
            version: 1,
            kind: "snapshot",
            nativeId: info.reference.nativeId,
            generation: info.reference.generation,
            sourceId: box.id,
            sourceClass: "firecracker",
            preserve: "filesystem+memory",
            mounts: "none",
            consistency: info.consistency,
            deletion: {
              templateId,
              builds: [token.generation],
              names: [...native.names],
              public: native.public,
            },
          });
          token.snapshot = structuredClone(info.reference);
          await ctx.checkpoint(token);
          actual = await input.find(box.id);

          if (actual)
            observedSource = {
              state: actual.state === "running" ? "running" : "suspended",
              connections: info.state === "ready" ? "dropped" : "unknown",
              observedAt: new Date().toISOString(),
            };
        } catch (error) {
          if (error instanceof AdapterCheckpointError) {
            error.outcome = captureOutcome(token, info, observedSource);
            throw error;
          }

          return ctx.unknown(
            "Captured resource or source observation is unavailable; do not repeat capture",
            captureOutcome(token, info, observedSource),
          );
        }

        if (!actual || actual.state !== "running" || info?.state !== "ready")
          return ctx.unknown(
            "Original source or captured build outcome is unconfirmed; inspect the known snapshot without repeating capture",
            captureOutcome(token, info, observedSource),
          );

        if (ctx.signal.aborted)
          return ctx.unknown(
            "Local wait stopped after capture; do not repeat capture",
            captureOutcome(token, info, observedSource),
          );

        return {
          snapshot: info,
          capture: {
            preserve: "filesystem+memory",
            interruption: "pause",
            restoreExecution: "resume",
          },
          source: {
            state: "running",
            connections: "dropped",
            observedAt: observedSource?.observedAt,
          },
          retainedResources: [info.reference],
        };
      },
      async observe(attempt, ctx) {
        const token = CaptureToken.safeParse(attempt.token);

        if (
          token.success &&
          token.data.state === "rejected" &&
          !token.data.snapshotId &&
          !token.data.generation &&
          !token.data.snapshot &&
          token.data.sourceId === attempt.sandbox?.id
        )
          return ctx.unknown("Cancelled before dispatch; continue to confirm no-effect rejection");

        if (token.success && token.data.state === "rejected")
          return ctx.unknown("Rejected checkpoint contains contradictory acknowledgement evidence");

        if (
          !token.success ||
          !token.data.generation ||
          !token.data.snapshot ||
          token.data.sourceId !== attempt.sandbox?.id
        )
          return ctx.unknown(
            "Capture may retain storage; original build identity is unavailable; inspect known allocation without replay",
            token.success && token.data.sourceId === attempt.sandbox?.id
              ? captureOutcome(token.data)
              : undefined,
          );

        check(token.data.snapshot);
        history.owned(token.data.snapshot);
        const evidence = history.read(token.data.snapshot);

        if (
          token.data.snapshot.kind !== "snapshot" ||
          token.data.snapshot.nativeId !== token.data.snapshotId ||
          token.data.snapshot.generation !== token.data.generation ||
          evidence?.sourceId !== token.data.sourceId ||
          evidence.consistency !== token.data.consistency ||
          evidence.preserve !== "filesystem+memory" ||
          evidence.mounts !== "none"
        )
          return ctx.unknown("Saved snapshot custody differs from capture acknowledgement");

        knownSnapshots.set(token.data.snapshotId, { sourceId: token.data.sourceId });
        let info: SnapshotInfo | undefined;
        let box: E2BRecord | null;
        let observedSource: SnapshotCaptureValue["source"] | undefined;

        try {
          // Captured build readiness is independent of the source's lifetime.
          info = await snapshotInspect(token.data.snapshot);
          box = await input.find(token.data.sourceId);

          if (box)
            observedSource = {
              state: box.state === "running" ? "running" : "suspended",
              connections: info.state === "ready" ? "dropped" : "unknown",
              observedAt: new Date().toISOString(),
            };
        } catch {
          return ctx.unknown(
            "Captured resource or source observation is unavailable; do not repeat capture",
            captureOutcome(token.data, info, observedSource),
          );
        }

        if (!box || box.volumeMounts?.length || box.state !== "running" || info.state !== "ready")
          return ctx.unknown(
            "Original source or captured build outcome is unconfirmed; inspect the retained snapshot without repeating capture",
            captureOutcome(token.data, info, observedSource),
          );

        return {
          snapshot: info,
          capture: {
            preserve: "filesystem+memory",
            interruption: "pause",
            restoreExecution: "resume",
          },
          source: {
            state: "running",
            connections: "dropped",
            observedAt: observedSource?.observedAt,
          },
          retainedResources: [info.reference],
        };
      },
      async continue(attempt, ctx) {
        const token = CaptureToken.safeParse(attempt.token);

        if (
          token.success &&
          token.data.state === "rejected" &&
          !token.data.snapshotId &&
          !token.data.generation &&
          !token.data.snapshot &&
          token.data.sourceId === attempt.sandbox?.id
        )
          return ctx.reject("UNAVAILABLE", "Capture cancelled before dispatch");

        if (token.success && token.data.state === "rejected")
          return ctx.unknown("Rejected checkpoint contains contradictory acknowledgement evidence");

        if (!token.success || token.data.sourceId !== attempt.sandbox?.id)
          return ctx.unknown("Snapshot capture cannot be replayed; acknowledgement differs");

        if (!token.data.generation || !token.data.snapshot)
          return ctx.unknown("Snapshot capture cannot be replayed", captureOutcome(token.data));

        check(token.data.snapshot);
        history.owned(token.data.snapshot);
        const evidence = history.read(token.data.snapshot);

        if (
          token.data.snapshot.kind !== "snapshot" ||
          token.data.snapshot.nativeId !== token.data.snapshotId ||
          token.data.snapshot.generation !== token.data.generation ||
          evidence?.sourceId !== token.data.sourceId ||
          evidence.consistency !== token.data.consistency ||
          evidence.preserve !== "filesystem+memory" ||
          evidence.mounts !== "none"
        )
          return ctx.unknown("Saved snapshot custody differs from capture acknowledgement");

        let info: SnapshotInfo | undefined;
        let observedSource: SnapshotCaptureValue["source"] | undefined;

        try {
          info = await snapshotInspect(token.data.snapshot);
          const box = await input.find(token.data.sourceId);

          if (box)
            observedSource = {
              state: box.state === "running" ? "running" : "suspended",
              connections: info.state === "ready" ? "dropped" : "unknown",
              observedAt: new Date().toISOString(),
            };
        } catch {
          return ctx.unknown(
            "Captured resource or source observation is unavailable; capture cannot be replayed",
            captureOutcome(token.data, info, observedSource),
          );
        }

        return ctx.unknown(
          "Snapshot capture cannot be replayed",
          captureOutcome(token.data, info, observedSource),
        );
      },
    },
    snapshotInspect,
    snapshotListCoverage: "provider-scope",
    async snapshotList(page) {
      const values = await need().snapshots({ limit: page.limit, cursor: page.cursor });
      const items: SnapshotInfo[] = [];

      for (const value of values.items) {
        const info = snapshotInfo(value.snapshotId.replace(/:default$/, ""));
        info.state = "unknown";
        info.nativeDependencies = null;
        items.push(info);
      }

      return {
        items,
        nextCursor: values.nextCursor,
        coverage: "provider-scope",
      };
    },
    snapshotDelete: {
      recovery: { version: 1, token: DeleteToken },
      async prepare(value) {
        await deleteSnapshotPreflight(value);

        return value;
      },
      async submit(value, ctx) {
        try {
          await deleteSnapshotPreflight(value, ctx.signal);
        } catch (error) {
          if (!ctx.signal.aborted) throw error;

          return rejectDeletion(value, ctx);
        }

        if (ctx.signal.aborted) return rejectDeletion(value, ctx);
        await ctx.checkpoint({ accepted: false, stage: "uncertain" });

        if (ctx.signal.aborted) {
          return rejectDeletion(value, ctx);
        }

        const accepted = await need().deleteSnapshot(value.nativeId, ctx.signal);
        // The pinned SDK returns false for native 404, not a rejected dispatch.
        await ctx.checkpoint({ accepted, stage: accepted ? "accepted" : "uncertain" });

        return ctx.pending(
          { accepted, stage: accepted ? "accepted" : "uncertain" },
          { pollAfterMs: 0 },
        );
      },
      async observe(attempt, ctx) {
        const token = DeleteToken.safeParse(attempt.token);

        if (
          !attempt.resource ||
          attempt.resource.kind !== "snapshot" ||
          !token.success ||
          !canObserveDelete(token.data)
        )
          return ctx.unknown("Snapshot delete dispatch evidence is unavailable; no replay");
        check(attempt.resource);

        if (await need().template(attempt.resource.nativeId))
          return ctx.pending(token.data, { pollAfterMs: 500 });

        return { deleted: true, reference: attempt.resource };
      },
      continue: continueRejectedDeletion("snapshot"),
    },
    snapshotRestore: {
      recovery: { version: 1, token: restoreToken },
      async prepare(value) {
        await restorePreflight(value);

        return value;
      },
      async submit(value, ctx) {
        await restorePreflight(value);

        if (ctx.signal.aborted)
          return ctx.reject("UNAVAILABLE", "Restore cancelled before dispatch");
        const selector = `${value.snapshot.nativeId}:${value.snapshot.generation}`;
        const token: z.infer<typeof restoreToken> = { selector, state: "uncertain" };
        await ctx.checkpoint(token);

        if (ctx.signal.aborted) {
          token.state = "rejected";
          await ctx.checkpoint(token);

          return ctx.reject("UNAVAILABLE", "Restore cancelled before dispatch");
        }

        const id = await transport.create({
          templateId: selector,
          metadata: {
            sandbar_scope: input.scopeMarker,
            sandbar_submission: ctx.submissionId,
            sandbar_operation: ctx.operationId,
            sandbar_template: selector,
            sandbar_snapshot: selector,
          },
          timeoutMs: input.timeoutSeconds * 1000,
          allowInternetAccess: value.request.networkPolicy === "internet",
          signal: ctx.signal,
        });

        token.sandboxId = id;
        token.state = "accepted";
        await ctx.checkpoint(token);

        return ctx.pending(token, { pollAfterMs: 0 });
      },
      async observe(attempt, ctx) {
        const token = restoreToken.safeParse(attempt.token);
        const reference = attempt.resource;

        if (
          token.success &&
          token.data.state === "rejected" &&
          !token.data.sandboxId &&
          token.data.selector === `${attempt.resource?.nativeId}:${attempt.resource?.generation}`
        )
          return ctx.unknown("Cancelled before dispatch; continue to confirm no-effect rejection");

        if (token.success && token.data.state === "rejected")
          return ctx.unknown("Rejected checkpoint contains contradictory acknowledgement evidence");

        if (
          !reference ||
          !token.success ||
          token.data.selector !== `${reference.nativeId}:${reference.generation}`
        )
          return ctx.unknown("Original restore selector is unavailable; no replay");
        const info = await snapshotInspect(reference);

        if (info.state !== "ready") return ctx.unknown("Original captured build is not ready");

        const metadata = {
          sandbar_scope: input.scopeMarker,
          sandbar_submission: attempt.submissionId,
          sandbar_operation: attempt.operationId,
          sandbar_template: token.data.selector,
          sandbar_snapshot: token.data.selector,
        };

        const page = await transport.list(metadata, 2);

        if (page.nextToken || page.items.length !== 1)
          return ctx.unknown("Restored sandbox identity is ambiguous or unavailable; no replay");
        const box = page.items[0]!;

        if (
          (token.data.sandboxId && box.id !== token.data.sandboxId) ||
          box.templateId !== reference.nativeId ||
          !Object.entries(metadata).every(([key, value]) => box.metadata[key] === value)
        )
          return ctx.unknown("Restored sandbox correlation differs");
        const current = await input.find(box.id);

        if (
          !current ||
          current.id !== box.id ||
          current.templateId !== reference.nativeId ||
          !Object.entries(metadata).every(([key, value]) => current.metadata[key] === value)
        )
          return ctx.unknown("Restored sandbox identity is unverified");

        return { id: current.id, state: current.state === "running" ? "running" : "unknown" };
      },
      async continue(attempt, ctx) {
        const token = restoreToken.safeParse(attempt.token);

        if (
          token.success &&
          token.data.state === "rejected" &&
          !token.data.sandboxId &&
          token.data.selector === `${attempt.resource?.nativeId}:${attempt.resource?.generation}`
        )
          return ctx.reject("UNAVAILABLE", "Restore cancelled before dispatch");

        return ctx.unknown("Snapshot restore cannot be replayed");
      },
    },
    volumeCreate: {
      recovery: { version: 1, token: VolumeCreateToken },
      async prepare(value) {
        if (!/^[A-Za-z0-9-]+$/.test(value.name))
          throw new AdapterError(
            "INVALID_ARGUMENT",
            "E2B volume names allow only letters, numbers and hyphens",
          );
        await need().volumes();

        return value;
      },
      async submit(value, ctx) {
        if (!/^[A-Za-z0-9-]+$/.test(value.name))
          return ctx.reject(
            "INVALID_ARGUMENT",
            "E2B volume names allow only letters, numbers and hyphens",
          );
        const prior = await need().volumes();

        if (prior.some((v) => v.name === value.name))
          return ctx.reject("CONFLICT", "Volume already exists");

        await ctx.checkpoint({ state: "uncertain", name: value.name });

        if (ctx.signal.aborted) {
          await ctx.checkpoint({ state: "rejected", name: value.name });

          return ctx.reject("UNAVAILABLE", "Volume create cancelled before dispatch");
        }

        let created: { volumeId: string; name: string };

        try {
          created = await need().createVolume(value.name, ctx.signal);
        } catch (error) {
          if (!(error instanceof E2BVolumeCreateRejected)) throw error;
          await ctx.checkpoint({
            state: "rejected",
            name: value.name,
            rejectionStatus: error.status,
          });

          return ctx.reject(
            error.status === 400 ? "INVALID_ARGUMENT" : "UNAVAILABLE",
            `Native volume creation rejected (${error.status})`,
          );
        }

        const info = volumeInfo(created, "verified-created");

        info.reference.history = history.issue({
          version: 1,
          kind: "volume",
          nativeId: info.reference.nativeId,
          name: info.name,
        });

        await ctx.checkpoint({ state: "accepted", name: value.name, volume: info.reference });

        if (info.name !== value.name)
          return ctx.unknown("Acknowledged volume name differs from the requested name");

        return info;
      },
      async observe(attempt, ctx) {
        const parsed = VolumeCreateToken.safeParse(attempt.token);

        if (parsed.success && parsed.data.state === "rejected" && !parsed.data.volume)
          return ctx.unknown("Cancelled before dispatch; continue to confirm no-effect rejection");

        if (!parsed.success || parsed.data.state !== "accepted" || !parsed.data.volume)
          return ctx.unknown(
            "Volume create acknowledgement unavailable; no adoption by name or replay",
          );

        const { volume, name } = parsed.data;
        check(volume);
        const evidence = history.read(volume);

        if (volume.kind !== "volume" || !evidence || evidence.name !== name)
          return ctx.unknown("Acknowledged volume identity does not match the saved request");

        return await volumeInspect(volume);
      },
      async continue(attempt, ctx) {
        const parsed = VolumeCreateToken.safeParse(attempt.token);

        if (parsed.success && parsed.data.state === "rejected" && !parsed.data.volume)
          return ctx.reject(
            parsed.data.rejectionStatus === 400 ? "INVALID_ARGUMENT" : "UNAVAILABLE",
            parsed.data.rejectionStatus
              ? `Native volume creation rejected (${parsed.data.rejectionStatus})`
              : "Volume create cancelled before dispatch",
          );

        return ctx.unknown("Volume creation cannot be replayed");
      },
    },
    volumeInspect,
    async volumeList(page) {
      if (page.cursor) throw new AdapterError("UNSUPPORTED", "Native volume cursor unsupported");
      const values = await need().volumes();

      if (values.length > page.limit)
        throw new AdapterError("CAPACITY", "Native volume inventory exceeds requested bound");

      return {
        items: values.map((v) => volumeInfo(v)),
        coverage: "provider-scope",
      };
    },
    async resourceCapabilities() {
      const restore = state
        ? {
            status: "supported" as const,
            value: {
              networkPolicies: ["internet", "blocked"],
              resources: false,
              mounts: false,
              independentLifecycle: true,
            },
          }
        : { status: "unsupported" as const, reason: "Native state transport unavailable" };

      if (!state)
        return {
          restore,
          volumes: {
            status: "unsupported",
            reason: "Native volume transport unavailable",
          },
          mounts: {
            status: "unsupported",
            reason: "Native mount transport unavailable",
          },
        };

      try {
        await need().volumes();

        return {
          restore,
          volumes: {
            status: "supported",
            value: { create: true, inspect: true, list: true, delete: true },
          },
          mounts: {
            status: "unsupported",
            reason: "E2B mounts select reusable names and expose no mounted volume ID",
          },
        };
      } catch (error) {
        const status =
          error instanceof Error && /(?:403|forbidden|beta)/i.test(error.message)
            ? ("unavailable" as const)
            : ("unknown" as const);

        return {
          restore,
          volumes: {
            status,
            reason:
              status === "unavailable"
                ? "Volume private-beta access unavailable"
                : "Volume eligibility could not be established",
          },
          mounts: {
            status: "unsupported",
            reason: "E2B cannot bind mount names to immutable volume IDs",
          },
        };
      }
    },
    async checkMounts(create) {
      for (const mount of create.mounts ?? []) check(mount.volume);

      return create.mounts?.length
        ? {
            status: "unsupported",
            reason: "E2B cannot bind mount names to immutable volume IDs",
          }
        : { status: "supported", value: {} };
    },
  };

  fields.volumeDelete = {
    recovery: { version: 1, token: DeleteToken },
    async prepare(reference) {
      check(reference);

      if (reference.kind !== "volume") throw new AdapterError("CONFLICT", "Artifact kind differs");
      await volumeInspect(reference);

      return reference;
    },
    async submit(reference, ctx) {
      check(reference);

      try {
        await deletionRead(() => volumeInspect(reference), ctx.signal);
      } catch (error) {
        if (!ctx.signal.aborted) throw error;

        return rejectDeletion(reference, ctx);
      }

      if (ctx.signal.aborted) return rejectDeletion(reference, ctx);
      await ctx.checkpoint({ accepted: false, stage: "uncertain" });

      if (ctx.signal.aborted) {
        return rejectDeletion(reference, ctx);
      }

      let stage: "uncertain" | "accepted" | "rejected" = "uncertain";
      let accepted = false;

      try {
        accepted = await need().deleteVolume(reference.nativeId, ctx.signal);
        // A false native result means not found; confirm absence read-only.
        stage = accepted ? "accepted" : "uncertain";
        await ctx.checkpoint({ accepted, stage });
      } catch (error) {
        if (error instanceof AdapterCheckpointError) throw error;

        /* observe only */
      }

      return ctx.pending({ accepted, stage }, { pollAfterMs: 500 });
    },
    async observe(attempt, ctx) {
      const reference = attempt.resource;

      if (!reference || reference.kind !== "volume")
        return ctx.unknown("Deletion ownership missing");
      check(reference);
      const token = DeleteToken.safeParse(attempt.token);

      if (!token.success || !canObserveDelete(token.data))
        return ctx.unknown("Deletion dispatch evidence unavailable; no replay");

      const values = await need().volumes();

      if (!values.some((v) => v.volumeId === reference.nativeId))
        return { deleted: true, reference };

      return ctx.pending(token.data, { pollAfterMs: 500 });
    },
    continue: continueRejectedDeletion("volume"),
  };

  return { fields: state ? fields : {}, volumeInspect };
}
