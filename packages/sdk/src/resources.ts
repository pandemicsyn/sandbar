import { freezeReference } from "./freeze-reference";
import { CreateEnv } from "@sandbar-sdk/adapter/portable";
import { z } from "zod";
import {
  ResourceReference,
  AdapterError,
  assertResourceScope,
  assertResourceIdentity,
  MountSpec,
  SnapshotInfo,
  ImageInfo,
  VolumeInfo,
  RestoreRequest,
  restoreOptionProblem,
  VolumeCreateInput,
  InventoryInput,
  SandboxListItem,
  type ArtifactDeletionResult,
  type OperationKind,
  type SnapshotCaptureValue,
} from "@sandbar-sdk/adapter";
import {
  SandbarError,
  UnsupportedFeatureError,
  OutcomeUnknownError,
  raceAbort,
  resolveNetworkPolicy,
  validateResourceInput,
  type NetworkPolicy,
  type ReadOptions,
  type SandboxHandle,
  type SnapshotHandle,
  type ImageHandle,
  type PreparedImage,
  type VolumeHandle,
  type OperationHandle,
} from "./resource";
import {
  AdapterSandbox,
  type AdapterDirectClient,
  type AdapterRecoveryReference,
} from "./adapter-direct";

async function resourceRead<T>(
  client: AdapterDirectClient,
  work: (ctx: import("@sandbar-sdk/adapter").ReadContext) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  client.ensureOpen();
  const controller = new AbortController();
  const combined = AbortSignal.any([client.signal, controller.signal, ...(signal ? [signal] : [])]);

  const timer = setTimeout(
    () => controller.abort(new SandbarError("TIMEOUT", "Resource read deadline exceeded")),
    30000,
  );

  try {
    const value = await raceAbort(
      Promise.resolve().then(() => {
        if (combined.aborted) throw combined.reason;

        return work({ signal: combined, deadline: Date.now() + 30000 });
      }),
      combined,
    );

    client.ensureOpen();

    return value;
  } finally {
    clearTimeout(timer);
  }
}

/** SDK restore input; native RestoreRequest remains fully resolved. */
export type RestoreInput = Omit<RestoreRequest, "networkPolicy" | "lifetimeSeconds"> & {
  /** Outbound network policy; omitted uses the adapter setup default. */
  network?: NetworkPolicy;
  /**
   * Lifetime for the restored sandbox only, replacing the adapter setup's. Like `env` and
   * `labels`, it rejects before any effect where the adapter cannot apply it on restore.
   */
  lifecycle?: { lifetimeSeconds?: number };
  /** @deprecated Use `network`. */
  networkPolicy?: string;
};

export type WaitOptions = ReadOptions & { pollMs?: number };

export type SnapshotResult = Omit<SnapshotCaptureValue, "snapshot"> & { snapshot: SnapshotHandle };

export function checkedResource(
  client: AdapterDirectClient,
  ref: ResourceReference,
  kind: "snapshot" | "volume" | "image",
): ResourceReference {
  client.ensureOpen();
  const parsed = ResourceReference.safeParse(ref);

  if (!parsed.success) throw new SandbarError("INVALID_ARGUMENT", "Invalid resource reference");
  const checked = parsed.data;

  if (checked.kind !== kind) throw new SandbarError("INVALID_ARGUMENT", "Wrong resource kind");

  try {
    assertResourceScope(checked, { provider: client.provider, scope: client.scope });
  } catch (error) {
    if (error instanceof AdapterError) throw new SandbarError(error.code, error.message);
    throw error;
  }

  return structuredClone(checked);
}

