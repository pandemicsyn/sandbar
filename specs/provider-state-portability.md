# Provider state portability

Next implementation work · Direction accepted September 28, 2026 · Not implemented

This specifies the next SDK and adapter extensions for snapshots, volumes, and lifecycle control. Daytona, E2B, Vercel Sandbox, and Tensorlake inform the portable contracts; implementing the future Vercel and Tensorlake adapters is separate work to specify later. Existing exports remain the authority for implemented behavior. These signatures are design sketches, not compilable examples of today's SDK.

## Recommendation

Offer a consistent vocabulary with explicit guarantees and optional provider capabilities. A provider need not support snapshots or volumes to be a valid adapter. Unsupported requests reject before mutation; there is no implicit file-copy snapshot, memory downgrade, provider switch, or mount omission.

Keep four concepts separate:

| Concept | Meaning | Proposed surface |
| --- | --- | --- |
| Prepared image | A provider-ready starting environment built or registered before execution | Existing `images.build`, `Image.prepared` |
| Sandbox snapshot | An immutable capture of private sandbox state, used to create a new sandbox | `box.snapshot`, `snapshot.restore` |
| Persistent volume | A mutable filesystem with a lifecycle independent of compute | `client.volumes`, create-time `mounts` |
| Suspension | Retain one logical sandbox for later explicit resumption | `box.suspend`, `box.resume` |

Use **snapshot** as the public noun for the sandbox checkpoint described in the earlier proposal. Do not expose synonymous `checkpoint()` and `snapshot()` methods for that operation. A **volume version** remains distinct from a sandbox snapshot.

An image and a snapshot can refer to the same native artifact, but must retain their separate provenance and guarantees. Do not infer runtime-snapshot support from an adapter's existing `prepared` image support.

## 1. Discover guarantees, not just feature flags

```ts
type Support<T> =
  | { status: "supported"; value: T }
  | { status: "unsupported"; reason: string }
  | { status: "unavailable"; reason: string } // access, configuration, or current state
  | { status: "unknown"; reason: string };    // could not establish support

type Preservation = "filesystem" | "filesystem+memory";
type Interruption = "none" | "pause" | "stop" | "terminate";
type SourceAfter = "unchanged" | "stopped" | "destroyed";

interface SnapshotProfile {
  id: string;
  preserve: Preservation;
  sourceStates: readonly SandboxState[];
  interruption: Interruption;
  sourceAfter: SourceAfter;
  connections: "preserved" | "dropped" | "unknown";
  consistency: "crash-consistent" | "caller-quiesced";
}

interface StateCapabilities {
  snapshots: {
    capture: Support<{ profiles: readonly SnapshotProfile[] }>;
    restore: Support<RestoreCapabilities>;
    inspect: Support<{}>;
    list: Support<{ coverage: "provider-scope" | "sandbar-managed" }>;
    delete: Support<{}>;
  };
  volumes: Support<VolumeCapabilities>;
  suspension: Support<{ profiles: readonly SuspensionProfile[] }>;
}
```

Profiles describe valid combinations. Separate arrays of preservation modes and disruption levels would incorrectly suggest every combination works. Profile IDs are opaque descriptions, not application branching keys.

Expose `await client.capabilities()` for the verified connection and `await box.capabilities()` for the actual sandbox class/state. Preserve the existing command/image/network facts when extending this surface; making the current direct capability getter asynchronous is an intentional API change to review. Both direct and service clients should provide the same consumer contract.

`supported` means the adapter implements the stated contract for the checked scope; upstream documentation alone does not qualify it. Publish fixture, packed-consumer, and live evidence separately. Connection capabilities are a dated observation, not a permanent entitlement or reservation. A beta feature without account access is unavailable, not automatically supported. An unimplemented adapter operation is unsupported even if the provider supports it natively. Capture, restore, inventory, and deletion are independently advertised; `RestoreCapabilities` describes enforceable policy, resource, mount, and lifecycle-independence constraints. A restore-only adapter need not support capture.

Provide request-specific, read-only checks such as `box.checkSnapshot(request)` and `client.sandboxes.checkCreate(input)`. Their supported result contains a resolved plan: preservation, disruption, source state after capture, mount handling, restore restrictions, and retention evidence. Unknown facts remain unknown; they cannot satisfy a hard requirement. Running the mutation revalidates that plan's constraints and scope. A check never allocates probe compute, reserves capacity, builds an image, or guarantees a future call will succeed.

## 2. Snapshot and restore

