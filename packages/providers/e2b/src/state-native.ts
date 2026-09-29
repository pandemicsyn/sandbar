import { z } from "zod";
import { resourceHistory } from "./resource-history";
import {
  AdapterError,
  AdapterCheckpointError,
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

const VolumeCreateToken = z.strictObject({
  state: z.enum(["uncertain", "accepted"]),
  name: z.string().min(1).max(128),
  volume: ResourceReference.optional(),
});

const CaptureToken = z.strictObject({
  snapshotId: z.string().max(512),
  sourceId: z.string().max(512),
  generation: z.string().max(512).optional(),
  snapshot: ResourceReference.optional(),
  consistency: z.enum(["crash-consistent", "caller-quiesced", "unknown"]),
});

const DeleteToken = z.strictObject({ accepted: z.boolean() });

const restoreToken = z.strictObject({
  selector: z.string().min(1).max(256),
  state: z.enum(["uncertain", "accepted"]),
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

  async function deleteSnapshotPreflight(reference: ResourceReference) {
    check(reference);

    if (reference.kind !== "snapshot" || !/^[A-Za-z0-9_-]+$/.test(reference.nativeId))
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "Snapshot deletion requires a raw containing-template identity",
      );
    const native = await need().template(reference.nativeId);

    if (!native) throw new AdapterError("NOT_FOUND", "Snapshot template is unavailable");

    if (native.templateId !== reference.nativeId || native.public)
      throw new AdapterError(
        "CONFLICT",
        "Snapshot template identity or private visibility differs",
      );
    await need().verifyAddress(reference.nativeId, native.names);
    const baseline = history.read(reference)?.deletion;

    if (
      reference.generation &&
      !native.builds.some((build) => build.buildId === reference.generation)
    )
      throw new AdapterError(
        "CONFLICT",
        "Original captured build is no longer in the containing template",
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
    } else if (native.builds.length !== 1) {
      throw new AdapterError(
        "CONFLICT",
        "Explicit snapshot deletion cannot expand into a shared multi-build template",
      );
    }

    const dependencies = await transport.list({}, 100);

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
      value.request.resources ||
      value.request.mounts
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

        if (ctx.signal.aborted) return ctx.unknown("Capture cancelled before dispatch");
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
        await ctx.checkpoint(token);
        let info: SnapshotInfo;
        let actual: E2BRecord | null;

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
            return ctx.pending(token, { pollAfterMs: 500 });
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
        } catch (error) {
          if (error instanceof AdapterCheckpointError) throw error;

          return ctx.pending(token, { pollAfterMs: 500 });
        }

        if (!actual || actual.state !== "running" || info.state !== "ready")
          return ctx.pending(token, { pollAfterMs: 500 });

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

        const box = await input.find(token.data.sourceId);

        if (!box || box.volumeMounts?.length)
          return ctx.unknown("Source mount provenance unavailable");
        knownSnapshots.set(token.data.snapshotId, { sourceId: token.data.sourceId });

        const info = await snapshotInspect(token.data.snapshot);

        if (box.state !== "running" || info.state !== "ready")
          return ctx.unknown("Original source or captured build outcome is unconfirmed");

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
        await deleteSnapshotPreflight(value);

        if (ctx.signal.aborted)
          return ctx.reject("UNAVAILABLE", "Delete cancelled before dispatch");
        await ctx.checkpoint({ accepted: false });

        if (ctx.signal.aborted) return ctx.unknown("Snapshot delete cancelled before dispatch");
        const accepted = await need().deleteSnapshot(value.nativeId, ctx.signal);
        await ctx.checkpoint({ accepted });

        return ctx.pending({ accepted }, { pollAfterMs: 0 });
      },
      async observe(attempt, ctx) {
        const token = DeleteToken.safeParse(attempt.token);

        if (!attempt.resource || !token.success || !token.data.accepted)
          return ctx.unknown("Snapshot delete acknowledgement is unavailable; no replay");
        check(attempt.resource);

        if (await need().template(attempt.resource.nativeId))
          return ctx.pending(token.data, { pollAfterMs: 500 });

        return { deleted: true, reference: attempt.resource };
      },
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

        if (ctx.signal.aborted) return ctx.unknown("Restore cancelled before dispatch");

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

        if (ctx.signal.aborted)
          return ctx.reject("UNAVAILABLE", "Volume create cancelled before dispatch");

        const info = volumeInfo(
          await need().createVolume(value.name, ctx.signal),
          "verified-created",
        );

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
      await volumeInspect(reference);

      if (ctx.signal.aborted)
        return ctx.reject("UNAVAILABLE", "Deletion cancelled before dispatch");
      let accepted = false;

      try {
        accepted = await need().deleteVolume(reference.nativeId, ctx.signal);
      } catch {
        /* observe only */
      }

      return ctx.pending({ accepted }, { pollAfterMs: 500 });
    },
    async observe(attempt, ctx) {
      const reference = attempt.resource;

      if (!reference || reference.kind !== "volume")
        return ctx.unknown("Deletion ownership missing");
      check(reference);
      const token = DeleteToken.safeParse(attempt.token);

      if (!token.success || !token.data.accepted)
        return ctx.unknown(
          "Deletion acknowledgement unavailable; absence alone is not correlated deletion evidence",
        );

      const values = await need().volumes();

      if (!values.some((v) => v.volumeId === reference.nativeId))
        return { deleted: true, reference };

      return ctx.pending(token.data, { pollAfterMs: 500 });
    },
  };

  return { fields: state ? fields : {}, volumeInspect };
}