/** Use the SnapshotHandle type for consumer annotations. This compatibility runtime class remains supported. */
export class AdapterSnapshot {
  readonly reference: ResourceReference;
  constructor(
    private readonly client: AdapterDirectClient,
    reference: ResourceReference,
  ) {
    this.reference = freezeReference(checkedResource(client, reference, "snapshot"));
  }
  get provider(): string {
    return this.reference.provider;
  }
  /** Native containing-resource ID; persist the full reference for immutable build selection. */
  get id(): string {
    return this.reference.nativeId;
  }
  async inspect(options: WaitOptions = {}): Promise<SnapshotInfo> {
    const ref = checkedResource(this.client, this.reference, "snapshot");

    if (!this.client.session.snapshotInspect)
      throw new SandbarError("UNSUPPORTED", "Snapshot inspection is unsupported");

    const info = SnapshotInfo.parse(
      await resourceRead(
        this.client,
        (ctx) => this.client.session.snapshotInspect!(ref, ctx),
        options.signal,
      ),
    );

    this.client.ensureOpen();
    assertResourceIdentity(info.reference, ref);

    return info;
  }
  /** Restore private captured state with explicitly selected current volume data. */
  async submitRestore(
    request: RestoreInput = {},
    options: WaitOptions = {},
  ): Promise<OperationHandle<SandboxHandle<true>, OperationKind>> {
    const ref = checkedResource(this.client, this.reference, "snapshot");
    // SDK-only deprecated empty-object alias for release R and R+1.
    const legacy = z.record(z.string(), z.unknown()).safeParse(request?.mounts);
    let normalized = request;

    if (legacy.success) {
      if (Object.keys(legacy.data).length)
        throw new SandbarError(
          "INVALID_ARGUMENT",
          "Restore mounts now use MountSpec[]; replace legacy share/replace/omit maps with volume.at(path) descriptors",
        );
      normalized = { ...request, mounts: undefined };
    }

    const selection = z
      .looseObject({ network: z.string().min(1).max(128).optional() })
      .safeParse(normalized);

    if (!selection.success) throw new SandbarError("INVALID_ARGUMENT", "Invalid restore request");
    const { network, lifecycle, ...rest } = selection.data;

    // Report only the bounds; environment keys and values never enter a message.
    if (rest.env !== undefined && !CreateEnv.safeParse(rest.env).success)
      throw new SandbarError(
        "INVALID_ARGUMENT",
        "Invalid restore env: use at most 128 names matching [A-Za-z_][A-Za-z0-9_]* with string values without NUL, 64 KiB in total",
      );

    const lifetime = z
      .strictObject({ lifetimeSeconds: z.number().int().positive().safe().optional() })
      .optional()
      .safeParse(lifecycle);

    if (!lifetime.success) throw new SandbarError("INVALID_ARGUMENT", "Invalid restore lifecycle");

    if (lifetime.data?.lifetimeSeconds !== undefined)
      rest.lifetimeSeconds = lifetime.data.lifetimeSeconds;

    const checked = validateResourceInput(
      RestoreRequest.partial({ networkPolicy: true }),
      rest,
      "Invalid restore request",
    );

    const input = validateResourceInput(
      RestoreRequest,
      {
        ...checked,
        networkPolicy: resolveNetworkPolicy(
          network,
          checked.networkPolicy,
          this.client.session.defaultNetworkPolicy ?? "blocked",
          this.client.session.networkPolicyAliases,
        ),
      },
      "Invalid restore request",
    );

    for (const mount of input.mounts ?? []) checkedResource(this.client, mount.volume, "volume");

    if (input.mounts?.length && this.client.session.snapshotRestore?.mountInput !== "specs")
      throw new UnsupportedFeatureError("snapshot restore", [
        "Upgrade this adapter: restore with mounts requires snapshotRestore.mountInput: specs",
      ]);

    if (!input.mounts?.length && this.client.session.snapshotRestore?.mountInput !== "specs")
      delete input.mounts;

    if (input.env && !Object.keys(input.env).length) delete input.env;

    if (input.labels && !Object.keys(input.labels).length) delete input.labels;
    const unsupported = restoreOptionProblem(this.client.session.snapshotRestore?.options, input);

    if (unsupported) throw new UnsupportedFeatureError("snapshot restore", [unsupported]);
    const info = await this.inspect(options);

    if (info.state !== "ready" || info.preserve === null)
      throw new SandbarError("UNAVAILABLE", "Snapshot provenance or readiness is unknown");

    const unmet: string[] = [];

    if (!info.restore.networkPolicies.includes(input.networkPolicy))
      unmet.push(
        `Network policy '${input.networkPolicy}' is unsupported by this connection for restore; supported policies: ${info.restore.networkPolicies.join(", ") || "none"}. Configure a separate connection with the requested policy if the adapter supports it.`,
      );

    if (Object.keys(input.resources ?? {}).length > 0 && !info.restore.resources)
      unmet.push("Resource sizing overrides are unsupported");

    if (input.requireIndependentLifecycle !== false && !info.restore.independentLifecycle)
      unmet.push("Independent lifecycle is required but unsupported");

    if (input.mounts?.length) {
      if (!info.restore.mounts) unmet.push("This adapter does not support restore with mounts");

      if (info.preserve !== "filesystem" || info.restoreExecution !== "fresh")
        unmet.push("Restore with mounts requires filesystem preservation and fresh execution");
    }

    if (info.mountHandling !== "none")
      unmet.push(
        `Snapshot mount restore is not implemented: capture mount provenance is '${info.mountHandling}', but must be 'none'`,
      );

    if (info.mounts.length)
      unmet.push("Snapshot mount restore is not implemented: snapshot contains recorded mounts");

    if (unmet.length) throw new UnsupportedFeatureError("snapshot restore", unmet);

    return this.client.submit(
      "snapshot_restore",
      { snapshot: ref, request: input },
      (result, recovery) => {
        if (
          result.kind !== "completed" ||
          !("id" in result.value) ||
          result.value.state !== "running"
        )
          throw new OutcomeUnknownError(recovery);

        if (
          input.mounts?.length &&
          JSON.stringify(result.value.mounts) !== JSON.stringify(input.mounts)
        )
          throw new OutcomeUnknownError(recovery);

        return new AdapterSandbox(this.client, result.value.id, result.value.reference ?? null);
      },
      { ...options, resource: ref, mounts: input.mounts, networkPolicy: input.networkPolicy },
    );
  }
  /** Restore requires no recorded native mounts and confirmed mountHandling: "none". */
  async restore(input: RestoreInput = {}, options: WaitOptions = {}): Promise<SandboxHandle<true>> {
    return (await this.submitRestore(input, options)).wait(options);
  }
  submitDelete(
    options: WaitOptions = {},
  ): Promise<OperationHandle<ArtifactDeletionResult, OperationKind>> {
    return deleteResource(this.client, this.reference, "snapshot", options);
  }
  async delete(options: WaitOptions = {}): Promise<ArtifactDeletionResult> {
    return (await this.submitDelete(options)).wait(options);
  }
}