```ts
interface SnapshotRequest {
  preserve: Preservation; // required; exact, never a minimum
  maxInterruption?: Interruption; // default: "pause"
  sourceAfter?: SourceAfter; // default: "unchanged"
  consistency?: "crash-consistent" | "caller-quiesced"; // default: crash-consistent
  retention?: {
    minimumSeconds?: number;
    cleanupAfterSeconds?: number; // preference, not a durability guarantee
  };
}

interface SnapshotHandle {
  readonly reference: ResourceReference<"snapshot">;
  inspect(): Promise<SnapshotInfo>;
  restore(input: RestoreRequest, options?: WaitOptions): Promise<SandboxHandle>;
  submitRestore(input: RestoreRequest, options?: WaitOptions): Promise<OperationHandle<SandboxHandle>>;
  delete(options?: WaitOptions): Promise<ArtifactDeletionResult>;
}

interface SnapshotResult {
  snapshot: SnapshotHandle;
  source: { state: SandboxState; connections: "preserved" | "dropped" | "unknown" };
  retainedResources: RetainedArtifact[];
}

interface SandboxHandle {
  snapshot(input: SnapshotRequest, options?: WaitOptions): Promise<SnapshotResult>;
  submitSnapshot(input: SnapshotRequest, options?: WaitOptions): Promise<OperationHandle<SnapshotResult>>;
}

interface RestoreRequest {
  networkPolicy: string; // evaluated before any captured process runs
  resources?: { vcpu?: number; memoryMiB?: number; diskMiB?: number };
  mounts?: Record<string, RestoreMount>;
  requireIndependentLifecycle?: boolean;
}

type RestoreMount =
  | { action: "omit" }
  | { action: "share" }
  | { action: "replace"; mount: MountSpec }
  | { action: "fork-version"; version: ResourceReference<"volume-version"> };
```

`SandboxState` expands today's running/destroyed/unknown model to represent observed creating, running, stopped, suspended, restoring, destroying, and destroyed states without guessing when native evidence is incomplete. Wait options retain `AbortSignal` behavior.

Example: accept capture that stops the source, but preserve only files:

```ts
const { snapshot, source } = await box.snapshot({
  preserve: "filesystem",
  maxInterruption: "stop",
  sourceAfter: "stopped",
});

const restored = await snapshot.restore({ networkPolicy: "blocked" });
```

Behavior:

- Preservation is exact. A memory capture is not an acceptable substitute for filesystem-only: it retains additional state and potentially secrets. A cold restore cannot satisfy a memory requirement.
- Disruption is bounded independently of preservation. Stopping and restarting to pretend a capture was nondisruptive is prohibited. An already stopped source can remain stopped with `sourceAfter: "unchanged"`; otherwise a stopping capture needs explicit acceptance of its final state.
- `sourceAfter: "unchanged"` means lifecycle state, not unchanged files or uninterrupted sockets. Connection interruption is reported separately. The adapter must conservatively bound capture disruption; unknown disruption cannot pass a finite requirement.
- Default consistency is crash consistency only where established by the adapter. `caller-quiesced` requires the caller to stop application writes beforehand; Sandbar does not certify application-level consistency. A provider with insufficient evidence rejects the requested guarantee.
- Restore creates a new logical sandbox with independent private captured state. Resume is a different operation. Neither promises cross-provider portability. Account, region, class, image, resource, and native dependency restrictions travel with the snapshot.
- `SnapshotInfo` includes exact preservation, source identity/class, excluded paths and mounts, allowed restore overrides, parent/deletion dependencies, creation time, and known expiration behavior. Unknown values are explicit. Expiry can be absolute or idle-based; inspect reports the latest evidence rather than a fictitious permanent timestamp.
- Minimum retention is a requirement within the documented provider contract, absent explicit deletion. Unknown expiry cannot satisfy it. Cleanup preference must not precede the minimum. Direct mode has no scheduler: requested cleanup is reported as manual unless native expiry enforces it; service scheduling is separately reported.
- Snapshotting does not capture external volumes by default. Record every exclusion. Restore requires an explicit choice for every captured mount; omission of the map is valid only when there were no mounts. Even read-only live mounts can change externally.
- Memory restore with mounts is unsupported until the adapter verifies handling of saved mount credentials, caches, sessions, dirty buffers, and writers. Required network restrictions and attachment changes must take effect before resumed code can run. Reject incompatible overrides before restore submission.
- No atomic root-plus-volume capture is promised. Version a volume separately when supported; application coordination is needed for a consistent multi-resource checkpoint.

