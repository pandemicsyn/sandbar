import { z } from "zod";
import { resourceReceipts } from "./resource-receipts";
import {
  AdapterError,
  assertResourceScope,
  resolveSnapshot,
  ResourceReference,
  type AdapterSession,
  type Scope,
  type SnapshotInfo,
  type VolumeInfo,
  type SnapshotProfile,
  type ReadContext,
} from "sandbar-adapter";
import { type E2BTransport, type E2BRecord } from "./transport";

const CaptureToken = z.strictObject({
  snapshotId: z.string().max(512),
  sourceId: z.string().max(512),
  generation: z.string().max(512).optional(),
  snapshot: ResourceReference.optional(),
  consistency: z.enum(["crash-consistent", "caller-quiesced", "unknown"]),
});

const DeleteToken = z.strictObject({ accepted: z.boolean() });

const restoreToken = z.strictObject({
  snapshotId: z.string().max(512),
  templateId: z.string().max(512).optional(),
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
  const receipts = resourceReceipts(input.apiKey, "e2b", scope);

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
        networkPolicies: [],
        resources: false,
        mounts: false,
        independentLifecycle: false,
      },
      dependencies: [],
      nativeDependencies: [],
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
    const page = await need().snapshots({ limit: 2, name: reference.nativeId });
    const v = page.items.find((v) => v.snapshotId === reference.nativeId);

    if (!v || page.nextCursor)
      throw new AdapterError("NOT_FOUND", "Snapshot identity is not confirmed");
    const tags = await need().tags(reference.nativeId.split(":")[0]!);
    const native = tags.find((tag) => tag.tag === "default");

    if (!native || tags.length !== 1)
      throw new AdapterError("UNAVAILABLE", "Snapshot build/tag ownership or dependencies unknown");

    if (reference.generation && reference.generation !== native.buildId)
      throw new AdapterError("CONFLICT", "Snapshot tag was reassigned to another native build");
    const info = snapshotInfo(v.snapshotId, reference.ownership);
    info.reference.generation = native.buildId;
    const evidence = receipts.read(reference);

    if (
      evidence?.kind === "snapshot" &&
      evidence.preserve === "filesystem+memory" &&
      evidence.mounts === "none"
    ) {
      info.mountHandling = "none";
      info.consistency = evidence.consistency ?? "unknown";
      info.reference.receipt = reference.receipt;
      info.source = { id: evidence.sourceId!, class: evidence.sourceClass! };
    }

    return info;
  }

  async function volumeInspect(reference: ResourceReference) {
    check(reference);
    const value = await need().volume(reference.nativeId);

    if (value.volumeId !== reference.nativeId)
      throw new AdapterError("CONFLICT", "Volume identity differs");
    const info = volumeInfo(value, reference.ownership);
    const evidence = receipts.read(reference);

    if (evidence && evidence.name !== value.name)
      throw new AdapterError("CONFLICT", "Volume native name differs from acknowledged identity");

    if (evidence) info.reference.receipt = reference.receipt;

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
        const name = `sandbar-capture-${ctx.submissionId}`;
        const prior = await need().snapshots({ limit: 1, name });

        if (prior.items.length || prior.nextCursor)
          return ctx.reject("CONFLICT", "Snapshot name exists");

        if (ctx.signal.aborted)
          return ctx.reject("UNAVAILABLE", "Capture cancelled before dispatch");
        const created = await need().capture(box.id, undefined, ctx.signal);

        if (!/^[A-Za-z0-9_-]+:default$/.test(created.snapshotId))
          return ctx.unknown(
            "Snapshot returned alias instead of allocated native identity; storage may be retained",
          );
        knownSnapshots.set(created.snapshotId, { sourceId: box.id });

        const token: z.infer<typeof CaptureToken> = {
          snapshotId: created.snapshotId,
          sourceId: box.id,
          consistency: plan.value.profile.consistency,
        };

        let info: SnapshotInfo;
        let actual: E2BRecord | null;

        try {
          info = await snapshotInspect(ref("snapshot", created.snapshotId, "verified-created"));
          token.generation = info.reference.generation;
          info.consistency = token.consistency;
          info.reference.receipt = receipts.issue({
            version: 1,
            kind: "snapshot",
            nativeId: info.reference.nativeId,
            generation: info.reference.generation,
            sourceId: box.id,
            sourceClass: "firecracker",
            preserve: "filesystem+memory",
            mounts: "none",
            consistency: info.consistency,
          });
          token.snapshot = structuredClone(info.reference);
          actual = await input.find(box.id);
        } catch {
          return ctx.pending(token, { pollAfterMs: 500 });
        }

        if (!actual || actual.state !== "running") return ctx.pending(token, { pollAfterMs: 500 });

        if (ctx.signal.aborted) return ctx.pending(token, { pollAfterMs: 0 });

        return {
          snapshot: info,
          capture: {
            preserve: "filesystem+memory",
            interruption: "pause",
            restoreExecution: "resume",
          },
          source: { state: "running", connections: "dropped" },
          retainedResources: [info.reference],
        };
      },
      async observe(attempt, ctx) {
        const token = CaptureToken.safeParse(attempt.token);

        if (
          !token.success ||
          !token.data.generation ||
          !token.data.snapshot ||
          token.data.sourceId !== attempt.sandbox?.id
        )
          return ctx.unknown(
            "Capture may retain storage; no acknowledged artifact identity; do not replay",
          );

        check(token.data.snapshot);
        receipts.owned(token.data.snapshot);
        const evidence = receipts.read(token.data.snapshot);

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

        const box = await input.find(token.data.sourceId);

        if (!box || box.volumeMounts?.length)
          return ctx.unknown("Source mount provenance unavailable");
        knownSnapshots.set(token.data.snapshotId, { sourceId: token.data.sourceId });

        const info = await snapshotInspect(token.data.snapshot);

        if (box.state !== "running") return ctx.unknown("Original source outcome is unconfirmed");

        return {
          snapshot: info,
          capture: {
            preserve: "filesystem+memory",
            interruption: "pause",
            restoreExecution: "resume",
          },
          source: { state: "running", connections: "dropped" },
          retainedResources: [info.reference],
        };
      },
    },
    snapshotInspect,
    snapshotListCoverage: "provider-scope",
    async snapshotList(page) {
      const values = await need().snapshots({ limit: page.limit, cursor: page.cursor });
      const items: SnapshotInfo[] = [];

      for (const value of values.items)
        items.push(await snapshotInspect(ref("snapshot", value.snapshotId)));

      return {
        items,
        nextCursor: values.nextCursor,
        coverage: "provider-scope",
      };
    },
    snapshotRestore: {
      recovery: { version: 1, token: restoreToken },
      async prepare() {
        throw new AdapterError(
          "UNSUPPORTED",
          "E2B restore cannot bind the immutable captured build",
        );
      },
      async submit(_value, ctx) {
        return ctx.reject("UNSUPPORTED", "E2B restore cannot bind the immutable captured build");
      },
      async observe(_attempt, ctx) {
        return ctx.unknown("Native restore build generation cannot be confirmed; no replay");
      },
    },
    volumeCreate: {
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

        if (ctx.signal.aborted)
          return ctx.reject("UNAVAILABLE", "Volume create cancelled before dispatch");

        const info = volumeInfo(
          await need().createVolume(value.name, ctx.signal),
          "verified-created",
        );

        info.reference.receipt = receipts.issue({
          version: 1,
          kind: "volume",
          nativeId: info.reference.nativeId,
          name: info.name,
        });

        return info;
      },
      async observe(_attempt, ctx) {
        return ctx.unknown(
          "Volume create acknowledgement unavailable; names cannot establish ownership; no replay",
        );
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
      const restore = {
        status: "unsupported" as const,
        reason: "E2B create selects a mutable template tag and exposes no restored build identity",
      };

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

  const deletion = (
    kind: "snapshot" | "volume",
  ): NonNullable<AdapterSession["snapshotDelete"]> => ({
    recovery: { version: 1, token: DeleteToken },
    async prepare(reference) {
      check(reference);

      if (reference.kind !== kind || reference.ownership !== "verified-created")
        throw new AdapterError("CONFLICT", "Artifact is not verified-created");
      receipts.owned(reference);
      await (kind === "snapshot" ? snapshotInspect(reference) : volumeInspect(reference));

      return reference;
    },
    async submit(reference, ctx) {
      check(reference);
      receipts.owned(reference);
      await (kind === "snapshot" ? snapshotInspect(reference) : volumeInspect(reference));

      if (ctx.signal.aborted)
        return ctx.reject("UNAVAILABLE", "Deletion cancelled before dispatch");
      let accepted = false;

      try {
        accepted = await (kind === "snapshot"
          ? need().deleteSnapshot(reference.nativeId, ctx.signal)
          : need().deleteVolume(reference.nativeId, ctx.signal));
      } catch {
        /* observe only */
      }

      return ctx.pending({ accepted }, { pollAfterMs: 500 });
    },
    async observe(attempt, ctx) {
      const reference = attempt.resource;

      if (!reference || reference.kind !== kind || reference.ownership !== "verified-created")
        return ctx.unknown("Deletion ownership missing");
      check(reference);
      receipts.owned(reference);
      const token = DeleteToken.safeParse(attempt.token);

      if (!token.success || !token.data.accepted)
        return ctx.unknown(
          "Deletion acknowledgement unavailable; absence alone is not correlated deletion evidence",
        );

      if (kind === "snapshot") {
        const page = await need().snapshots({ limit: 1, name: reference.nativeId });

        if (!page.items.length && !page.nextCursor) return { deleted: true, reference };
      } else {
        const values = await need().volumes();

        if (!values.some((v) => v.volumeId === reference.nativeId))
          return { deleted: true, reference };
      }

      return ctx.pending(token.data, { pollAfterMs: 500 });
    },
  });

  fields.snapshotDelete = deletion("snapshot");
  fields.volumeDelete = deletion("volume");

  return { fields: state ? fields : {}, volumeInspect };
}