/** Use the ImageHandle type for consumer annotations. */
export class AdapterImage {
  readonly reference: ResourceReference;
  constructor(
    private readonly client: AdapterDirectClient,
    reference: ResourceReference,
  ) {
    this.reference = freezeReference(checkedResource(client, reference, "image"));
  }
  get provider(): string {
    return this.reference.provider;
  }
  /** Native image ID; the value `Image.prepared()` selects. */
  get id(): string {
    return this.reference.nativeId;
  }
  /** The scoped prepared image for `Image.prepared()`. */
  get prepared(): PreparedImage {
    return {
      kind: "prepared",
      value: this.reference.nativeId,
      provider: this.reference.provider,
      scope: structuredClone(this.reference.scope),
    };
  }
  async inspect(options: WaitOptions = {}): Promise<ImageInfo> {
    const ref = checkedResource(this.client, this.reference, "image");

    if (!this.client.session.imageInspect)
      throw new UnsupportedFeatureError("image inspection", [
        "This adapter does not implement image inspection",
      ]);

    const info = ImageInfo.parse(
      await resourceRead(
        this.client,
        (ctx) => this.client.session.imageInspect!(ref, ctx),
        options.signal,
      ),
    );

    this.client.ensureOpen();
    assertResourceIdentity(info.reference, ref);

    return info;
  }
  /** Delete this image on the provider. Sandboxes and other artifacts are never deleted with it. */
  async submitDelete(
    options: WaitOptions = {},
  ): Promise<OperationHandle<ArtifactDeletionResult, OperationKind>> {
    if (!this.client.session.imageDelete)
      throw new UnsupportedFeatureError("image delete", [
        "This adapter does not implement image deletion",
      ]);

    return deleteResource(this.client, this.reference, "image", options);
  }
  async delete(options: WaitOptions = {}): Promise<ArtifactDeletionResult> {
    return (await this.submitDelete(options)).wait(options);
  }
}