Add `client.snapshots.get(reference)`, bounded/paginated `list`, and `delete` for supported inventory/cleanup operations. `get` inspects a scoped resource; it does not import ownership or change scope. List results state whether they cover the provider scope or only Sandbar-managed artifacts. Recovering an operation remains separate from opening an existing resource.

Initially use snapshot followed by restore for a fork workflow. A later `box.fork(request)` can use a native clone path only when it honors the same explicit preservation, interruption, mount, independence, and recovery contracts. Native fork availability is independent of reusable-snapshot availability; a provider might support one without the other. Avoid a generic multi-step fallback engine in the first release.

## 3. Persistent volumes and mount sessions

```ts
interface VolumeHandle {
  readonly reference: ResourceReference<"volume">;
  inspect(): Promise<VolumeInfo>;
  at(path: string, options?: MountOptions): MountSpec; // pure descriptor, no IO
  delete(options?: WaitOptions): Promise<ArtifactDeletionResult>;
}

interface MountOptions {
  access?: "read-write" | "read-only"; // default: read-only with version, otherwise read-write
  subpath?: string;
  version?: ResourceReference<"volume-version">;
}

interface MountHandle {
  inspect(): Promise<MountInfo>;
  flush(options?: WaitOptions): Promise<DurabilityReceipt>;
  refresh(options?: WaitOptions): Promise<VisibilityReceipt>;
  checkpoint(options?: WaitOptions): Promise<VolumeVersionHandle>;
}

const volume = await client.volumes.create({ name: "agent-work" });
const box = await client.sandboxes.create({
  environment: Image.prepared("base"),
  mounts: [volume.at("/work")],
});
```

`client.volumes` offers create/get/list/delete as independently advertised operations. Opening an existing volume does not create a replacement when missing. Existing IDs are scoped references, not authority to attach arbitrary storage. A provider can support mounting a borrowed volume without implementing volume creation or versioning.

`VolumeCapabilities` describes the supported operation set and valid mount profiles, including attach timing, access modes, subpaths, concurrent attachment/writer constraints, live versus pinned views, and storage/compute compatibility. `VolumeInfo` records the actual filesystem behavior, including documented visibility, durability, locking, rename, and conflict semantics, with unknowns explicit. Do not label object-backed storage universally POSIX.

For the first release, support native mounts during sandbox creation. An attachment must be ready before the SDK returns the sandbox as ready. No silent omission, arbitrary FUSE installation, or automatic cross-provider bridging. Validate every requested mount before submitting create; a failure after allocation reports any retained compute and attachments for explicit cleanup. Later dynamic attach/detach is a separate capability.

Read-only access must be enforced, not treated as a hint. Pinning a version implies an immutable read-only view in the initial contract. Reject unsupported subpaths, access modes, version pinning, and storage/compute pairings. Mounts use independent storage resource scope checks, rather than assuming the sandbox's native ID namespace owns the volume.

Mount operations are independently optional:

- `flush()` establishes a verified durability barrier for that mount/session's covered writes. The receipt identifies the session, coverage boundary, completion time, and native version/commit if one exists. It does not imply a retained version or flush other writers.
- `refresh()` establishes the documented visibility boundary for that session; it is not automatically needed or supported on every filesystem.
- `checkpoint()` retains an immutable version of the defined session scope only if the adapter can link durable writes to that exact version. It must not return whichever head version happens to be latest after another writer advances it.
- A volume version can be inspected, mounted read-only, explicitly forked into a new volume when supported, or deleted under the same scope/dependency rules. Versioning and branching are not requirements for basic persistent storage.

Automatic replication is not evidence for an immediate flush receipt. Leave unsupported barriers/version operations unavailable rather than sleeping and claiming durability. Tensorlake's pinned snapshots motivate this optional interface, but exact barrier APIs still need native-boundary verification before implementation.

Sandbox destruction never deletes volumes. Extend the destroy result to include confirmed compute termination, retained resources, and per-mount durability outcomes. With writable mounts, the proposed default is `storage: "require-durable"`; use provider durability evidence or a supported barrier, and reject before compute deletion if it cannot be established. A barrier must cover the departing session through shutdown, using a verified drain/freeze/close protocol; flushing while writers continue is insufficient. A failed cleanup after a submitted flush can have storage effects and must not be called effect-free. Explicit `storage: "allow-unconfirmed"` still permits compute cleanup and reports the risk to unsaved data. Volume-free destroy retains today's behavior. This default is a deliberate API decision to review.

