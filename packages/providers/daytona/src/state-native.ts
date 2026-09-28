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

const Token = z.strictObject({
  name: z.string().max(128),
  sourceId: z.string().max(512),
  acknowledged: z.boolean(),
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
    };
  }

  async function inspectSnapshot(ref: ResourceReference, ctx?: ReadContext) {
    check(ref);

    const v = await json(
      await request("GET", `/snapshots/${encodeURIComponent(ref.nativeId)}`, undefined, ctx),
      NativeSnapshot,
    );

    if (v.id !== ref.nativeId) throw new AdapterError("CONFLICT", "Snapshot identity differs");
    const info = snapshotInfo(v, ref.ownership);
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
      interruption: "stop",
      sourceAfter: "stopped",
      connections: "dropped",
      consistency: "caller-quiesced",
      mountHandling: "none",
    };

    return { status: "supported" as const, value: { profiles: [profile] } };
  }

  async function observedCapture(
    name: string,
    sourceId: string,
    acknowledged: boolean,
    ctx: ReadContext,
  ) {
    const response = await request("GET", `/snapshots/${encodeURIComponent(name)}`, undefined, ctx);

    if (response.status === 404) return null;
    const v = await json(response, NativeSnapshot);

    if (
      v.name !== name ||
      v.sourceSandboxId !== sourceId ||
      v.organizationId !== scope.authority.id ||
      v.sandboxClass !== "container"
    )
      return null;
    const source = await box(sourceId, ctx);

    if (source.volumes.length) return null;

    if (acknowledged) captured.add(v.id);
    const info = snapshotInfo(v, acknowledged ? "verified-created" : "unknown");

    if (acknowledged)
      info.reference.receipt = receipts.issue({
        version: 1,
        kind: "snapshot",
        nativeId: v.id,
        sourceId,
        sourceClass: "container",
        preserve: "filesystem",
        mounts: "none",
      });

    if (info.state !== "ready" || source.state !== "stopped" || !acknowledged) return null;

    return {
      snapshot: info,
      source: { state: "stopped" as const, connections: "dropped" as const },
      retainedResources: [info.reference],
    };
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
      await (kind === "snapshot" ? inspectSnapshot(ref, ctx) : inspectVolume(ref, ctx));

      return ref;
    },
    async submit(ref, ctx) {
      check(ref);
      receipts.owned(ref);
      const context = { signal: ctx.signal, deadline: Date.now() + 30000 };
      await (kind === "snapshot" ? inspectSnapshot(ref, context) : inspectVolume(ref, context));

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

        return value;
      },
      async submit(value, ctx) {
        const context = { signal: ctx.signal, deadline: Date.now() + 30000 };
        const name = `sandbar-capture-${ctx.submissionId}`;

        const prior = await request(
          "GET",
          `/snapshots/${encodeURIComponent(name)}`,
          undefined,
          context,
        );

        if (prior.status !== 404)
          return ctx.reject("CONFLICT", "Capture name already exists or absence is unverified");
        const source = await box(value.sandbox.id, context);

        if (source.sandboxClass !== "container" || source.volumes.length)
          return ctx.reject("UNSUPPORTED", "Capture class/mounts changed");

        const plan = resolveSnapshot(
          await profiles({ sandbox: value.sandbox }, context),
          value.request,
          source.state === "started"
            ? "running"
            : source.state === "stopped"
              ? "stopped"
              : "unknown",
        );

        if (plan.status !== "supported")
          return ctx.reject(
            plan.status === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE",
            plan.reason,
          );

        if (source.state === "started") {
          try {
            const stopped = await request(
              "POST",
              `/sandbox/${encodeURIComponent(source.id)}/stop`,
              undefined,
              context,
            );

            if (!stopped.ok)
              return ctx.unknown("Stop may have effects; source outcome is unconfirmed");
            let current = await box(source.id, context);

            for (
              let index = 0;
              current.state !== "stopped" && index < 40 && !ctx.signal.aborted;
              index++
            ) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              current = await box(source.id, context);
            }

            if (current.state !== "stopped")
              return ctx.unknown("Source stop is not yet confirmed; no snapshot submitted");
          } catch {
            return ctx.unknown("Source may be stopped; capture was not replayed");
          }
        } else if (source.state !== "stopped")
          return ctx.reject("UNAVAILABLE", "Source is not capturable");

        if (ctx.signal.aborted)
          return ctx.unknown("Source may be stopped; capture cancelled before dispatch");
        let acknowledged = false;

        try {
          const response = await request(
            "POST",
            `/sandbox/${encodeURIComponent(source.id)}/snapshot`,
            { name, includeMemory: false },
            context,
          );

          acknowledged = response.ok;
        } catch {
          /* capture may retain billed storage */
        }

        const token = { name, sourceId: source.id, acknowledged };

        if (!acknowledged) return ctx.pending(token, { pollAfterMs: 500 });

        try {
          const result = await observedCapture(name, source.id, true, context);

          return result ?? ctx.pending(token, { pollAfterMs: 500 });
        } catch {
          return ctx.pending(token, { pollAfterMs: 500 });
        }
      },
      async observe(attempt, ctx) {
        const token = Token.safeParse(attempt.token);

        if (!token.success || token.data.sourceId !== attempt.sandbox?.id)
          return ctx.unknown(
            "Capture may have stopped source or retained storage; identity evidence missing",
          );

        const value = await observedCapture(
          token.data.name,
          token.data.sourceId,
          token.data.acknowledged,
          ctx,
        );

        return (
          value ?? ctx.unknown("Capture retained artifact/source outcome is unconfirmed; no replay")
        );
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
