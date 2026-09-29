import { z } from "zod";
import { resourceReceipts } from "./resource-receipts";
import {
  AdapterError,
  assertResourceScope,
  resolveSnapshot,
  type AdapterSession,
  type Scope,
  type ResourceReference,
  type SnapshotInfo,
  SnapshotInfo as SnapshotInfoSchema,
  type VolumeInfo,
  type ReadContext,
  type CreateInput,
  type SnapshotProfile,
} from "sandbar-adapter";

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
  stage: z.enum(["stop", "capture", "restart", "complete"]),
  snapshotId: z.string().min(1).max(512).optional(),
  captureState: z.enum(["not-submitted", "uncertain", "accepted", "completed", "failed"]),
  sourceState: z.enum(["running", "stopped", "unknown"]),
  capture: CaptureFacts,
  consistency: z.enum(["crash-consistent", "caller-quiesced", "unknown"]),
  snapshot: z.json().optional(),
  captureFailure: z.string().max(512).optional(),
  restartFailure: z.string().max(512).optional(),
});

const DeleteToken = z.strictObject({ reference: z.json(), accepted: z.boolean() });

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
  const receipts = resourceReceipts(input.apiKey, "daytona", scope);
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

    return input.fetch(input.apiUrl + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: ctx
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now()))])
        : AbortSignal.timeout(30000),
    });
  }

  async function json<S extends z.ZodType>(response: Response, schema: S): Promise<z.output<S>> {
    if (!response.ok)
      throw new AdapterError(
        response.status === 404
          ? "NOT_FOUND"
          : response.status === 403
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

  async function inspectSnapshot(ref: ResourceReference, ctx?: ReadContext) {
    check(ref);

    const v = await json(
      await request("GET", `/snapshots/${encodeURIComponent(ref.nativeId)}`, undefined, ctx),
      NativeSnapshot,
    );

    if (v.id !== ref.nativeId) throw new AdapterError("CONFLICT", "Snapshot identity differs");
    const info = snapshotInfo(v, ref.ownership);

    try {
      info.nativeDependencies = await dependencies(v, ctx);
    } catch {
      /* Unknown dependencies block deletion. */
    }

    const evidence = receipts.read(ref);

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
      info.reference.receipt = ref.receipt;
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
    const evidence = receipts.read(ref);

    if (evidence && evidence.name !== v.name)
      throw new AdapterError("CONFLICT", "Volume native name differs from acknowledged identity");

    if (evidence) info.reference.receipt = ref.receipt;

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
      info.reference.receipt = receipts.issue({
        version: 1,
        kind: "snapshot",
        nativeId: v.id,
        sourceId,
        sourceClass: "container",
        preserve: "filesystem",
        mounts: "none",
        consistency,
      });

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

  const deletion = (
    kind: "snapshot" | "volume",
  ): NonNullable<AdapterSession["snapshotDelete"]> => ({
    recovery: { version: 1, token: DeleteToken },
    async prepare(ref, ctx) {
      check(ref);

      if (ref.kind !== kind || ref.ownership !== "verified-created")
        throw new AdapterError("CONFLICT", "Artifact is not verified run-owned");
      receipts.owned(ref);

      const info = await (kind === "snapshot"
        ? inspectSnapshot(ref, ctx)
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
      receipts.owned(ref);
      const context = { signal: ctx.signal, deadline: Date.now() + 30000 };

      const info = await (kind === "snapshot"
        ? inspectSnapshot(ref, context)
        : inspectVolume(ref, context));

      if (
        kind === "snapshot" &&
        "nativeDependencies" in info &&
        (info.nativeDependencies === null || info.nativeDependencies.length)
      )
        return ctx.reject("CONFLICT", "Snapshot deletion dependencies are present or unverified");

      if (ctx.signal.aborted)
        return ctx.reject("UNAVAILABLE", "Deletion cancelled before dispatch");

      try {
        const response = await request(
          "DELETE",
          `${kind === "snapshot" ? "/snapshots" : "/volumes"}/${encodeURIComponent(ref.nativeId)}`,
          undefined,
          { signal: ctx.signal, deadline: Date.now() + 30000 },
        );

        if (response.ok)
          return ctx.pending({ reference: ref, accepted: true }, { pollAfterMs: 500 });

        return ctx.pending({ reference: ref, accepted: false }, { pollAfterMs: 500 });
      } catch {
        return ctx.pending({ reference: ref, accepted: false }, { pollAfterMs: 500 });
      }
    },
    async observe(attempt, ctx) {
      const ref = attempt.resource;

      if (!ref || ref.kind !== kind || ref.ownership !== "verified-created")
        return ctx.unknown("Missing owned deletion authority");
      check(ref);
      receipts.owned(ref);
      const token = DeleteToken.safeParse(attempt.token);

      if (!token.success || !token.data.accepted)
        return ctx.unknown("Artifact delete acknowledgement is unavailable; no replay");

      const response = await request(
        "GET",
        `${kind === "snapshot" ? "/snapshots" : "/volumes"}/${encodeURIComponent(ref.nativeId)}`,
        undefined,
        ctx,
      );

      if (response.status === 404) return { deleted: true, reference: ref };

      if (!response.ok) return ctx.unknown("Deletion is unconfirmed");

      if (kind === "volume") {
        const native = await json(response, NativeVolume);

        if (native.id !== ref.nativeId || native.organizationId !== scope.authority.id)
          return ctx.unknown("Deleted volume identity or scope differs");

        if (native.state === "deleted") return { deleted: true, reference: ref };
      }

      return ctx.pending({ reference: ref, accepted: true }, { pollAfterMs: 500 });
    },
  });

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
        const name = `sandbar-capture-${ctx.submissionId}`;

        const prior = await request(
          "GET",
          `/snapshots/${encodeURIComponent(name)}`,
          undefined,
          context,
        );

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
          restartRequired: initial === "running" && input.restartAfterCapture !== false,
          consistency: plan.value.profile.consistency,
          stage: initial === "running" ? "stop" : "capture",
          captureState: "not-submitted",
          capture: {
            preserve: "filesystem",
            interruption: plan.value.profile.interruption === "none" ? "none" : "stop",
            restoreExecution: "fresh",
          },
        };

        const pending = () => ctx.pending(token, { pollAfterMs: 500 });

        // Bounded restoration may outlive caller cancellation only after capture is definitively safe.
        const restart = async () => {
          if (!token.restartRequired) return;
          token.stage = "restart";
          token.sourceState = "unknown";
          const finalization = { signal: AbortSignal.timeout(15000), deadline: Date.now() + 15000 };

          try {
            const response = await request(
              "POST",
              `/sandbox/${encodeURIComponent(source.id)}/start`,
              undefined,
              finalization,
            );

            if (!response.ok) {
              token.restartFailure = "Source start response was not successful; no replay";
              const observed = await box(source.id, finalization);
              token.sourceState =
                observed.state === "started"
                  ? "running"
                  : observed.state === "stopped"
                    ? "stopped"
                    : "unknown";

              return;
            }

            if (!(await settledSource(source.id, "started", finalization))) {
              token.restartFailure = "Source start is not confirmed; no replay";

              return;
            }

            token.sourceState = "running";
            token.stage = "complete";
          } catch {
            token.restartFailure = "Source start outcome is uncertain; no replay";

            try {
              const observed = await box(source.id, finalization);
              token.sourceState =
                observed.state === "started"
                  ? "running"
                  : observed.state === "stopped"
                    ? "stopped"
                    : "unknown";
            } catch {
              /* State stays unknown when read cannot confirm it. */
            }
          }
        };

        if (initial === "running") {
          if (ctx.signal.aborted) return ctx.reject("UNAVAILABLE", "Capture cancelled before stop");

          try {
            token.sourceState = "unknown";

            const stopped = await request(
              "POST",
              `/sandbox/${encodeURIComponent(source.id)}/stop`,
              undefined,
              context,
            );

            if (!stopped.ok || !(await settledSource(source.id, "stopped", context)))
              return pending();
            token.sourceState = "stopped";
          } catch {
            return pending();
          }
        }

        token.stage = "capture";

        if (ctx.signal.aborted) {
          token.captureFailure = "Capture cancelled before dispatch";
          token.captureState = "failed";
          await restart();

          return pending();
        }

        token.captureState = "uncertain";

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
              await restart();
            }

            return pending();
          }

          token.captureState = "accepted";
          let info = await observedCapture(name, source.id, true, context, token.consistency);

          if (info) {
            token.snapshotId = info.reference.nativeId;
            token.snapshot = JSON.parse(JSON.stringify(info));
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
              token.snapshot = JSON.parse(JSON.stringify(info));
            }
          }

          if (!info || info.state !== "ready") return pending();
          token.captureState = "completed";
          token.snapshot = JSON.parse(JSON.stringify(info));
          await restart();

          if (!token.restartRequired) token.stage = "complete";

          if (token.stage !== "complete") return pending();

          const final = await box(source.id, {
            signal: AbortSignal.timeout(5000),
            deadline: Date.now() + 5000,
          });

          const expected = token.restartRequired ? "started" : "stopped";

          if (final.state !== expected || ctx.signal.aborted) return pending();

          return {
            snapshot: info,
            capture: token.capture,
            source: {
              state: expected === "started" ? "running" : "stopped",
              connections: "dropped",
            },
            retainedResources: [info.reference],
          };
        } catch {
          return pending();
        }
      },
      async observe(attempt, ctx) {
        const parsed = Token.safeParse(attempt.token);

        if (!parsed.success || parsed.data.sourceId !== attempt.sandbox?.id)
          return ctx.unknown(
            "Capture stage evidence missing; stop/capture/start will not be replayed",
          );
        const token = parsed.data;

        const saved = token.snapshot ? SnapshotInfoSchema.safeParse(token.snapshot) : undefined;
        const artifactId = saved?.success ? saved.data.reference.nativeId : undefined;

        if (!saved?.success || !artifactId || (token.snapshotId && token.snapshotId !== artifactId))
          return ctx.unknown(
            "Captured artifact identity missing or inconsistent; names cannot establish ownership",
          );

        if (saved?.success) {
          check(saved.data.reference);
          receipts.owned(saved.data.reference);
        }

        if (token.captureState === "accepted") {
          const captured = await observedCapture(
            token.name,
            token.sourceId,
            true,
            ctx,
            token.consistency,
            artifactId,
          );

          if (captured?.state === "ready")
            return ctx.pending(
              {
                ...token,
                captureState: "completed",
                snapshot: JSON.parse(JSON.stringify(captured)),
              },
              { pollAfterMs: 500 },
            );
        }

        if (token.captureState !== "completed")
          return ctx.unknown(
            token.captureFailure
              ? "Capture failed; inspect saved capture and restart outcomes"
              : "Capture stage is uncertain; do not restart while capture may be in progress",
          );

        const info = await observedCapture(
          token.name,
          token.sourceId,
          true,
          ctx,
          token.consistency,
          artifactId,
        );

        if (!info || info.state !== "ready")
          return ctx.unknown("Acknowledged snapshot is not ready; no replay");
        const source = await box(token.sourceId, ctx);
        const expected = token.restartRequired ? "started" : "stopped";

        if (
          source.state !== expected ||
          (token.restartRequired && token.stage !== "restart" && token.stage !== "complete")
        )
          return ctx.unknown(
            "Snapshot captured but source lifecycle is unconfirmed; saved snapshot remains in custody",
          );

        return {
          snapshot: info,
          capture: token.capture,
          source: { state: expected === "started" ? "running" : "stopped", connections: "dropped" },
          retainedResources: [info.reference],
        };
      },
    },
    snapshotDelete: deletion("snapshot"),
    volumeInspect: inspectVolume,
    // Native volume inventory has no pagination: expose a hard bounded page or reject capacity.
    async volumeList(page, ctx) {
      if (page.cursor) throw new AdapterError("UNSUPPORTED", "Native volume cursor unsupported");

      const values = await json(
        await request("GET", "/volumes", undefined, ctx),
        z.array(NativeVolume).max(page.limit),
      );

      return { items: values.map((v) => volumeInfo(v)), coverage: "provider-scope" };
    },
    volumeCreate: {
      async submit(value, ctx) {
        const context = { signal: ctx.signal, deadline: Date.now() + 30000 };

        const prior = await request(
          "GET",
          `/volumes/by-name/${encodeURIComponent(value.name)}`,
          undefined,
          context,
        );

        if (prior.status !== 404)
          return ctx.reject("CONFLICT", "Volume exists or absence is unverified");

        if (ctx.signal.aborted)
          return ctx.reject("UNAVAILABLE", "Volume create cancelled before dispatch");

        const result = volumeInfo(
          await json(
            await request("POST", "/volumes", { name: value.name }, context),
            NativeVolume,
          ),
          "verified-created",
        );

        result.reference.receipt = receipts.issue({
          version: 1,
          kind: "volume",
          nativeId: result.reference.nativeId,
          name: result.name,
        });

        return result;
      },
      async observe(_attempt, ctx) {
        return ctx.unknown(
          "Volume create acknowledgement unavailable; names do not establish ownership; do not replay",
        );
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