## 4. Suspension, resumption, and expiry

```ts
await box.suspend({ preserve: "filesystem+memory" });
const resumed = await box.resume();
// resumed includes the same logical sandbox reference and the current execution generation

await box.setTimeout({ remainingSeconds: 900 });
```

Suspension requires explicit exact preservation and verified native support. A `SuspensionProfile` binds that preservation to supported source states, connection interruption, expiry, and restore restrictions. A provider's own persistent logical sandbox may cold-boot new execution sessions; filesystem suspension can express that honestly. Memory suspension must preserve processes, not merely reuse a name.

`resume` keeps logical identity and reports execution generation/session changes. It must fail if saved state expired; never silently create a fresh empty sandbox. Sandbar must not synthesize checkpoint/delete/recreate and call it native suspension. `destroy` permanently ends the logical compute resource; native `stop` alone is insufficient when that object can auto-resume.

No automatic resume during inspect, list, recovery, exec, or file operations in this first contract. A stopped sandbox needs an explicit resume. Adapters must avoid native SDK helpers that auto-resume or replay commands; inability to do so makes the operation unsupported. Vercel's current SDK behavior makes this a particular implementation consideration.

`setTimeout` means expire this running session the requested number of seconds from provider acceptance; it does not configure snapshot retention. Separate eventual create-time options can express maximum lifetime, idle timeout, and timeout action (`destroy` or exact-preservation `suspend`). Unsupported lifecycle policies must fail rather than inherit a different provider default. Do not silently enable automatic paid snapshot creation.

## 5. When a provider has no snapshots

The adapter omits snapshot operations and reports `snapshots.capture.status: "unsupported"` (and the same for each absent snapshot operation). SDK resource methods remain consistently named; calling `box.snapshot` throws a typed `UnsupportedFeatureError` with `code: "UNSUPPORTED"`, `effect: "none"`, the feature, and unmet requirements. It must happen before even stopping the sandbox.

Applications have three explicit choices:

1. Require snapshots and reject this provider before creating compute. Proposed `sandboxes.create({ ..., requirements: { snapshot: request } })` checks the selected image/class and requested future snapshot contract before effects. If those facts require an image build first, return unknown/unavailable; do not run a paid probe build under a read-only check. Callers can explicitly build first and evaluate the prepared result.
2. Make snapshots optional and branch on `checkSnapshot`. Continue without a checkpoint only if the application accepts losing that recovery feature. An unknown/unavailable result is distinct from unsupported and can justify retrying a read-only check.
3. Choose another explicitly configured provider before allocation. A direct client remains bound to its selected provider. Future service placement can filter eligible connections; it cannot migrate an existing sandbox or restore a foreign snapshot without a separately specified transfer mechanism.

A volume can preserve selected working files when snapshots are absent, but not installed root packages or RAM. A rebuild recipe can recreate an environment, but not arbitrary runtime state. A future explicit archive/export API could copy selected files, with its own fidelity and consistency contract. None returns a fake `SnapshotHandle`.

Do not catch every snapshot exception and fall back. `UNSUPPORTED` before submission is effect-free; a failure after stop/capture dispatch can be partial or unknown. It may have stopped compute and retained a billed artifact. Return the existing recovery/effect error model with the known source and artifact facts, and never switch providers or submit another capture automatically.

## 6. Adapter/runtime implementation boundaries

Extend the public adapter contract with optional typed operations for snapshot capture/restore/delete, volume create/delete, mount barriers/versioning, and suspend/resume/timeout changes. Keep separate read methods for capabilities, inspect, and inventory. Derive SDK availability from both the declared profiles and actual operation implementations; absent methods cannot be advertised as supported. Keep provider-specific schemas and transports outside portable packages.

Use the existing `Mutation<Input, Result, Prepared, Token, Resource>` pattern: read-only prepare; one controlled submission with stable identity; read-only observation. Generalize the current sandbox-only resource parameter into a scoped resource reference for artifacts and mounts. Extend the current operation-kind union and direct/service result plumbing rather than inventing another runner.

Every new mutation gets an explicit submission form backed by `OperationHandle`, including artifact deletion and lifecycle operations; sketches omit repetitive signatures. A multi-stage adapter action such as stop-then-capture records stages without treating later failure as effect-free. Recovery never advances an unfinished mutation stage; it only observes. An explicit subsequent user operation can continue from confirmed state. Direct mode remains process-durable and service mode uses persisted markers/tokens; neither gets hidden database dependencies.