/** Use the VolumeHandle type for consumer annotations. This compatibility runtime class remains supported. */
export class AdapterVolume {
  readonly reference: ResourceReference;
  constructor(
    private readonly client: AdapterDirectClient,
    reference: ResourceReference,
  ) {
    this.reference = freezeReference(checkedResource(client, reference, "volume"));
  }
  get provider(): string {
    return this.reference.provider;
  }
  get id(): string {
    return this.reference.nativeId;
  }
  async inspect(options: WaitOptions = {}): Promise<VolumeInfo> {
    const ref = checkedResource(this.client, this.reference, "volume");

    if (!this.client.session.volumeInspect)
      throw new SandbarError("UNSUPPORTED", "Volume inspection is unsupported");

    const info = VolumeInfo.parse(
      await resourceRead(
        this.client,
        (ctx) => this.client.session.volumeInspect!(ref, ctx),
        options.signal,
      ),
    );

    this.client.ensureOpen();
    assertResourceIdentity(info.reference, ref);

    return info;
  }
  at(
    path: string,
    options: { access?: "read-write" | "read-only"; subpath?: string } = {},
  ): MountSpec {
    return validateResourceInput(
      MountSpec,
      { volume: structuredClone(this.reference), path, ...options },
      "Invalid volume mount",
    );
  }
  submitDelete(
    options: WaitOptions = {},
  ): Promise<OperationHandle<ArtifactDeletionResult, OperationKind>> {
    return deleteResource(this.client, this.reference, "volume", options);
  }
  async delete(options: WaitOptions = {}): Promise<ArtifactDeletionResult> {
    return (await this.submitDelete(options)).wait(options);
  }
}

const deleteKinds = {
  snapshot: "snapshot_delete",
  volume: "volume_delete",
  image: "image_delete",
} as const;

function deleteResource(
  client: AdapterDirectClient,
  reference: ResourceReference,
  kind: "snapshot" | "volume" | "image",
  options: WaitOptions,
): Promise<OperationHandle<ArtifactDeletionResult, OperationKind>> {
  const ref = checkedResource(client, reference, kind);

  return client.submit(
    deleteKinds[kind],
    ref,
    (result, recovery) => {
      if (result.kind !== "completed" || !("deleted" in result.value))
        throw new OutcomeUnknownError(recovery);
      assertResourceIdentity(result.value.reference, ref);

      return result.value;
    },
    { ...options, resource: ref },
  );
}

