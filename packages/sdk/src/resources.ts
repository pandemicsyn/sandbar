import { freezeReference } from "./freeze-reference";
import { z } from "zod";
import {
  ResourceReference,
  AdapterError,
  assertResourceScope,
  assertResourceIdentity,
  MountSpec,
  SnapshotInfo,
  VolumeInfo,
  RestoreRequest,
  VolumeCreateInput,
  InventoryInput,
  type ArtifactDeletionResult,
  type SnapshotCaptureValue,
} from "sandbar-adapter";
import {
  SandbarError,
  UnsupportedFeatureError,
  OutcomeUnknownError,
  raceAbort,
  validateResourceInput,
} from "./resource";
import {
  AdapterSandbox,
  type AdapterDirectClient,
  type AdapterOperation,
  type AdapterRecoveryReference,
} from "./adapter-direct";

async function resourceRead<T>(
  client: AdapterDirectClient,
  work: (ctx: import("sandbar-adapter").ReadContext) => Promise<T>,
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

export type WaitOptions = { signal?: AbortSignal; pollMs?: number };

export type SnapshotResult = Omit<SnapshotCaptureValue, "snapshot"> & { snapshot: AdapterSnapshot };

export function checkedResource(
  client: AdapterDirectClient,
  ref: ResourceReference,
  kind: "snapshot" | "volume",
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
  /** Mount choices remain accepted for compatibility, but nonempty choices and mounted/unknown-provenance snapshots are unsupported. */
  async submitRestore(
    request: RestoreRequest,
    options: WaitOptions = {},
  ): Promise<AdapterOperation<AdapterSandbox>> {
    const ref = checkedResource(this.client, this.reference, "snapshot");
    const input = validateResourceInput(RestoreRequest, request, "Invalid restore request");
    const info = await this.inspect(options);

    if (info.state !== "ready" || info.preserve === null)
      throw new SandbarError("UNAVAILABLE", "Snapshot provenance or readiness is unknown");

    const unmet: string[] = [];

    if (!info.restore.networkPolicies.includes(input.networkPolicy))
      unmet.push(`Network policy '${input.networkPolicy}' is unsupported`);

    if (Object.keys(input.resources ?? {}).length > 0 && !info.restore.resources)
      unmet.push("Resource sizing overrides are unsupported");

    if (input.requireIndependentLifecycle !== false && !info.restore.independentLifecycle)
      unmet.push("Independent lifecycle is required but unsupported");

    if (Object.keys(input.mounts ?? {}).length)
      unmet.push(
        "Snapshot mount restore is not implemented: share, replace and omit choices are unsupported",
      );

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

        return new AdapterSandbox(this.client, result.value.id);
      },
      { ...options, resource: ref },
    );
  }
  /** Restore requires no recorded mounts, confirmed mountHandling: "none", and absent or empty mount choices. */
  async restore(input: RestoreRequest, options: WaitOptions = {}): Promise<AdapterSandbox> {
    return (await this.submitRestore(input, options)).wait(options);
  }
  submitDelete(options: WaitOptions = {}): Promise<AdapterOperation<ArtifactDeletionResult>> {
    return deleteResource(this.client, this.reference, "snapshot", options);
  }
  async delete(options: WaitOptions = {}): Promise<ArtifactDeletionResult> {
    return (await this.submitDelete(options)).wait(options);
  }
}

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
  submitDelete(options: WaitOptions = {}): Promise<AdapterOperation<ArtifactDeletionResult>> {
    return deleteResource(this.client, this.reference, "volume", options);
  }
  async delete(options: WaitOptions = {}): Promise<ArtifactDeletionResult> {
    return (await this.submitDelete(options)).wait(options);
  }
}

function deleteResource(
  client: AdapterDirectClient,
  reference: ResourceReference,
  kind: "snapshot" | "volume",
  options: WaitOptions,
): Promise<AdapterOperation<ArtifactDeletionResult>> {
  const ref = checkedResource(client, reference, kind);

  return client.submit(
    kind === "snapshot" ? "snapshot_delete" : "volume_delete",
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
    async get(ref: ResourceReference) {
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
    async list(input: InventoryInput) {
      client.ensureOpen();

      const request = validateResourceInput(
        InventoryInput,
        input,
        "Invalid snapshot inventory request",
      );

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
    async get(ref: ResourceReference) {
      const handle = new AdapterVolume(client, ref);
      await handle.inspect();

      return handle;
    },
    async submitCreate(input: VolumeCreateInput, options: WaitOptions = {}) {
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
    async create(input: VolumeCreateInput, options: WaitOptions = {}) {
      return (await volumes.submitCreate(input, options)).wait(options);
    },
    async list(input: InventoryInput) {
      client.ensureOpen();

      const request = validateResourceInput(
        InventoryInput,
        input,
        "Invalid volume inventory request",
      );

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

  return { snapshots, volumes };
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
  result: import("sandbar-adapter").RuntimeResult,
  ref: AdapterRecoveryReference,
) {
  if (result.kind !== "completed") throw new OutcomeUnknownError(ref);
  const value = result.value;

  if (ref.kind === "snapshot_capture" && "snapshot" in value) {
    return decodeCapture(client, value, ref);
  }

  if (ref.kind === "snapshot_restore" && "id" in value && value.state === "running")
    return new AdapterSandbox(client, value.id);

  if (ref.kind === "volume_create" && "filesystem" in value)
    return new AdapterVolume(client, value.reference);

  if ((ref.kind === "volume_delete" || ref.kind === "snapshot_delete") && "deleted" in value) {
    if (!ref.resource) throw new OutcomeUnknownError(ref);
    assertResourceIdentity(value.reference, ref.resource);

    return value;
  }

  throw new OutcomeUnknownError(ref);
}