`ResourceReference<K>` is versioned, serializable, and includes resource kind, provider, verified scope, native locator, and generation where native names are reusable. Service references also identify their service/project binding. References hold no credentials and confer no authorization. Borrowed artifacts, verified-created artifacts, and artifacts with uncertain ownership remain distinct. Creation provenance must be established from correlated evidence, not a name prefix.

Deletion restricts rather than cascades. Track known artifact roles/dependencies so a snapshot exposed as an image is not deleted twice. Direct mode can enforce known dependencies and native restrictions, not invent a complete global ownership graph; the service adds managed dependency persistence. Report unverified external dependencies. Unknown operations retain accounting evidence and must not trigger garbage collection. Confirmed native deletion is not proof that billing already ended.

## 7. Mapping to the four target providers

These are documentation-derived design inputs checked September 28, 2026, not Sandbar implementation or live-conformance claims. Exact version, tier, sandbox class, and native transport behavior must be verified when implementing each adapter.

| Provider | Capture semantics relevant to this proposal | Persistent storage | Consequence |
| --- | --- | --- | --- |
| Daytona | Containers: filesystem capture from stopped source. Linux VMs: cold filesystem or running filesystem+memory capture; experimental SDK method | Native FUSE/object-backed volumes and subpaths | Class-specific capture profiles; a running container cannot satisfy pause-only filesystem capture |
| E2B | Reusable captures include filesystem+memory and briefly interrupt connections. Filesystem-only pause is a separate lifecycle operation | Native volumes are private beta | Do not advertise reusable filesystem-only capture based on disk-only pause; gate volumes by access |
| Vercel | Filesystem snapshots stop the source; persistent logical sandboxes can restart from stored files | No general native volume API established in the documentation reviewed | Require acceptance of stopping; do not claim memory restore; initially leave native volumes unsupported pending evidence |
| Tensorlake | Filesystem and memory snapshots; memory restore fixes image, CPU/memory, and entrypoint | Native versioned filesystems; pinned versions are read-only | Distinct capture/restore profiles and optional volume-version support |

Sources: [Daytona snapshots](https://www.daytona.io/docs/en/snapshots/), [Daytona volumes](https://www.daytona.io/docs/en/volumes/), [E2B snapshots](https://docs.e2b.dev/sandbox/snapshots), [E2B filesystem-only suspension](https://docs.e2b.dev/sandbox/filesystem-only-snapshots), [E2B volumes](https://docs.e2b.dev/volumes), [Vercel snapshots](https://vercel.com/docs/sandbox/concepts/snapshots), [Vercel persistence and auto-resume](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes), [Tensorlake snapshots](https://docs.tensorlake.ai/sandboxes/snapshots), [Tensorlake mounts](https://docs.tensorlake.ai/sandboxes/mount-filesystems).

## 8. Implementation sequence and acceptance

1. Add resource references, request-specific capability evaluation, errors, and operation plumbing. Test a minimal adapter with no snapshot/volume concepts; keep today's core operations usable.
2. Deliver snapshot capture/inspect/restore/delete end to end with source disruption, retained-resource reporting, and direct/service parity. Use deterministic contrasting profiles: stopping filesystem capture, non-stopping memory capture, and no capture support.
3. Add native create-time mounts and volume lifecycle. Keep volume versions and dynamic attachments optional. Exercise storage scope, unavailable beta access, failed mount readiness, durability-before-destroy, and explicit unconfirmed cleanup.
4. Add exact-preservation suspend/resume and timeout control, with execution-generation handling and native auto-resume disabled. Then add one verified volume-version adapter and native forks as justified.
5. Address resource sizing, richer images, streaming processes, broader files, and network policies as separate focused contracts. Their capabilities should follow the same exact-requirement rules; this proposal does not bundle the entire inventory into one implementation.

Required tests include unsupported-before-mutation; profile combinations that must reject; filesystem-only on a memory-only adapter; stopped source despite failed capture; lost capture/restore/delete responses; expired or foreign references; no implicit fresh sandbox on resume; incompatible policy before memory restore; unpinned external mounts; readonly enforcement; concurrent writers and version identity; unknown ownership; no-replay recovery; and direct/service parity. Qualification must also inspect native retry/auto-resume behavior, not just callback counts. Paid live qualification requires separate authorization.

Decisions proposed for review: public name `snapshot`; required exact `preserve`; default pause-only capture with unchanged source lifecycle; explicit restore networking; no automatic degradation; native create-time mounts first; and durability-required destruction for writable mounts. No production exports or provider behavior change with this document.
