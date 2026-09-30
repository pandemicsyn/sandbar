import { z } from "zod";
import { createHash } from "node:crypto";
import { resourceHistory } from "./resource-history";
import {
  AdapterError,
  AdapterCheckpointError,
  type AttemptContext,
  type ObserveContext,
  assertResourceScope,
  resolveSnapshot,
  type AdapterSession,
  type Scope,
  ResourceReference,
  type SnapshotInfo,
  SnapshotInfo as SnapshotInfoSchema,
  type VolumeInfo,
  type ReadContext,
  type CreateInput,
  type SnapshotProfile,
  type OperationOutcome,
} from "sandbar-adapter";

const CompactReference = ResourceReference.omit({ scope: true });

const SavedSnapshot = SnapshotInfoSchema.extend({
  reference: z.union([ResourceReference, CompactReference]),
});

const VolumeCreateToken = z.strictObject({
  state: z.enum(["uncertain", "accepted", "rejected"]),
  name: z.string().min(1).max(128),
  volume: z.union([ResourceReference, CompactReference]).optional(),
  rejectionStatus: z
    .union([z.literal(400), z.literal(401), z.literal(403), z.literal(422)])
    .optional(),
});

const NativeVolume = z.object({
  id: z.string(),
  name: z.string(),
  organizationId: z.string(),
  state: z.string(),
});

const NativeSnapshot = z.object({
  id: z.string(),
  name: z.string(),
  organizationId: z.string().optional(),
  general: z.boolean(),
  state: z.string(),
  sourceSandboxId: z.string().nullable(),
  sandboxClass: z.string().optional(),
  regionIds: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
});

const NativeBox = z.object({
  id: z.string(),
  organizationId: z.string(),
  target: z.string(),
  state: z.string(),
  sandboxClass: z.string().optional(),
  volumes: z
    .array(
      z.object({ volumeId: z.string(), mountPath: z.string(), subpath: z.string().optional() }),
    )
    .default([]),
});

const CaptureFacts = z.strictObject({
  preserve: z.literal("filesystem"),
  interruption: z.enum(["none", "stop"]),
  restoreExecution: z.literal("fresh"),
});

const Token = z.strictObject({
  name: z.string().min(1).max(128),
  sourceId: z.string().min(1).max(512),
  initialState: z.enum(["running", "stopped"]),
  restartRequired: z.boolean(),
  stopState: z
    .enum(["not-submitted", "uncertain", "accepted", "completed", "failed"])
    .default("uncertain"),
  restartState: z
    .enum(["not-submitted", "uncertain", "accepted", "completed", "failed"])
    .default("uncertain"),
  stage: z.enum(["stop", "capture", "restart", "complete"]),
  snapshotId: z.string().min(1).max(512).optional(),
  captureState: z.enum(["not-submitted", "uncertain", "accepted", "completed", "failed"]),
  sourceState: z.enum(["running", "stopped", "unknown"]),
  sourceObservedState: z.enum(["running", "stopped", "unknown"]).optional(),
  sourceObservedAt: z.iso.datetime().optional(),
  capture: CaptureFacts,
  consistency: z.enum(["crash-consistent", "caller-quiesced", "unknown"]),
  snapshot: z.json().optional(),
  rejectedBeforeDispatch: z.literal(true).optional(),
  captureFailure: z.string().max(512).optional(),
  restartFailure: z.string().max(512).optional(),
});

function captureRejectedBeforeDispatch(token: z.infer<typeof Token>): boolean {
  return (
    token.rejectedBeforeDispatch === true &&
    token.captureState === "not-submitted" &&
    !token.snapshotId &&
    !token.snapshot &&
    token.stopState === (token.initialState === "running" ? "not-submitted" : "completed")
  );
}

class TerminalCaptureError extends Error {
  constructor(readonly snapshot: SnapshotInfo) {
    super("Native capture terminally failed");
  }
}

const DeleteIdentity = z.strictObject({
  kind: z.enum(["snapshot", "volume"]),
  provider: z.literal("daytona"),
  nativeId: z.string().min(1).max(512),
  generation: z.string().min(1).max(512).optional(),
});

function captureName(submissionId: string): string {
  return `sandbar-capture-${createHash("sha256").update(submissionId).digest("hex")}`;
}

function matchesCaptureName(name: string, submissionId: string): boolean {
  return (
    name === captureName(submissionId) ||
    (name.length <= 128 && name === `sandbar-capture-${submissionId}`)
  );
}

const DeleteToken = z
  .strictObject({
    reference: z.union([DeleteIdentity, ResourceReference]),
    accepted: z.boolean(),
    stage: z.enum(["uncertain", "accepted", "rejected"]).optional(),
    rejection: z.enum(["before-dispatch", "native-response"]).optional(),
  })
  .refine((token) => !token.stage || token.accepted === (token.stage === "accepted"));

function canObserveDelete(token: z.infer<typeof DeleteToken>) {
  return token.accepted || token.stage === "uncertain";
}

type Fields = Pick<
  AdapterSession,
  | "snapshotProfiles"
  | "snapshotCapture"
  | "snapshotInspect"
  | "snapshotListCoverage"
  | "snapshotList"
  | "snapshotDelete"
  | "volumeCreate"
  | "volumeInspect"
  | "volumeList"
  | "volumeDelete"
  | "resourceCapabilities"
  | "checkMounts"
>;