export function resourceManagers(client: AdapterDirectClient) {
  const snapshots = {
    async get(ref: ResourceReference): Promise<SnapshotHandle> {
      const reference = checkedResource(client, ref, "snapshot");

      if (!client.session.snapshotInspect)
        throw new SandbarError("UNSUPPORTED", "Snapshot inspection is unsupported");

      const info = SnapshotInfo.parse(
        await resourceRead(client, (ctx) => client.session.snapshotInspect!(reference, ctx)),
      );

      checkedResource(client, info.reference, "snapshot");

      if (
        info.reference.nativeId !== reference.nativeId ||
        (reference.generation !== undefined && info.reference.generation !== reference.generation)
      )
        throw new SandbarError("CONFLICT", "Snapshot identity or generation differs");

      return new AdapterSnapshot(client, info.reference);
    },
    async list(input: SandboxListInput = {}) {
      client.ensureOpen();

      const request = validateResourceInput(PageInput, input, "Invalid snapshot inventory request");

      if (!client.session.snapshotList)
        throw new SandbarError("UNSUPPORTED", "Snapshot inventory is unsupported");

      const page = await resourceRead(client, (ctx) => client.session.snapshotList!(request, ctx));

      client.ensureOpen();

      const checked = z
        .strictObject({
          items: z.array(SnapshotInfo).max(request.limit),
          nextCursor: z.string().max(4096).optional(),
          coverage: z.enum(["provider-scope", "sandbar-managed"]),
        })
        .parse(page);

      checked.items.forEach((info) => checkedResource(client, info.reference, "snapshot"));

      return checked;
    },
    delete(ref: ResourceReference, options: WaitOptions = {}) {
      return new AdapterSnapshot(client, ref).delete(options);
    },
  };

  const volumes = {
    async get(ref: ResourceReference): Promise<VolumeHandle> {
      const handle = new AdapterVolume(client, ref);
      await handle.inspect();

      return handle;
    },
    async submitCreate(
      input: VolumeCreateInput,
      options: WaitOptions = {},
    ): Promise<OperationHandle<VolumeHandle, OperationKind>> {
      return client.submit(
        "volume_create",
        validateResourceInput(VolumeCreateInput, input, "Invalid volume create request"),
        (result, recovery) => {
          if (result.kind !== "completed" || !("filesystem" in result.value))
            throw new OutcomeUnknownError(recovery);

          return new AdapterVolume(client, result.value.reference);
        },
        options,
      );
    },
    async create(input: VolumeCreateInput, options: WaitOptions = {}): Promise<VolumeHandle> {
      return (await volumes.submitCreate(input, options)).wait(options);
    },
    async list(input: SandboxListInput = {}) {
      client.ensureOpen();

      const request = validateResourceInput(PageInput, input, "Invalid volume inventory request");

      if (!client.session.volumeList)
        throw new SandbarError("UNSUPPORTED", "Volume inventory is unsupported");

      const page = await resourceRead(client, (ctx) => client.session.volumeList!(request, ctx));

      client.ensureOpen();

      const checked = z
        .strictObject({
          items: z.array(VolumeInfo).max(request.limit),
          nextCursor: z.string().max(4096).optional(),
          coverage: z.enum(["provider-scope", "sandbar-managed"]),
        })
        .parse(page);

      checked.items.forEach((info) => checkedResource(client, info.reference, "volume"));

      return checked;
    },
    delete(ref: ResourceReference, options: WaitOptions = {}) {
      return new AdapterVolume(client, ref).delete(options);
    },
  };

  const images = {
    /** Inspect a saved image reference and return a handle bound to this connection. */
    async get(ref: ResourceReference): Promise<ImageHandle> {
      const handle = new AdapterImage(client, ref);
      const info = await handle.inspect();

      return new AdapterImage(client, info.reference);
    },
    async list(input: SandboxListInput = {}) {
      client.ensureOpen();

      const request = validateResourceInput(PageInput, input, "Invalid image inventory request");

      if (!client.session.imageList)
        throw new UnsupportedFeatureError("image inventory", [
          "This adapter does not implement image inventory",
        ]);

      const page = await resourceRead(client, (ctx) => client.session.imageList!(request, ctx));

      client.ensureOpen();

      const checked = z
        .strictObject({
          items: z.array(ImageInfo).max(request.limit),
          nextCursor: z.string().max(4096).optional(),
          coverage: z.enum(["provider-scope", "sandbar-managed"]),
        })
        .parse(page);

      checked.items.forEach((info) => checkedResource(client, info.reference, "image"));

      return checked;
    },
    async submitDelete(ref: ResourceReference, options: WaitOptions = {}) {
      return new AdapterImage(client, ref).submitDelete(options);
    },
    async delete(ref: ResourceReference, options: WaitOptions = {}) {
      return new AdapterImage(client, ref).delete(options);
    },
  };

  return { snapshots, volumes, images };
}

/** Page size used by `list()` calls when `limit` is omitted. */
export const DEFAULT_SANDBOX_LIST_LIMIT = 50;

/** Inventory page selection with the default page size applied. */
const PageInput = InventoryInput.extend({
  limit: InventoryInput.shape.limit.default(DEFAULT_SANDBOX_LIST_LIMIT),
});

/** Optional page selection for `list()` calls; `limit` is 1-100 and defaults to 50. */
export type SandboxListInput = { cursor?: string; limit?: number };

/**
 * One listed sandbox; `reference` is null when the adapter cannot verify a reopenable identity.
 * `labels` holds the labels set at create (null when the provider records none) and `createdAt`
 * the provider's creation time (null when it reports none).
 */
export type SandboxListEntry = {
  id: string;
  state: import("@sandbar-sdk/adapter").SandboxState;
  reference: import("@sandbar-sdk/adapter").SandboxReference | null;
  labels: Record<string, string> | null;
  createdAt: string | null;
};

/** A bounded page of sandboxes and whether it covers the provider scope or only Sandbar-created ones. */
export type SandboxList = {
  items: SandboxListEntry[];
  nextCursor?: string;
  coverage: "provider-scope" | "sandbar-managed";
};

const SandboxListPage = z.strictObject({
  items: z.array(SandboxListItem).max(100),
  nextCursor: z.string().max(4096).optional(),
  coverage: z.enum(["provider-scope", "sandbar-managed"]),
});

export async function listSandboxes(
  client: AdapterDirectClient,
  input: SandboxListInput = {},
): Promise<SandboxList> {
  client.ensureOpen();

  const request = validateResourceInput(
    InventoryInput,
    { cursor: input.cursor, limit: input.limit ?? DEFAULT_SANDBOX_LIST_LIMIT },
    "Invalid sandbox list request",
  );

  const list = client.session.sandboxList?.bind(client.session);

  if (!list) throw new SandbarError("UNSUPPORTED", "Sandbox listing is unsupported");

  let page: Awaited<ReturnType<typeof list>>;

  try {
    page = await resourceRead(client, (ctx) => list(request, ctx));
  } catch (error) {
    if (error instanceof AdapterError) throw new SandbarError(error.code, error.message);
    throw error;
  }

  client.ensureOpen();
  const parsed = SandboxListPage.safeParse(page);

  if (!parsed.success || parsed.data.items.length > request.limit)
    throw new SandbarError("INVALID_RESPONSE", "Provider returned an invalid sandbox list");

  for (const item of parsed.data.items) {
    if (!item.reference) continue;

    if (item.reference.nativeId !== item.id || item.reference.history !== undefined)
      throw new SandbarError(
        "INVALID_RESPONSE",
        "Provider listed an inconsistent sandbox reference",
      );

    try {
      assertResourceScope(item.reference, { provider: client.provider, scope: client.scope });
    } catch (error) {
      if (error instanceof AdapterError)
        throw new SandbarError("INVALID_RESPONSE", "Provider listed a sandbox outside this scope");
      throw error;
    }
  }

  return {
    ...structuredClone(parsed.data),
    items: parsed.data.items.map((item) => ({
      ...structuredClone(item),
      labels: item.labels ? { ...item.labels } : null,
      createdAt: item.createdAt ?? null,
    })),
  };
}

export function decodeCapture(
  client: AdapterDirectClient,
  value: SnapshotCaptureValue,
  ref: AdapterRecoveryReference,
): SnapshotResult {
  const expected = ref.capture;

  if (!expected || !ref.sandboxId) throw new OutcomeUnknownError(ref);
  checkedResource(client, value.snapshot.reference, "snapshot");

  if (
    value.capture.preserve !== expected.profile.preserve ||
    value.capture.interruption !== expected.profile.interruption ||
    value.capture.restoreExecution !== expected.profile.restoreExecution ||
    value.snapshot.restoreExecution !== expected.profile.restoreExecution ||
    value.snapshot.consistency !== expected.profile.consistency ||
    value.snapshot.preserve !== expected.profile.preserve ||
    value.snapshot.source?.id !== ref.sandboxId ||
    value.snapshot.mountHandling !== expected.profile.mountHandling ||
    value.source.state !==
      (expected.profile.sourceAfter === "unchanged"
        ? expected.sourceState
        : expected.profile.sourceAfter) ||
    value.source.connections !== expected.profile.connections
  )
    throw new OutcomeUnknownError(ref);

  for (const retained of value.retainedResources)
    assertResourceScope(retained, { provider: client.provider, scope: client.scope });

  return { ...value, snapshot: new AdapterSnapshot(client, value.snapshot.reference) };
}

export function decodeResourceResult(
  client: AdapterDirectClient,
  result: import("@sandbar-sdk/adapter").RuntimeResult,
  ref: AdapterRecoveryReference,
) {
  if (result.kind !== "completed") throw new OutcomeUnknownError(ref);
  const value = result.value;

  if (ref.kind === "snapshot_capture" && "snapshot" in value) {
    return decodeCapture(client, value, ref);
  }

  if (ref.kind === "snapshot_restore" && "id" in value && value.state === "running")
    return new AdapterSandbox(client, value.id, value.reference ?? null);

  if (ref.kind === "volume_create" && "filesystem" in value)
    return new AdapterVolume(client, value.reference);

  if (
    (ref.kind === "volume_delete" ||
      ref.kind === "snapshot_delete" ||
      ref.kind === "image_delete") &&
    "deleted" in value
  ) {
    if (!ref.resource) throw new OutcomeUnknownError(ref);
    assertResourceIdentity(value.reference, ref.resource);

    return value;
  }

  throw new OutcomeUnknownError(ref);
}