export function daytonaState(input: {
  scope: Scope;
  apiUrl: string;
  apiKey: string;
  target: string;
  restartAfterCapture?: boolean;
  fetch: typeof fetch;
}) {
  const scope = input.scope;
  const history = resourceHistory();
  const captured = new Set<string>();

  const reference = (
    kind: "snapshot" | "volume",
    id: string,
    ownership: ResourceReference["ownership"] = "unknown",
  ): ResourceReference => ({
    version: 1,
    provider: "daytona",
    scope: structuredClone(scope),
    kind,
    nativeId: id,
    ownership,
  });

  const check = (ref: ResourceReference) =>
    assertResourceScope(ref, { provider: "daytona", scope });

  async function request(
    method: string,
    path: string,
    body?: { name: string; includeMemory?: false },
    ctx?: ReadContext,
  ) {
    const headers = new Headers({
      Authorization: `Bearer ${input.apiKey}`,
      "X-Daytona-Organization-ID": scope.authority.id,
    });

    if (body) headers.set("Content-Type", "application/json");

    const signal = ctx
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now()))])
      : AbortSignal.timeout(30000);

    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();

      const response = await input.fetch(input.apiUrl + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal,
      });

      if (method !== "GET" || ![502, 503, 504].includes(response.status)) return response;
      // Releasing a failed read body must not outlive the caller’s wait bound.
      void response.body?.cancel().catch(() => undefined);

      if (attempt >= 2)
        throw new AdapterError("UNAVAILABLE", `Daytona state HTTP ${response.status}`);
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          clearTimeout(timer);
          reject(signal.reason);
        };

        const timer = setTimeout(
          () => {
            signal.removeEventListener("abort", abort);
            resolve();
          },
          250 * 2 ** attempt,
        );

        signal.addEventListener("abort", abort, { once: true });

        if (signal.aborted) abort();
      });
    }
  }

  async function json<S extends z.ZodType>(response: Response, schema: S): Promise<z.output<S>> {
    if (!response.ok)
      throw new AdapterError(
        response.status === 404
          ? "NOT_FOUND"
          : response.status === 403 || [502, 503, 504].includes(response.status)
            ? "UNAVAILABLE"
            : "INTERNAL",
        `Daytona state HTTP ${response.status}`,
      );

    if (!response.body) throw new AdapterError("INTERNAL", "Missing native response");
    const reader = response.body.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];

    try {
      for (;;) {
        const next = await reader.read();

        if (next.done) break;
        total += next.value.length;

        if (total > 1048576) throw new AdapterError("CAPACITY", "Native response exceeds bound");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }

  async function box(id: string, ctx?: ReadContext) {
    const value = await json(
      await request("GET", `/sandbox/${encodeURIComponent(id)}`, undefined, ctx),
      NativeBox,
    );

    if (
      value.id !== id ||
      value.organizationId !== scope.authority.id ||
      value.target !== input.target
    )
      throw new AdapterError("CONFLICT", "Sandbox scope differs");

    return value;
  }

  function compactReference(ref: ResourceReference): z.infer<typeof CompactReference> {
    const { scope: _scope, ...compact } = ref;

    return compact;
  }

  function scopedReference(
    ref: ResourceReference | z.infer<typeof CompactReference>,
  ): ResourceReference {
    const restored = ResourceReference.parse("scope" in ref ? ref : { ...ref, scope });
    check(restored);

    return restored;
  }

  function savedSnapshot(token: z.infer<typeof Token>) {
    const saved = SavedSnapshot.safeParse(token.snapshot);

    if (!saved.success) return SnapshotInfoSchema.safeParse(token.snapshot);

    return SnapshotInfoSchema.safeParse({
      ...saved.data,
      reference: scopedReference(saved.data.reference),
    });
  }

  function compactSnapshot(info: SnapshotInfo) {
    return JSON.parse(JSON.stringify({ ...info, reference: compactReference(info.reference) }));
  }

  function volumeInfo(
    v: z.infer<typeof NativeVolume>,
    ownership: ResourceReference["ownership"] = "unknown",
  ): VolumeInfo {
    if (v.organizationId !== scope.authority.id)
      throw new AdapterError("CONFLICT", "Volume organization differs");

    return {
      reference: reference("volume", v.id, ownership),
      name: v.name,
      state:
        v.state === "ready"
          ? "ready"
          : ["creating", "pending_create"].includes(v.state)
            ? "creating"
            : ["deleting", "pending_delete"].includes(v.state)
              ? "deleting"
              : "unknown",
      filesystem: "object-backed",
      visibility: "immediate",
      durability: "unknown",
      locking: "unknown",
      rename: "unknown",
      conflicts: "last-writer-wins",
    };
  }

  function snapshotInfo(
    v: z.infer<typeof NativeSnapshot>,
    ownership: ResourceReference["ownership"] = "unknown",
  ): SnapshotInfo {
    if (v.organizationId !== scope.authority.id && !v.general)
      throw new AdapterError("CONFLICT", "Snapshot organization differs");

    return {
      reference: reference("snapshot", v.id, ownership),
      preserve: v.sourceSandboxId && v.sandboxClass === "container" ? "filesystem" : null,
      consistency: "unknown",
      restoreExecution: v.sourceSandboxId && v.sandboxClass === "container" ? "fresh" : null,
      source: v.sourceSandboxId
        ? { id: v.sourceSandboxId, class: v.sandboxClass ?? "unknown" }
        : null,
      state: v.state === "active" && v.regionIds?.includes(input.target) ? "ready" : "unknown",
      createdAt: v.createdAt ?? null,
      expiration: "unknown",
      excludedPaths: null,
      mounts: [],
      mountHandling: captured.has(v.id) ? "none" : "unknown",
      restore: { networkPolicies: [], resources: false, mounts: false, independentLifecycle: true },
      dependencies: [],
      nativeDependencies: null,
    };
  }

  async function dependencies(v: z.infer<typeof NativeSnapshot>, ctx?: ReadContext) {
    const response = await request("GET", "/warm-pools", undefined, ctx);

    // The native warm-pool API returns 404 when this organization has pools disabled.
    // Other failures remain unknown and block deletion; never drain another resource.
    if (response.status === 404) return [];

    const pools = await json(
      response,
      z
        .array(
          z.object({
            id: z.string().min(1).max(512),
            organizationId: z.string().min(1).max(512),
            snapshot: z.string().min(1).max(512),
          }),
        )
        .max(100),
    );

    if (pools.some((pool) => pool.organizationId !== scope.authority.id))
      throw new AdapterError("CONFLICT", "Warm pool inventory scope differs");

    return pools
      .filter((pool) => pool.snapshot === v.id || pool.snapshot === v.name)
      .map((pool) => ({ kind: "warm-pool", id: pool.id }));
  }

  async function inspectSnapshot(ref: ResourceReference, ctx?: ReadContext, deleting = false) {
    check(ref);

    const v = await json(
      await request("GET", `/snapshots/${encodeURIComponent(ref.nativeId)}`, undefined, ctx),
      NativeSnapshot,
    );

    if (v.id !== ref.nativeId) throw new AdapterError("CONFLICT", "Snapshot identity differs");

    if (deleting && (v.general || v.organizationId !== scope.authority.id))
      throw new AdapterError(
        "CONFLICT",
        "Explicit deletion requires a private snapshot in the verified organization",
      );
    const info = snapshotInfo(v, ref.ownership);

    try {
      info.nativeDependencies = await dependencies(v, ctx);
    } catch {
      /* Unknown dependencies block deletion. */
    }

    const evidence = history.read(ref);

    if (
      evidence &&
      (v.general ||
        v.organizationId !== scope.authority.id ||
        evidence.sourceId !== v.sourceSandboxId ||
        evidence.sourceClass !== v.sandboxClass)
    )
      throw new AdapterError("CONFLICT", "Snapshot ownership or provenance changed");

    if (
      evidence?.kind === "snapshot" &&
      evidence.preserve === "filesystem" &&
      evidence.sourceClass === "container" &&
      evidence.sourceId === v.sourceSandboxId &&
      v.sandboxClass === "container"
    ) {
      info.mountHandling = "none";
      info.consistency = evidence.consistency ?? "unknown";
      info.reference.history = ref.history;
    }

    return info;
  }

  async function inspectVolume(ref: ResourceReference, ctx?: ReadContext) {
    check(ref);

    const v = await json(
      await request("GET", `/volumes/${encodeURIComponent(ref.nativeId)}`, undefined, ctx),
      NativeVolume,
    );

    if (v.id !== ref.nativeId) throw new AdapterError("CONFLICT", "Volume identity differs");
    const info = volumeInfo(v, ref.ownership);

    if (v.state === "deleted") throw new AdapterError("NOT_FOUND", "Volume is deleted");
    const evidence = history.read(ref);

    if (evidence && evidence.name !== v.name)
      throw new AdapterError("CONFLICT", "Volume native name differs from acknowledged identity");

    if (evidence) info.reference.history = ref.history;

    return info;
  }

  async function profiles(
    target: { sandbox?: { id: string }; create?: CreateInput },
    ctx: ReadContext,
  ) {
    if (!target.sandbox)
      return {
        status: "unknown" as const,
        reason: "Capture eligibility requires actual container source evidence",
      };
    const source = await box(target.sandbox.id, ctx);

    return profileFor(source);
  }

  function profileFor(source: z.infer<typeof NativeBox>) {
    if (source.sandboxClass !== "container")
      return {
        status: "unsupported" as const,
        reason:
          "Only cold container capture has portable exact-preservation evidence; VM memory/cold provenance is not mapped",
      };

    if (source.volumes.length)
      return {
        status: "unsupported" as const,
        reason: "Capture with external volumes is not mapped",
      };

    const profile: SnapshotProfile = {
      id: "daytona-container-cold",
      preserve: "filesystem",
      sourceStates: ["running", "stopped"],
      interruption: source.state === "started" ? "stop" : "none",
      sourceAfter:
        source.state === "started" && input.restartAfterCapture !== false ? "unchanged" : "stopped",
      connections: "dropped",
      consistency: "unknown",
      restoreExecution: "fresh",
      mountHandling: "none",
    };

    return {
      status: "supported" as const,
      value: { profiles: [profile], defaultProfileId: profile.id },
    };
  }

  async function observedCapture(
    name: string,
    sourceId: string,
    acknowledged: boolean,
    ctx: ReadContext,
    consistency: SnapshotInfo["consistency"] = "unknown",
    expectedId?: string,
  ) {
    const response = await request("GET", `/snapshots/${encodeURIComponent(name)}`, undefined, ctx);

    if (response.status === 404) return null;
    const v = await json(response, NativeSnapshot);

    if (
      (expectedId !== undefined && v.id !== expectedId) ||
      v.name !== name ||
      v.sourceSandboxId !== sourceId ||
      v.organizationId !== scope.authority.id ||
      v.sandboxClass !== "container"
    )
      return null;

    if (acknowledged) captured.add(v.id);
    const info = snapshotInfo(v, acknowledged ? "verified-created" : "unknown");
    info.consistency = consistency;

    if (acknowledged)
      info.reference.history = history.issue({
        version: 1,
        kind: "snapshot",
        nativeId: v.id,
        sourceId,
        sourceClass: "container",
        preserve: "filesystem",
        mounts: "none",
        consistency,
      });

    if (["error", "failed"].includes(v.state)) throw new TerminalCaptureError(info);

    return acknowledged ? info : null;
  }

  async function settledSource(id: string, wanted: "started" | "stopped", ctx: ReadContext) {
    let current = await box(id, ctx);

    while (current.state !== wanted) {
      if (ctx.signal.aborted || Date.now() >= ctx.deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
      current = await box(id, ctx);
    }

    return current.state === wanted ? current : null;
  }

  function compactDeletionReference(ref: ResourceReference): z.infer<typeof DeleteIdentity> {
    if (ref.kind !== "snapshot" && ref.kind !== "volume")
      throw new AdapterError("INVALID_ARGUMENT", "Artifact deletion kind differs");

    const identity: z.infer<typeof DeleteIdentity> = {
      kind: ref.kind,
      provider: "daytona",
      nativeId: ref.nativeId,
    };

    if (ref.generation) identity.generation = ref.generation;

    return identity;
  }

  function matchesDeletionReference(
    saved: z.infer<typeof DeleteToken>["reference"],
    ref: ResourceReference,
  ): boolean {
    if (
      saved.kind !== ref.kind ||
      saved.provider !== ref.provider ||
      saved.nativeId !== ref.nativeId ||
      saved.generation !== ref.generation
    )
      return false;

    // Legacy checkpoints duplicated scoped references; continue validating that scope.
    if ("scope" in saved) check(saved);

    return true;
  }

  const deletion = (
    kind: "snapshot" | "volume",
  ): NonNullable<AdapterSession["snapshotDelete"]> => ({
    recovery: { version: 1, token: DeleteToken },
    async prepare(ref, ctx) {
      check(ref);

      if (ref.kind !== kind) throw new AdapterError("CONFLICT", "Artifact kind differs");

      const info = await (kind === "snapshot"
        ? inspectSnapshot(ref, ctx, true)
        : inspectVolume(ref, ctx));

      if (
        kind === "snapshot" &&
        "nativeDependencies" in info &&
        (info.nativeDependencies === null || info.nativeDependencies.length)
      )
        throw new AdapterError(
          "CONFLICT",
          "Snapshot deletion dependencies are present or unverified",
        );

      return ref;
    },
    async submit(ref, ctx) {
      check(ref);
      const retained = compactDeletionReference(ref);
      const context = { signal: ctx.signal, deadline: Date.now() + 30000 };

      let info: SnapshotInfo | VolumeInfo;

      try {
        info = await (kind === "snapshot"
          ? inspectSnapshot(ref, context, true)
          : inspectVolume(ref, context));
      } catch (error) {
        if (!ctx.signal.aborted) throw error;
        await ctx.checkpoint({
          reference: retained,
          accepted: false,
          stage: "rejected",
          rejection: "before-dispatch",
        });

        return ctx.reject("UNAVAILABLE", "Artifact delete cancelled before dispatch");
      }

      if (ctx.signal.aborted) {
        await ctx.checkpoint({
          reference: retained,
          accepted: false,
          stage: "rejected",
          rejection: "before-dispatch",
        });

        return ctx.reject("UNAVAILABLE", "Artifact delete cancelled before dispatch");
      }

      if (
        kind === "snapshot" &&
        "nativeDependencies" in info &&
        (info.nativeDependencies === null || info.nativeDependencies.length)
      )
        return ctx.reject("CONFLICT", "Snapshot deletion dependencies are present or unverified");

      await ctx.checkpoint({ reference: retained, accepted: false, stage: "uncertain" });

      if (ctx.signal.aborted) {
        await ctx.checkpoint({
          reference: retained,
          accepted: false,
          stage: "rejected",
          rejection: "before-dispatch",
        });

        return ctx.reject("UNAVAILABLE", "Artifact delete cancelled before dispatch");
      }

      try {
        const response = await request(
          "DELETE",
          `${kind === "snapshot" ? "/snapshots" : "/volumes"}/${encodeURIComponent(ref.nativeId)}`,
          undefined,
          { signal: ctx.signal, deadline: Date.now() + 30000 },
        );

        const rejected = [400, 401, 403, 422].includes(response.status);

        const checkpoint: z.infer<typeof DeleteToken> = {
          reference: retained,
          accepted: response.ok,
          stage: response.ok ? "accepted" : rejected ? "rejected" : "uncertain",
        };

        if (rejected) checkpoint.rejection = "native-response";
        await ctx.checkpoint(checkpoint);

        if (response.ok)
          return ctx.pending(
            { reference: retained, accepted: true, stage: "accepted" },
            { pollAfterMs: 500 },
          );

        if (rejected)
          return ctx.reject("UNAVAILABLE", `Artifact delete rejected with HTTP ${response.status}`);

        return ctx.pending(
          { reference: retained, accepted: false, stage: "uncertain" },
          { pollAfterMs: 500 },
        );
      } catch (error) {
        if (error instanceof AdapterCheckpointError) throw error;

        return ctx.pending(
          { reference: retained, accepted: false, stage: "uncertain" },
          { pollAfterMs: 500 },
        );
      }
    },
    async observe(attempt, ctx) {
      const ref = attempt.resource;

      if (!ref || ref.kind !== kind) return ctx.unknown("Missing deletion resource identity");
      check(ref);
      const token = DeleteToken.safeParse(attempt.token);

      if (!token.success || !canObserveDelete(token.data))
        return ctx.unknown("Artifact delete dispatch evidence is unavailable; no replay");

      if (!matchesDeletionReference(token.data.reference, ref))
        return ctx.unknown("Artifact delete checkpoint identity differs");

      const response = await request(
        "GET",
        `${kind === "snapshot" ? "/snapshots" : "/volumes"}/${encodeURIComponent(ref.nativeId)}`,
        undefined,
        ctx,
      );

      if (response.status === 404) return { deleted: true, reference: ref };

      if (!response.ok) return ctx.unknown("Deletion is unconfirmed");

      if (kind === "snapshot") {
        const native = await json(response, NativeSnapshot);

        if (native.id !== ref.nativeId || native.organizationId !== scope.authority.id)
          return ctx.unknown("Deleted snapshot identity or scope differs");
      }

      if (kind === "volume") {
        const native = await json(response, NativeVolume);

        if (native.id !== ref.nativeId || native.organizationId !== scope.authority.id)
          return ctx.unknown("Deleted volume identity or scope differs");

        if (native.state === "deleted") return { deleted: true, reference: ref };
      }

      return ctx.pending(token.data, { pollAfterMs: 500 });
    },
    async continue(attempt, ctx) {
      const token = DeleteToken.safeParse(attempt.token);
      const ref = attempt.resource;

      if (
        !ref ||
        ref.kind !== kind ||
        !token.success ||
        token.data.stage !== "rejected" ||
        !token.data.rejection ||
        token.data.accepted ||
        !matchesDeletionReference(token.data.reference, ref)
      )
        return ctx.unknown("Artifact delete rejection evidence is unavailable; no replay");
      check(ref);

      return ctx.reject("UNAVAILABLE", "Artifact deletion was rejected; no replay");
    },
  });

  function matchesCaptureIntent(
    token: z.infer<typeof Token>,
    accepted: import("sandbar-adapter").RecoveryAttempt["capture"],
  ) {
    if (!accepted) return false;
    const profile = accepted.profile;

    return (
      token.initialState === accepted.sourceState &&
      profile.id === "daytona-container-cold" &&
      token.capture.preserve === profile.preserve &&
      token.capture.interruption === profile.interruption &&
      token.capture.restoreExecution === profile.restoreExecution &&
      token.consistency === profile.consistency &&
      token.restartRequired ===
        (token.initialState === "running" && profile.sourceAfter === "unchanged")
    );
  }

  function observeSource(token: z.infer<typeof Token>, state: string) {
    let normalized: z.infer<typeof Token>["sourceState"] = "unknown";

    if (state === "started") normalized = "running";
    else if (state === "stopped") normalized = "stopped";
    token.sourceState = normalized;

    // Preserve the time of the last state change, avoiding a checkpoint on every poll.
    if (token.sourceObservedState !== normalized || !token.sourceObservedAt) {
      token.sourceObservedState = normalized;
      token.sourceObservedAt = new Date().toISOString();
    }
  }

  function captureOutcome(
    token: z.infer<typeof Token>,
  ): Extract<OperationOutcome, { kind: "snapshot_capture" }> {
    const saved = savedSnapshot(token);

    const known =
      saved.success &&
      token.snapshotId === saved.data.reference.nativeId &&
      saved.data.reference.kind === "snapshot" &&
      !!history.read(saved.data.reference);

    const completed =
      known &&
      ["accepted", "completed"].includes(token.captureState) &&
      saved.data.state === "ready";

    const outcome: Extract<OperationOutcome, { kind: "snapshot_capture" }> = {
      kind: "snapshot_capture",
      status: completed ? "partial" : "unknown",
    };

    if (known) outcome.snapshot = { ...saved.data.reference, kind: "snapshot" };

    if (completed) outcome.capture = token.capture;

    if (token.sourceObservedAt && token.sourceObservedState)
      outcome.source = {
        state: token.sourceObservedState,
        connections: token.stopState === "completed" ? "dropped" : "unknown",
        observedAt: token.sourceObservedAt,
      };

    if (token.restartRequired && token.restartState !== "completed") {
      let status: "failed" | "not-submitted" | "uncertain" = "uncertain";

      if (completed && token.restartState === "failed") status = "failed";
      else if (token.restartState === "not-submitted") status = "not-submitted";
      outcome.restart = { status };
    }

    return outcome;
  }

  function captureCheckpointError(error: AdapterCheckpointError, token: z.infer<typeof Token>) {
    error.outcome = captureOutcome(token);
  }

  async function captureResult(
    token: z.infer<typeof Token>,
    ctx: ObserveContext | AttemptContext,
    captureObserved = false,
  ) {
    const pending = () => ctx.pending(token, { pollAfterMs: 500 });

    const saved = savedSnapshot(token);

    if (
      token.captureState === "accepted" &&
      captureObserved &&
      saved.success &&
      token.snapshotId &&
      saved.data.reference.nativeId === token.snapshotId &&
      history.read(saved.data.reference)
    ) {
      check(saved.data.reference);

      return pending();
    }

    if (token.captureState !== "completed")
      return ctx.unknown(
        token.captureFailure ?? "Capture outcome remains uncertain",
        captureOutcome(token),
      );

    if (!saved.success || !token.snapshotId || saved.data.reference.nativeId !== token.snapshotId)
      return ctx.unknown("Captured artifact identity missing");
    check(saved.data.reference);
    let source: z.infer<typeof NativeBox>;

    try {
      source = await box(token.sourceId, { signal: ctx.signal, deadline: Date.now() + 5000 });
      observeSource(token, source.state);
    } catch (error) {
      const outcome = captureOutcome(token);

      if (outcome.status !== "partial") throw error;

      return ctx.unknown(
        "Capture completed; source state could not be confirmed. Use the retained snapshot or inspect the source directly",
        outcome,
      );
    }

    const expected = token.restartRequired ? "started" : "stopped";

    if (
      source.state !== expected ||
      (token.restartRequired && token.restartState !== "completed")
    ) {
      if (token.restartState === "not-submitted")
        return ctx.unknown(
          "Capture completed; source restart requires explicit continuation",
          captureOutcome(token),
        );

      if (token.restartState === "failed")
        return ctx.unknown(
          "Capture completed; source restart failed. Use the retained snapshot or inspect and restart the source directly",
          captureOutcome(token),
        );

      if (token.restartFailure && source.state !== "started")
        return ctx.unknown(
          "Capture completed; source restart is unconfirmed. Inspect the source before taking further action",
          captureOutcome(token),
        );

      return pending();
    }

    // Native capture and source completion are already confirmed; descriptive rereads
    // cannot revoke that result or replace its exact acknowledged identity.
    let info: SnapshotInfo | null = saved.data;

    if (info.state !== "ready" || !history.read(info.reference)) {
      try {
        info = await observedCapture(
          token.name,
          token.sourceId,
          true,
          { signal: ctx.signal, deadline: Date.now() + 5000 },
          token.consistency,
          token.snapshotId,
        );
      } catch {
        return ctx.unknown("Captured snapshot inspection is unavailable", captureOutcome(token));
      }
    }

    if (!info || info.state !== "ready") return pending();

    return {
      snapshot: info,
      capture: token.capture,
      source: {
        state: expected === "started" ? ("running" as const) : ("stopped" as const),
        connections: "dropped" as const,
        observedAt: new Date().toISOString(),
      },
      retainedResources: [info.reference],
    };
  }

  async function reconcileCapture(token: z.infer<typeof Token>, ctx: ReadContext) {
    let captureObserved = false;
    let captureReadFailed = false;
    let source: z.infer<typeof NativeBox> | undefined;

    try {
      source = await box(token.sourceId, ctx);
      observeSource(token, source.state);
    } catch (error) {
      if (
        captureOutcome(token).status !== "partial" &&
        (!(error instanceof AdapterError) || error.code !== "NOT_FOUND")
      )
        throw error;
      token.sourceState = "unknown";
    }

    if (["uncertain", "accepted"].includes(token.stopState) && source?.state === "stopped")
      token.stopState = "completed";

    if (
      ["uncertain", "accepted"].includes(token.restartState) &&
      source?.state === "started" &&
      ["completed", "failed"].includes(token.captureState)
    ) {
      token.restartState = "completed";
      token.stage = "complete";
    }

    if (["uncertain", "accepted"].includes(token.captureState)) {
      const saved = savedSnapshot(token);

      if (
        !token.snapshotId ||
        !saved.success ||
        saved.data.reference.nativeId !== token.snapshotId ||
        !history.read(saved.data.reference)
      )
        return { token, captureObserved, captureReadFailed };

      try {
        const info = await observedCapture(
          token.name,
          token.sourceId,
          true,
          ctx,
          token.consistency,
          token.snapshotId,
        );

        if (info) {
          captureObserved = true;
          token.snapshotId = info.reference.nativeId;
          token.snapshot = compactSnapshot(info);
          token.captureState = info.state === "ready" ? "completed" : "accepted";
        }
      } catch (error) {
        if (error instanceof TerminalCaptureError) {
          token.captureState = "failed";
          token.captureFailure = error.message;
          token.snapshotId = error.snapshot.reference.nativeId;
          token.snapshot = compactSnapshot(error.snapshot);
        } else {
          // Keep the acknowledged identity without inventing readiness from a failed read.
          captureReadFailed = true;
        }
      }
    }

    return { token, captureObserved, captureReadFailed };
  }

  async function runCaptureStages(
    token: z.infer<typeof Token>,
    ctx: AttemptContext,
    finalizeAfterAbort: boolean,
  ) {
    try {
      const context = { signal: ctx.signal, deadline: Date.now() + 60000 };
      let source: z.infer<typeof NativeBox>;

      try {
        source = await box(token.sourceId, context);
        observeSource(token, source.state);
      } catch (error) {
        if (!(error instanceof AdapterError) || error.code !== "NOT_FOUND") throw error;

        return ctx.unknown("Source is unavailable; capture cannot continue", captureOutcome(token));
      }

      const name = token.name;
      const pending = () => ctx.pending(token, { pollAfterMs: 500 });

      // Bounded restoration may outlive caller cancellation only after capture is definitively safe.
      const restart = async () => {
        if (!token.restartRequired) {
          token.restartState = "completed";

          return;
        }

        if (token.restartState !== "not-submitted") return;

        if (ctx.signal.aborted && !finalizeAfterAbort) return;

        const observedSource = await box(source.id, {
          signal: AbortSignal.timeout(5000),
          deadline: Date.now() + 5000,
        });

        observeSource(token, observedSource.state);

        if (observedSource.state !== "stopped") return;
        token.restartState = "uncertain";
        token.stage = "restart";
        token.sourceState = "unknown";
        await ctx.checkpoint(token);

        if (ctx.signal.aborted && !finalizeAfterAbort) {
          token.restartState = "not-submitted";
          token.sourceState = "stopped";
          await ctx.checkpoint(token);

          return;
        }

        const finalization = { signal: AbortSignal.timeout(15000), deadline: Date.now() + 15000 };

        try {
          const response = await request(
            "POST",
            `/sandbox/${encodeURIComponent(source.id)}/start`,
            undefined,
            finalization,
          );

          if (!response.ok) {
            if ([400, 401, 403, 404, 409, 422].includes(response.status))
              token.restartState = "failed";
            await ctx.checkpoint(token);
            token.restartFailure = "Source start response was not successful; no replay";
            const observed = await box(source.id, finalization);
            observeSource(token, observed.state);

            return;
          }

          token.restartState = "accepted";
          await ctx.checkpoint(token);

          if (!(await settledSource(source.id, "started", finalization))) {
            token.restartFailure = "Source start is not confirmed; no replay";

            return;
          }

          observeSource(token, "started");
          token.restartState = "completed";
          token.stage = "complete";
          await ctx.checkpoint(token);
        } catch (error) {
          if (error instanceof AdapterCheckpointError) throw error;
          token.restartFailure = "Source start outcome is uncertain; no replay";

          try {
            const observed = await box(source.id, finalization);
            observeSource(token, observed.state);
          } catch {
            /* State stays unknown when read cannot confirm it. */
          }
        }
      };

      if (token.stopState === "failed") {
        if (
          token.captureState === "not-submitted" &&
          !token.snapshotId &&
          !token.snapshot &&
          source.state === "started"
        )
          return ctx.reject("UNAVAILABLE", "Source stop definitively rejected before capture");

        return ctx.unknown("Source stop rejected but unchanged running state is unconfirmed");
      }

      if (token.stopState === "not-submitted") {
        if (profileFor(source).status !== "supported")
          return ctx.unknown("Source capture eligibility changed before stop");

        if (source.state !== "started") return pending();

        if (ctx.signal.aborted) return ctx.unknown("Capture cancelled before stop; no dispatch");

        try {
          token.sourceState = "unknown";
          token.stopState = "uncertain";
          await ctx.checkpoint(token);

          if (ctx.signal.aborted) {
            token.stopState = "not-submitted";
            token.sourceState = "running";
            await ctx.checkpoint(token);

            return pending();
          }

          const stopped = await request(
            "POST",
            `/sandbox/${encodeURIComponent(source.id)}/stop`,
            undefined,
            context,
          );

          if ([400, 401, 403, 422].includes(stopped.status)) {
            token.stopState = "failed";
            await ctx.checkpoint(token);
            const unchanged = await box(source.id, context);
            observeSource(token, unchanged.state);
            await ctx.checkpoint(token);

            if (unchanged.state === "started")
              return ctx.reject("UNAVAILABLE", "Source stop definitively rejected before capture");

            return ctx.unknown("Source stop rejected but unchanged running state is unconfirmed");
          }

          if (stopped.ok) {
            token.stopState = "accepted";
            await ctx.checkpoint(token);
          }

          if (!stopped.ok || !(await settledSource(source.id, "stopped", context)))
            return pending();
          observeSource(token, "stopped");
          token.stopState = "completed";
          await ctx.checkpoint(token);
        } catch (error) {
          if (error instanceof AdapterCheckpointError) throw error;

          return pending();
        }
      }

      if (token.stopState !== "completed") return pending();

      if (token.captureState === "completed" || token.captureState === "failed") {
        await restart();
        await ctx.checkpoint(token);

        if (ctx.signal.aborted && !finalizeAfterAbort)
          return ctx.unknown("Local wait stopped after capture", captureOutcome(token));

        return captureResult(token, ctx);
      }

      if (token.captureState !== "not-submitted") return pending();
      token.stage = "capture";

      if (ctx.signal.aborted) {
        token.captureFailure = "Capture cancelled before dispatch";
        token.captureState = "failed";
        await ctx.checkpoint(token);
        await restart();

        return pending();
      }

      const captureSource = await box(token.sourceId, context);

      if (captureSource.state !== "stopped" || profileFor(captureSource).status !== "supported")
        return ctx.unknown("Source capture eligibility changed before capture dispatch");
      token.captureState = "uncertain";
      await ctx.checkpoint(token);

      if (ctx.signal.aborted) {
        token.captureState = "failed";
        token.captureFailure = "Capture cancelled before dispatch";
        await ctx.checkpoint(token);
        await restart();

        return pending();
      }

      try {
        const response = await request(
          "POST",
          `/sandbox/${encodeURIComponent(source.id)}/snapshot`,
          { name, includeMemory: false },
          context,
        );

        if (!response.ok) {
          if ([400, 401, 403, 404, 409, 422].includes(response.status)) {
            token.captureState = "failed";
            token.captureFailure = "Native capture definitively rejected";
            await ctx.checkpoint(token);
            await restart();
          }

          return pending();
        }

        token.captureState = "accepted";
        await ctx.checkpoint(token);
        let info = await observedCapture(name, source.id, true, context, token.consistency);

        if (info) {
          token.snapshotId = info.reference.nativeId;
          token.snapshot = compactSnapshot(info);
          await ctx.checkpoint(token);
        }

        while (
          (!info || info.state !== "ready") &&
          !ctx.signal.aborted &&
          Date.now() < context.deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          info = await observedCapture(
            name,
            source.id,
            true,
            context,
            token.consistency,
            token.snapshotId,
          );

          if (info) {
            token.snapshotId = info.reference.nativeId;
            token.snapshot = compactSnapshot(info);
            await ctx.checkpoint(token);
          }
        }

        if (!info || info.state !== "ready") return pending();
        token.captureState = "completed";
        token.snapshot = compactSnapshot(info);
        await ctx.checkpoint(token);
        await restart();

        if (!token.restartRequired) token.stage = "complete";

        if (token.stage !== "complete") return captureResult(token, ctx);

        const final = await box(source.id, {
          signal: AbortSignal.timeout(5000),
          deadline: Date.now() + 5000,
        });

        const expected = token.restartRequired ? "started" : "stopped";

        observeSource(token, final.state);

        if (ctx.signal.aborted)
          return ctx.unknown("Local wait stopped after capture", captureOutcome(token));

        if (final.state !== expected) return pending();

        return {
          snapshot: info,
          capture: token.capture,
          source: {
            state: expected === "started" ? ("running" as const) : ("stopped" as const),
            connections: "dropped" as const,
            observedAt: new Date().toISOString(),
          },
          retainedResources: [info.reference],
        };
      } catch (error) {
        if (error instanceof AdapterCheckpointError) throw error;

        if (error instanceof TerminalCaptureError) {
          token.captureState = "failed";
          token.captureFailure = error.message;
          token.snapshotId = error.snapshot.reference.nativeId;
          token.snapshot = compactSnapshot(error.snapshot);
          await ctx.checkpoint(token);
          await restart();
        }

        const outcome = captureOutcome(token);

        if (outcome.status === "partial")
          return ctx.unknown(
            "Capture completed; later source state could not be confirmed",
            outcome,
          );

        return pending();
      }
    } catch (error) {
      if (error instanceof AdapterCheckpointError) {
        captureCheckpointError(error, token);
        throw error;
      }

      const outcome = captureOutcome(token);

      if (outcome.status === "partial")
        return ctx.unknown("Capture completed; later source state could not be confirmed", outcome);
      throw error;
    }
  }

  const fields: Fields = {
    snapshotProfiles: profiles,
    snapshotInspect: inspectSnapshot,
    snapshotListCoverage: "provider-scope",
    async snapshotList(page, ctx) {
      const index = page.cursor ? Number(page.cursor) : 1;

      if (!Number.isSafeInteger(index) || index < 1)
        throw new AdapterError("INVALID_ARGUMENT", "Invalid snapshot cursor");

      const native = await json(
        await request("GET", `/snapshots?page=${index}&limit=${page.limit}`, undefined, ctx),
        z.object({
          items: z.array(NativeSnapshot).max(page.limit),
          page: z.number().int(),
          totalPages: z.number().int(),
        }),
      );

      return {
        items: native.items.map((v) => snapshotInfo(v)),
        nextCursor: native.page < native.totalPages ? String(native.page + 1) : undefined,
        coverage: "provider-scope",
      };
    },
    snapshotCapture: {
      recovery: { version: 1, token: Token },
      async prepare(value, ctx) {
        const support = await profiles({ sandbox: value.sandbox }, ctx);
        const source = await box(value.sandbox.id, ctx);

        const plan = resolveSnapshot(
          support,
          value.request,
          source.state === "started"
            ? "running"
            : source.state === "stopped"
              ? "stopped"
              : "unknown",
        );

        if (plan.status !== "supported")
          throw new AdapterError(
            plan.status === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE",
            plan.reason,
          );

        if (
          value.expectation &&
          (plan.value.sourceState !== value.expectation.sourceState ||
            JSON.stringify(plan.value.profile) !== JSON.stringify(value.expectation.profile))
        )
          throw new AdapterError("UNAVAILABLE", "Snapshot capture plan changed before submission");

        return {
          ...value,
          expectation: value.expectation ?? {
            profile: plan.value.profile,
            sourceState: plan.value.sourceState,
          },
        };
      },
      async submit(value, ctx) {
        const context = { signal: ctx.signal, deadline: Date.now() + 60000 };
        const name = captureName(ctx.submissionId);

        let prior: Response;

        try {
          prior = await request(
            "GET",
            `/snapshots/${encodeURIComponent(name)}`,
            undefined,
            context,
          );
        } catch (error) {
          if (error instanceof AdapterError && error.code === "UNAVAILABLE")
            return ctx.reject("UNAVAILABLE", error.message);

          throw error;
        }

        if (prior.status !== 404)
          return ctx.reject("CONFLICT", "Capture name absence is unverified");
        const source = await box(value.sandbox.id, context);

        const initial =
          source.state === "started"
            ? "running"
            : source.state === "stopped"
              ? "stopped"
              : "unknown";

        const plan = resolveSnapshot(profileFor(source), value.request, initial);

        if (plan.status !== "supported")
          return ctx.reject(
            plan.status === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE",
            plan.reason,
          );

        if (
          value.expectation &&
          (plan.value.sourceState !== value.expectation.sourceState ||
            JSON.stringify(plan.value.profile) !== JSON.stringify(value.expectation.profile))
        )
          return ctx.reject("UNAVAILABLE", "Snapshot capture plan changed before submission");

        if (initial === "unknown") return ctx.reject("UNAVAILABLE", "Source is not capturable");

        const token: z.infer<typeof Token> = {
          name,
          sourceId: source.id,
          initialState: initial,
          sourceState: initial,
          sourceObservedState: initial,
          sourceObservedAt: new Date().toISOString(),
          restartRequired: initial === "running" && input.restartAfterCapture !== false,
          stopState: initial === "running" ? "not-submitted" : "completed",
          restartState:
            initial === "running" && input.restartAfterCapture !== false
              ? "not-submitted"
              : "completed",
          consistency: plan.value.profile.consistency,
          stage: initial === "running" ? "stop" : "capture",
          captureState: "not-submitted",
          capture: {
            preserve: "filesystem",
            interruption: plan.value.profile.interruption === "none" ? "none" : "stop",
            restoreExecution: "fresh",
          },
        };

        await ctx.checkpoint(token);

        if (ctx.signal.aborted) {
          token.rejectedBeforeDispatch = true;
          await ctx.checkpoint(token);

          return ctx.reject("UNAVAILABLE", "Capture cancelled before native dispatch");
        }

        return runCaptureStages(token, ctx, true);
      },
      async observe(attempt, ctx) {
        const parsed = Token.safeParse(attempt.token);

        if (
          !parsed.success ||
          parsed.data.sourceId !== attempt.sandbox?.id ||
          !matchesCaptureName(parsed.data.name, attempt.submissionId) ||
          !matchesCaptureIntent(parsed.data, attempt.capture)
        )
          return ctx.unknown("Capture stage correlation missing");

        if (captureRejectedBeforeDispatch(parsed.data))
          return ctx.unknown("Capture cancelled before dispatch; continue to confirm no effect");

        try {
          const before = JSON.stringify(parsed.data);

          const { token, captureObserved, captureReadFailed } = await reconcileCapture(
            parsed.data,
            ctx,
          );

          if (captureReadFailed)
            return ctx.unknown(
              "Acknowledged snapshot inspection is unavailable",
              captureOutcome(token),
            );

          if (JSON.stringify(token) !== before) return ctx.pending(token, { pollAfterMs: 500 });

          return await captureResult(token, ctx, captureObserved);
        } catch (error) {
          const outcome = captureOutcome(parsed.data);

          if (!outcome.snapshot) throw error;

          return ctx.unknown(
            "Snapshot capture observation is unavailable; inspect the retained snapshot before taking further action",
            outcome,
          );
        }
      },
      async continue(attempt, ctx) {
        const parsed = Token.safeParse(attempt.token);

        if (
          !parsed.success ||
          parsed.data.sourceId !== attempt.sandbox?.id ||
          !matchesCaptureName(parsed.data.name, attempt.submissionId) ||
          !matchesCaptureIntent(parsed.data, attempt.capture)
        )
          return ctx.unknown("Capture stage correlation missing");

        if (captureRejectedBeforeDispatch(parsed.data))
          return ctx.reject("UNAVAILABLE", "Capture cancelled before native dispatch");

        if (ctx.signal.aborted) return ctx.unknown("Continuation cancelled before dispatch");

        let reconciled: Awaited<ReturnType<typeof reconcileCapture>>;

        try {
          reconciled = await reconcileCapture(parsed.data, {
            signal: ctx.signal,
            deadline: Date.now() + 30000,
          });
        } catch (error) {
          const outcome = captureOutcome(parsed.data);

          if (!outcome.snapshot) throw error;

          return ctx.unknown(
            "Capture continuation observation is unavailable; no stage dispatched",
            outcome,
          );
        }

        const { token, captureObserved } = reconciled;

        if (token.captureState === "accepted" && !captureObserved)
          return ctx.unknown(
            "Acknowledged capture identity is no longer positively observed",
            captureOutcome(token),
          );

        try {
          await ctx.checkpoint(token);
        } catch (error) {
          if (error instanceof AdapterCheckpointError) captureCheckpointError(error, token);
          throw error;
        }

        return runCaptureStages(token, ctx, false);
      },
    },
    snapshotDelete: deletion("snapshot"),
    volumeInspect: inspectVolume,
    // Native volume inventory has no pagination: expose a hard bounded page or reject capacity.
    async volumeList(page, ctx) {
      if (page.cursor) throw new AdapterError("UNSUPPORTED", "Native volume cursor unsupported");

      const values = await json(
        await request("GET", "/volumes", undefined, ctx),
        z.array(NativeVolume),
      );

      if (values.length > page.limit)
        throw new AdapterError("CAPACITY", "Native volume inventory exceeds requested bound");

      return { items: values.map((v) => volumeInfo(v)), coverage: "provider-scope" };
    },
    volumeCreate: {
      recovery: { version: 1, token: VolumeCreateToken },
      async submit(value, ctx) {
        const context = { signal: ctx.signal, deadline: Date.now() + 30000 };

        let prior: Response;

        try {
          prior = await request(
            "GET",
            `/volumes/by-name/${encodeURIComponent(value.name)}`,
            undefined,
            context,
          );
        } catch (error) {
          if (error instanceof AdapterError && error.code === "UNAVAILABLE")
            return ctx.reject("UNAVAILABLE", error.message);

          throw error;
        }

        if (prior.status !== 404)
          return ctx.reject("CONFLICT", "Volume exists or absence is unverified");

        await ctx.checkpoint({ state: "uncertain", name: value.name });

        if (ctx.signal.aborted) {
          await ctx.checkpoint({ state: "rejected", name: value.name });

          return ctx.reject("UNAVAILABLE", "Volume create cancelled before dispatch");
        }

        const response = await request("POST", "/volumes", { name: value.name }, context);

        if ([400, 401, 403, 422].includes(response.status)) {
          void response.body?.cancel().catch(() => undefined);
          await ctx.checkpoint({
            state: "rejected",
            name: value.name,
            rejectionStatus: response.status,
          });

          return ctx.reject("UNAVAILABLE", `Native volume creation rejected (${response.status})`);
        }

        const result = volumeInfo(await json(response, NativeVolume), "verified-created");

        result.reference.history = history.issue({
          version: 1,
          kind: "volume",
          nativeId: result.reference.nativeId,
          name: result.name,
        });

        await ctx.checkpoint({
          state: "accepted",
          name: value.name,
          volume: compactReference(result.reference),
        });

        if (result.name !== value.name)
          return ctx.unknown("Acknowledged volume name differs from the requested name");

        return result;
      },
      async observe(attempt, ctx) {
        const parsed = VolumeCreateToken.safeParse(attempt.token);

        if (parsed.success && parsed.data.state === "rejected" && !parsed.data.volume)
          return ctx.unknown("Cancelled before dispatch; continue to confirm no-effect rejection");

        if (!parsed.success || parsed.data.state !== "accepted" || !parsed.data.volume)
          return ctx.unknown(
            "Volume create acknowledgement unavailable; no adoption by name or replay",
          );

        const { volume: saved, name } = parsed.data;
        const volume = scopedReference(saved);
        check(volume);
        const evidence = history.read(volume);

        if (volume.kind !== "volume" || !evidence || evidence.name !== name)
          return ctx.unknown("Acknowledged volume identity does not match the saved request");

        return await inspectVolume(volume, ctx);
      },
      async continue(attempt, ctx) {
        const parsed = VolumeCreateToken.safeParse(attempt.token);

        if (parsed.success && parsed.data.state === "rejected" && !parsed.data.volume)
          return ctx.reject(
            "UNAVAILABLE",
            parsed.data.rejectionStatus
              ? `Native volume creation rejected (${parsed.data.rejectionStatus})`
              : "Volume create cancelled before dispatch",
          );

        return ctx.unknown("Volume creation cannot be replayed");
      },
    },
    volumeDelete: deletion("volume"),
    async resourceCapabilities() {
      return {
        restore: { status: "unsupported", reason: "Restore mapping is assigned by the adapter" },
        volumes: {
          status: "supported",
          value: { create: true, inspect: true, list: true, delete: true },
        },
        mounts: {
          status: "supported",
          value: {
            timing: "create",
            access: ["read-write"],
            subpaths: true,
            versions: false,
            durability: "unknown",
            compatibility: ["container", "linux-vm"],
          },
        },
      };
    },
    async checkMounts(create, ctx) {
      const paths: string[] = [];

      for (const mount of create.mounts ?? []) {
        check(mount.volume);

        if (mount.access !== "read-write")
          return { status: "unsupported", reason: "Native read-only enforcement is absent" };

        if (
          paths.some(
            (path) =>
              path === mount.path ||
              path.startsWith(mount.path + "/") ||
              mount.path.startsWith(path + "/"),
          )
        )
          return { status: "unsupported", reason: "Mount paths overlap" };
        paths.push(mount.path);
        const volume = await inspectVolume(mount.volume, ctx);

        if (volume.state !== "ready")
          return { status: "unavailable", reason: "Volume is not ready" };
      }

      return { status: "supported", value: {} };
    },
  };

  return { fields, box, inspectSnapshot, inspectVolume };
}
