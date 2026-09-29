# Provider state portability

Direction accepted September 28, 2026; recovery and E2B requirements revised September 29, 2026 · Snapshot and core volume mutations implemented in the direct SDK; lifecycle and version slices remain proposed

This records the accepted SDK and adapter direction for snapshots, volumes, and lifecycle control. Daytona, E2B, Vercel Sandbox, and Tensorlake inform the portable contracts; implementing the future Vercel and Tensorlake adapters is separate work to specify later. Existing exports remain the authority for implemented behavior. The signatures below remain design sketches, not a current API inventory; use SDK and adapter exports for implemented behavior.

## Delivery scope

Remaining feature slices target the direct SDK and public adapter API. Service parity, new HTTP routes, service-managed artifact persistence, and durable service orchestration are deferred to the [distant service milestone](../plans/implementation-plan.md#distant-milestone-optional-service). Keep existing service behavior and regression coverage intact, with narrow shared-contract compatibility fixes only. SDK references, provider scope checks, mutation identity, and reconciliation without blind mutation replay remain mandatory. Applications own persistence of references; this is required for SDK crash/serverless recovery and is not the deferred service persistence milestone. Previously merged service foundations are historical implementation facts, not acceptance requirements for new SDK features.

## Recommendation

Make `box.snapshot()` the normal capture path. Each adapter selects sensible native defaults and performs the lifecycle steps needed to capture state. Configuration exposes real choices, not permission switches for unavoidable provider mechanics. A provider need not support snapshots or volumes to be a valid adapter. Unsupported requests reject before mutation; there is no implicit file-copy snapshot, provider switch, or mount omission.

The portable contract is the call and resource lifecycle, not identical captured state across providers. A default capture may contain files only on one provider and files plus memory on another. Document that behavior before use and return the actual guarantees with the result. Applications that need stricter guarantees can opt into requirement checks; these remain exact and cannot silently degrade. This supersedes the earlier mandatory `preserve`, pause-only default, and explicit stop-permission design.

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
  consistency: "crash-consistent" | "caller-quiesced" | "unknown";
  restoreExecution: "fresh" | "resume";
}

interface StateCapabilities {
  snapshots: {
    capture: Support<{
      profiles: readonly SnapshotProfile[];
      defaultProfileId: string;
    }>;
    restore: Support<RestoreCapabilities>;
    inspect: Support<{}>;
    list: Support<{ coverage: "provider-scope" | "sandbar-managed" }>;
    delete: Support<{}>;
  };
  volumes: Support<VolumeCapabilities>;
  suspension: Support<{ profiles: readonly SuspensionProfile[] }>;
}
```

Profiles describe valid combinations and include adapter orchestration, not only the raw native capture endpoint. For example, Daytona's default running-container profile includes stop, capture, and restart. `defaultProfileId` selects the profile for the configured adapter and target class/state; unknown target facts produce unknown/unavailable rather than a guessed default. Separate arrays of preservation modes and disruption levels would incorrectly suggest every combination works. Profile IDs are opaque descriptions, not application branching keys.

Expose `await client.capabilities()` for the verified connection and `await box.capabilities()` for the actual sandbox class/state. Preserve the existing command/image/network facts when extending this surface; making the current direct capability getter asynchronous is an intentional API change to review. Implement the direct SDK contract; extending it to the service client is deferred.

`supported` means the adapter implements the stated contract for the checked scope; upstream documentation alone does not qualify it. Publish fixture, packed-consumer, and live evidence separately. Connection capabilities are a dated observation, not a permanent entitlement or reservation. A beta feature without account access is unavailable, not automatically supported. An unimplemented adapter operation is unsupported even if the provider supports it natively. Capture, restore, inventory, and deletion are independently advertised; `RestoreCapabilities` describes enforceable policy, resource, mount, and lifecycle-independence constraints. A restore-only adapter need not support capture.

Provide optional request-specific, read-only checks such as `box.checkSnapshot()` and `client.sandboxes.checkCreate(input)`. With no request, resolve the configured native default. Their supported result contains a resolved plan: preservation, disruption, source state after capture, restored process behavior, mount handling, restore restrictions, and retention evidence. Optional hard requirements validate that plan; they do not silently choose another capture mode. Unknown facts remain unknown and cannot satisfy a hard requirement. Running the mutation revalidates that plan's constraints and scope. A check never allocates probe compute, reserves capacity, builds an image, or guarantees a future call will succeed.

## 2. Snapshot and restore

```ts
interface SnapshotRequirements {
  preserve?: Preservation; // when supplied, exact; not a mode selector
  maxInterruption?: Interruption;
  sourceAfter?: SourceAfter;
  consistency?: "crash-consistent" | "caller-quiesced";
}

interface SnapshotRequest {
  requirements?: SnapshotRequirements; // omitted: accept configured native behavior
  consistency?: "caller-quiesced"; // caller attests writers were quiesced
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
  capture: {
    preserve: Preservation;
    interruption: Interruption;
    restoreExecution: "fresh" | "resume";
  };
  source: { state: SandboxState; connections: "preserved" | "dropped" | "unknown" };
  retainedResources: RetainedArtifact[];
}

interface SandboxHandle {
  snapshot(input?: SnapshotRequest, options?: WaitOptions): Promise<SnapshotResult>;
  submitSnapshot(input?: SnapshotRequest, options?: WaitOptions): Promise<OperationHandle<SnapshotResult>>;
  checkSnapshot(input?: SnapshotRequest): Promise<Support<SnapshotPlan>>;
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

The ordinary workflow is identical across adapters:

```ts
const { snapshot, source, capture } = await box.snapshot();
const restored = await snapshot.restore({ networkPolicy: "blocked" });
```

### Concrete adapter signatures and defaults

These are proposed SDK binding-factory signatures. Existing connection options are retained. Snapshot choices belong to the adapter's typed configuration, also available through `Sandbar.connect({ adapter, config, credentials })`; no provider-name switch belongs in the SDK runtime.

```ts
// sandbar-sdk/daytona — initial capture implementation: containers
export function daytona(options: {
  apiKey: string;
  target: string;
  ttlMinutes?: number;
  networkPolicy?: "blocked" | "daytona-default";
  snapshots?: {
    restartAfterCapture?: boolean; // default true; only restart a previously running source
  };
}): BoundAdapter;

// sandbar-sdk/e2b
export function e2b(options: {
  apiKey: string;
  teamId?: string;
  templateId?: string;
  timeoutSeconds?: number;
  // No snapshot options: native reusable capture has no memory/pause choice.
}): BoundAdapter;
```

```ts
const daytonaClient = await Sandbar.connect(daytona({
  apiKey: process.env.DAYTONA_API_KEY!,
  target: "us",
})); // snapshot(): stop if running, capture files, restart if previously running

const e2bClient = await Sandbar.connect(e2b({
  apiKey: process.env.E2B_API_KEY!,
})); // snapshot(): native files + memory capture, automatic brief pause/resume

const batchClient = await Sandbar.connect(daytona({
  apiKey: process.env.DAYTONA_API_KEY!,
  target: "us",
  snapshots: { restartAfterCapture: false },
})); // real alternative: leave the source stopped after capture
```

| Behavior | Daytona containers | E2B reusable snapshots |
| --- | --- | --- |
| Default capture | Whole private filesystem, excluding external mounts | Private filesystem plus memory/process state, excluding external mounts |
| Running source | Adapter stops it, captures, then starts it | Native capture briefly pauses and resumes it |
| Source already stopped | Capture and leave stopped | Native capture requires a running source; reject before effects |
| Source processes after capture | Previous processes ended; restart does not recover them | Continue; active connections are dropped |
| Restored sandbox | Fresh process execution | Captured process execution resumes |
| Actual configuration choice | `restartAfterCapture: false` leaves a previously running source stopped | None for memory inclusion or automatic pause |

Daytona's native container endpoint requires a stopped source; automatic stop/capture/start is Sandbar adapter orchestration. E2B performs its pause/resume natively. Do not add `allowSourceRestart`, `pauseOnly`, or mandatory `memory: "required"` settings to acknowledge fixed behavior. Daytona VM capture is a separate class-specific implementation: when implemented and qualified, it can expose an actual filesystem/memory selection with cold capture as its default. Do not advertise VM capture merely because the container adapter supports capture.

Applications that need identical guarantees across providers may optionally reject incompatible defaults:

```ts
await box.snapshot({ requirements: { preserve: "filesystem" } });
// Daytona container default can satisfy this; E2B reusable capture cannot.
// Rejection happens before stopping, pausing, or creating any artifact.
```

The default filesystem scope is the provider's whole private persistent filesystem, not a caller-selected directory. External mounts, pseudo-filesystems, and other native exclusions must be reported; do not promise every path under `/`. A future `workspace.snapshot()` or path-scoped export would be a distinct capability with its own fidelity and consistency contract. Portable workspace storage, automatic archives, and cross-provider transfer are outside this slice.

Behavior:

- No-argument capture accepts the configured native profile, including its memory behavior and lifecycle steps. Explicit preservation requirements remain exact: memory capture cannot substitute for required filesystem-only capture, and cold restore cannot satisfy required memory preservation.
- Disruption is reported independently of preservation. Stopping and restarting must never be described as nondisruptive. The default restores the source's prior lifecycle state where the adapter can implement it; Daytona containers restart only if running before capture. A provider unable to do this must document its different default and expose only alternatives it actually supports.
- `sourceAfter: "unchanged"` means lifecycle state, not unchanged files, processes, or sockets. Report process loss and connection interruption separately. Unknown disruption cannot satisfy an explicit finite bound.
- Default consistency is crash consistency only where established by the adapter. Do not require `caller-quiesced` merely to acknowledge native behavior. It asserts the caller stopped application writes beforehand; Sandbar does not certify application-level consistency. Profiles and artifact metadata must represent unknown consistency honestly where evidence is insufficient, and unknown cannot satisfy a requested guarantee.
- Restore creates a new logical sandbox with independent private captured state. Resume is a different operation. Neither promises cross-provider portability. Account, region, class, image, resource, and native dependency restrictions travel with the snapshot.
- `SnapshotInfo` includes exact preservation, fresh/resumed process behavior on restore, source identity/class, excluded paths and mounts, allowed restore overrides, parent/deletion dependencies, creation time, and known expiration behavior. These facts travel with the artifact; reopening it with different connection defaults must not reinterpret its captured state. Unknown values are explicit. Expiry can be absolute or idle-based; inspect reports the latest evidence rather than a fictitious permanent timestamp.
- Minimum retention is a requirement within the documented provider contract, absent explicit deletion. Unknown expiry cannot satisfy it. Cleanup preference must not precede the minimum. Direct mode has no scheduler: requested cleanup is reported as manual unless native expiry enforces it; service scheduling is deferred and must not be assumed.
- Snapshotting does not capture external volumes by default. Record every exclusion. Restore requires an explicit choice for every captured mount; omission of the map is valid only when there were no mounts. Even read-only live mounts can change externally.
- Memory restore with mounts is unsupported until the adapter verifies handling of saved mount credentials, caches, sessions, dirty buffers, and writers. Required network restrictions and attachment changes must take effect before resumed code can run. Reject incompatible overrides before restore submission.
- No atomic root-plus-volume capture is promised. Version a volume separately when supported; application coordination is needed for a consistent multi-resource checkpoint.

Add `client.snapshots.get(reference)`, bounded/paginated `list`, and `delete` for supported inventory/cleanup operations. `get` inspects a scoped resource; it does not import ownership or change scope. List results state whether they cover the provider scope or only Sandbar-managed artifacts. Recovering an operation remains separate from opening an existing resource.

Initially use snapshot followed by restore for a fork workflow. A later `box.fork(request)` can use a native clone path only when it honors the same explicit preservation, interruption, mount, independence, and recovery contracts. Native fork availability is independent of reusable-snapshot availability; a provider might support one without the other. Avoid a generic multi-step fallback engine in the first release.

### Source restoration and partial failure

Daytona's default adapter submission records the observed initial state and each stop/capture/start stage. After a confirmed stop of a previously running source, attempt to start it again after either successful capture or a definitive capture failure. `restartAfterCapture: false` leaves it stopped on either path. An already-stopped source is never started by this option.

Do not claim full success until the requested final lifecycle state is confirmed. If capture succeeded but restart failed, preserve and report the snapshot reference, capture completion, observed source state, and restart failure; do not discard the artifact or submit a second capture. Report capture and restart failures separately when both fail. Restarting does not recover former processes or application readiness.

If a stop, capture, or start response is uncertain, retain its stage and recovery evidence. Do not replay it or start the source while capture may still be in progress. Once a definitive safe outcome is established, the active submission or an explicitly requested continuation may submit a proven never-submitted next stage through the controlled mutation path described below. Observation itself stays read-only. If the process exits or a local deadline expires, persist pending/unknown state; a later invocation must be able to reconcile and finish a still-required restart without capturing again. In particular, a capture that becomes ready after the current 60-second implementation budget must not strand the source merely because submission waiting ended. Cancellation does not prove remote work stopped and does not authorize background work beyond bounded finalization; a caller can subsequently request continuation from saved state. Never repeat an uncertain mutation.

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

1. Require snapshots and reject this provider before creating compute. Proposed `sandboxes.create({ ..., requirements: { snapshot: {} } })` checks availability of the configured default for the selected image/class before effects. Supply `{ snapshot: { requirements: { preserve: "filesystem" } } }` for a stricter contract. If those facts require an image build first, return unknown/unavailable; do not run a paid probe build under a read-only check. Callers can explicitly build first and evaluate the prepared result.
2. Make snapshots optional and branch on `checkSnapshot`. Continue without a checkpoint only if the application accepts losing that recovery feature. An unknown/unavailable result is distinct from unsupported and can justify retrying a read-only check.
3. Choose another explicitly configured provider before allocation. A direct client remains bound to its selected provider. Future service placement can filter eligible connections; it cannot migrate an existing sandbox or restore a foreign snapshot without a separately specified transfer mechanism.

A volume can preserve selected working files when snapshots are absent, but not installed root packages or RAM. A rebuild recipe can recreate an environment, but not arbitrary runtime state. A future explicit archive/export API could copy selected files, with its own fidelity and consistency contract. None returns a fake `SnapshotHandle`.

Do not catch every snapshot exception and fall back. `UNSUPPORTED` before submission is effect-free; a failure after stop/capture dispatch can be partial or unknown. It may have stopped compute and retained a billed artifact. Return the existing recovery/effect error model with the known source and artifact facts, and never switch providers or submit another capture automatically.

## 6. Adapter/runtime implementation boundaries

Extend the public adapter contract with optional typed operations for snapshot capture/restore/delete, volume create/delete, mount barriers/versioning, and suspend/resume/timeout changes. Keep separate read methods for capabilities, inspect, and inventory. Derive SDK availability from both the declared profiles and actual operation implementations; absent methods cannot be advertised as supported. Keep provider-specific schemas and transports outside portable packages.

Extend the existing `Mutation<Input, Result, Prepared, Token, Resource>` pattern: read-only prepare; controlled submission with stable identity; read-only observation. Add a narrow, explicit continuation path for interrupted multi-stage operations, with the same validation and durable dispatch barriers as submission. Do not hide continuation writes in `observe`, `inspect`, or `get`. Generalize the current sandbox-only resource parameter into a scoped resource reference for artifacts and mounts. Extend the current operation-kind union and direct SDK result plumbing rather than inventing another runner. Preserve existing service cases without adding dispatch for new artifact operations.

Every new mutation gets an explicit submission form backed by `OperationHandle`, including artifact deletion and lifecycle operations; sketches omit repetitive signatures. A multi-stage adapter action such as stop-capture-start records stages without treating later failure as effect-free. The adapter owns its configured default and orchestration; the shared runtime must not branch on provider names. Opening a recovered operation reconciles saved state; an explicit continuation on that operation can finish a confirmed, never-submitted next stage. This supersedes the earlier blanket prohibition on recovery advancing stages. Preserve operation identity and accumulated outcomes rather than making callers construct a second capture or perform provider-specific lifecycle calls. Callers own reference persistence and execution of later invocations. Do not introduce a hidden database, scheduler, or service dependency. New service operation persistence is deferred.

`ResourceReference<K>` is versioned, serializable, and includes resource kind, provider, verified scope, native locator, and generation where native names are reusable. Service references also identify their service/project binding. References hold no credentials and confer no provider authorization. They must remain usable with different valid credentials for the same native scope. Borrowed artifacts, SDK-created artifacts, and artifacts with uncertain creation provenance remain distinguishable; a name prefix alone is not creation evidence. Native identity, application-retained historical observations, and current provider observations are separate facts, not a single signed ownership credential.

### Application-owned persistence and credential-independent references

The SDK must supply enough bounded, versioned JSON for an application to persist state in its own database, object store, workflow state, or another chosen store. Reopening in a fresh process or Lambda invocation with current credentials is a required workflow. There is no required Sandbar backing store, long-lived client, process-local registry, or provider-API-key signing secret.

Keep two reference roles separate:

- **Resource reference:** resource kind, provider, verified native scope, stable native locator, and immutable generation/build selector where applicable. Preserve the historical facts needed to use the captured artifact (including capture semantics and mount exclusions), with their provenance. Reopening must not require the original source sandbox to remain alive.
- **Operation reference:** operation/submission identity, original request and configured lifecycle intent, stage states, correlation identifiers, native operation IDs, known created resources, and partial outcomes sufficient to reconcile an interrupted operation. Persist only the bounded request facts needed for recovery; exclude credentials and sensitive application payloads.

Illustrative resource flow (design sketch; `save`/`load` belong to the application):

```ts
// Invocation A
const captured = await sandbox.snapshot();
await save("snapshot", captured.snapshot.reference);

// Invocation B: fresh SDK connection with current, possibly rotated credentials
const snapshot = await client.snapshots.get(await load("snapshot"));
const restored = await snapshot.restore({ networkPolicy: "blocked" });
```

Saving only the completed resource reference does not close the crash window around native mutation. Support the awaited `onReference` persistence hook before dispatch and whenever new stage or artifact evidence is learned. If pre-dispatch persistence fails, do not dispatch. If persistence fails after a provider effect, retain and surface the latest reference/known outcome; do not erase the effect or retry it. A restart may load the last successfully persisted reference and still need native correlation to discover what happened. Document unresolved windows honestly rather than promising exactly-once execution.

Do not sign resource/operation references with provider credentials or require an adapter HMAC receipt to restore/delete a resource. Schema/version validation, authenticated scope verification, native identity checks, and current provider authorization remain required. Treat references as application-owned persisted input: historical observations retain their provenance and must not be relabeled as freshly verified native guarantees. Where a required fact cannot be established from native evidence or the trusted application's retained observations, report it as unknown or reject the specific guarantee. Applications exposing references to untrusted callers must enforce their own tenant authorization and storage integrity; the SDK does not turn a reference into an authorization token.

An explicit user-requested artifact deletion must not require proof that this particular SDK connection originally created it. Verify the target identity/scope and deletion semantics, enforce native restrictions, and respect known dependencies. Automatic or incidental cleanup is different: only clean up resources correlated to that operation, never infer cleanup ownership from a name or inventory listing. Credential rotation must not invalidate retained creation history or force callers to retain revoked credentials. No custom signing infrastructure is required by this contract.

### Reconciliation and explicit continuation

`observe` remains read-only. A recovered operation must also offer an explicit continuation through an adapter/runtime mutation path; the implementation should fit this into the existing operation handles rather than introduce a general workflow engine. Document which public call requests continuation and which calls only read/wait. Continuation is limited to the saved operation's requested workflow, not a new capture or a change to its defaults.

Persist a dispatch barrier for each stage, distinguishing **never submitted**, **dispatch may have occurred**, **acknowledged/pending**, **completed**, and **definitively failed**. A crash after the barrier but before the response is uncertain even if the request may never have left the process. Reconcile that stage by native correlation; lack of evidence is not proof that it was never submitted. Use native idempotency only where the provider actually guarantees it.

| Saved/reconciled state | Permitted next action |
| --- | --- |
| Capture acknowledged but still running | Read/poll; do not restart yet |
| Capture completed (or definitively failed safely), source stopped, restart proven never submitted, saved intent requires restart | Explicit continuation persists the restart dispatch barrier, then submits start |
| Start dispatch may have occurred; acknowledgement lost | Read source/native operation state; do not blindly submit start again |
| Source reached expected state and capture outcome is known | Complete the workflow with retained artifact and separate capture/restart outcomes |
| Evidence cannot distinguish completion from an uncertain effect | Return actionable pending/unknown state, saved IDs/stages, and retained resources; no guessed success or replay |

Before continuation, revalidate scope, native identities, source state, and that the next step is still safe. Known terminal capture failure can permit source restoration; do not treat a native terminal error as an indefinitely in-progress capture. Resumed work observes caller deadlines/signals and uses bounded finalization just like initial submission. A timeout ends local waiting, not the possibility of later explicit continuation.

The application must serialize continuation for a given operation (for example with its store's lease or compare-and-swap). Without native idempotency or a shared application-owned dispatch barrier, two Lambda invocations cannot safely infer exclusive right to submit the same next stage. Document this execution requirement; do not claim process-local checks provide distributed exactly-once behavior.

Deletion restricts rather than cascades. Track known artifact roles/dependencies so a snapshot exposed as an image is not deleted twice. Direct mode can enforce known dependencies and native restrictions, not invent a complete global ownership graph; a future service could add managed dependency persistence, outside this SDK scope. Report unverified external dependencies. Unknown operations retain effect and retained-resource evidence and must not trigger garbage collection. Confirmed native deletion is not proof that billing already ended.

## 7. Mapping to the four target providers

These are documentation-derived design inputs checked September 28, 2026, not Sandbar implementation or live-conformance claims. Exact version, tier, sandbox class, and native transport behavior must be verified when implementing each adapter.

| Provider | Capture semantics relevant to this proposal | Persistent storage | Consequence |
| --- | --- | --- | --- |
| Daytona | Containers: filesystem capture from stopped source. Linux VMs: cold filesystem or running filesystem+memory capture; experimental SDK method | Native FUSE/object-backed volumes and subpaths | Default container adapter stops/captures/restarts a previously running source; optional leave-stopped behavior. VM capture needs separate implementation and qualification |
| E2B | Reusable captures include filesystem+memory and briefly interrupt connections. Filesystem-only pause is a separate lifecycle operation | Native volumes are private beta | Do not advertise reusable filesystem-only capture based on disk-only pause; gate volumes by access |
| Vercel | Filesystem snapshots stop the source; persistent logical sandboxes can restart from stored files | No general native volume API established in the documentation reviewed | Future adapter must document source lifecycle and implement the simplest supported workflow; do not claim memory restore or native volumes without evidence |
| Tensorlake | Filesystem and memory snapshots; memory restore fixes image, CPU/memory, and entrypoint | Native versioned filesystems; pinned versions are read-only | Distinct capture/restore profiles and optional volume-version support |

Sources: [Daytona snapshots](https://www.daytona.io/docs/en/snapshots/), [Daytona volumes](https://www.daytona.io/docs/en/volumes/), [E2B snapshots](https://docs.e2b.dev/sandbox/snapshots), [E2B filesystem-only suspension](https://docs.e2b.dev/sandbox/filesystem-only-snapshots), [E2B volumes](https://docs.e2b.dev/volumes), [Vercel snapshots](https://vercel.com/docs/sandbox/concepts/snapshots), [Vercel persistence and auto-resume](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes), [Tensorlake snapshots](https://docs.tensorlake.ai/sandboxes/snapshots), [Tensorlake mounts](https://docs.tensorlake.ai/sandboxes/mount-filesystems).

### E2B capture, exact restore, and resource cleanup

The current slice must deliver a usable E2B capture → inspect → restore → cleanup workflow. Independently advertised capabilities remain useful for genuinely partial adapters, but capture-only E2B support is not completion of this implementation unit. Its live roundtrip must not be replaced by an unsupported-capability short circuit.

- Use an unnamed native capture to allocate a dedicated snapshot template per Sandbar capture. Avoid intentionally reusing a named template across captures. The [E2B create-snapshot API](https://docs.e2b.dev/api-reference/sandboxes/create-snapshot) documents that a reused name appends a build to an existing template; an unnamed response uses the raw template ID with `:default`.
- Retain the native template ID and captured build UUID as separate facts. Establish the build from correlated native capture/template evidence; a later lookup of a moved tag must not invent the captured generation after an acknowledgement/evidence gap. Preserve unknown outcomes when that correlation cannot be established.
- Restore using the immutable selector `templateId:buildUUID`, not the mutable `:default` tag. The pinned E2B JavaScript SDK forwards this selector, and [upstream build selection](https://github.com/e2b-dev/infra/blob/48772bf11820dbd46474bf5dcdd419c7119b864f/packages/db/queries/templates/get_template_with_build_by_tag.sql) explicitly accepts a build UUID for snapshot templates. This is source evidence, not live qualification or a claim that the prose SDK docs guarantee every deployed API version. Validate against the supported native version before advertising it.
- Inspect the referenced captured build even when the default tag moves. A changed default tag alone must not invalidate an otherwise addressable captured build. Missing/deleted builds must fail; never restore the latest build as a substitute. Enforce requested network restrictions before resumed memory can execute.
- Model cleanup as deletion of the dedicated containing native snapshot template, not deletion of an individual build. E2B's documented `Sandbox.deleteSnapshot` uses template deletion. Retain that deletion target separately from the immutable restore selector; appending a build UUID to DELETE does not create a generation precondition.
- Verify native addressing, template identity, scope, and dependency behavior. Do not follow a reassigned alias into a different resource, silently delete shared templates, or cascade into unrelated resources. Reject known external changes that expand the deletion scope. Native APIs may not offer transactional protection against concurrent external mutation; document that boundary rather than invent a build-level compare-and-delete guarantee or demand proof of an unknowable global ownership graph.
- Use current credentials to reopen the saved reference and perform explicit cleanup. Automatic cleanup remains restricted to the operation's correlated resources. Do not keep all E2B restore/delete operations disabled merely because restore generation and deletion-resource identity are different concepts.

Native shape being mapped (not a Sandbar public API example):

```ts
const captured = await source.createSnapshot(); // Dedicated native snapshot template
// Adapter resolves and records templateId and the captured buildId from native evidence.
const restored = await Sandbox.create(`${templateId}:${buildId}`, nativeRestoreOptions);
// After checking identity and dependencies, delete the dedicated containing resource.
await Sandbox.deleteSnapshot(templateId);
```

## 8. Implementation sequence and acceptance

1. Add resource references, request-specific capability evaluation, errors, and operation plumbing. Test a minimal adapter with no snapshot/volume concepts; keep today's core operations usable.
2. Deliver no-argument snapshot capture/inspect/restore/delete end to end through the direct SDK, migrating foundation requirement evaluation to optional strict checks of configured defaults. Include source disruption, retained-resource reporting, and native-boundary coverage. Use deterministic contrasting profiles: stopping filesystem capture with restart, native pause/resume memory capture, and no capture support.
3. Add native create-time mounts and volume lifecycle. Keep volume versions and dynamic attachments optional. Exercise storage scope, unavailable beta access, failed mount readiness, durability-before-destroy, and explicit unconfirmed cleanup.
4. Add exact-preservation suspend/resume and timeout control, with execution-generation handling and native auto-resume disabled. Then add one verified volume-version adapter and native forks as justified.
5. Address resource sizing, richer images, streaming processes, broader files, and network policies as separate focused contracts. Their capabilities should follow the same exact-requirement rules; this proposal does not bundle the entire inventory into one implementation.

Required tests include no-argument defaults; unsupported-before-mutation; explicit filesystem-only requirements on a memory-only adapter; Daytona running-source stop/capture/start, already-stopped capture without start, and leave-stopped configuration; restart after definitive capture failure; retained snapshot on restart failure; uncertain stop/capture/start without replay or unsafe continuation; E2B native pause/resume without redundant lifecycle calls; captured and restored process behavior; lost capture/restore/delete responses; expired or foreign references; no implicit fresh sandbox on resume; incompatible policy before memory restore; unpinned external mounts; readonly enforcement; concurrent writers and version identity; unknown ownership; and direct SDK recovery across fresh processes and credential rotation. Require persistence-hook failures before and after effects, crash boundaries before/after each stage dispatch, explicit continuation with no duplicate capture/start, source restart after capture exceeds the original wait budget, and known terminal capture failure. E2B cases must cover immutable restore after default-tag movement, deletion of the dedicated containing resource, alias/identity mismatch, missing build, and incomplete build-correlation evidence. Include reopening after source deletion and distinguish explicit deletion from incidental cleanup ownership. Existing service regression coverage must continue to pass; new feature parity is deferred. Qualification must also inspect native retry/auto-resume behavior, not just callback counts. Paid live qualification requires separate authorization.

Extend the live provider E2E harness and attestation reports for snapshot and volume behavior as part of implementation. Daytona and E2B snapshot scenarios must actually execute no-argument capture, inspect, restore, file isolation, source lifecycle and process behavior, and artifact cleanup. An unsupported restore gate before source creation is an incomplete/blocked scenario, not snapshot qualification. Exercise a second connection opening persisted references, source deletion before later restore, and complete resource teardown; cover credential rotation and interrupted continuation with deterministic native-boundary fixtures and bounded live probes where authorized. Attest memory continuation when claimed. Volume scenarios must prove persistence across compute replacement and read-only enforcement when advertised. Record exact configuration and provider/class evidence, and distinguish passed, failed, unsupported, blocked, and not-run scenarios. Fixture evidence and documentation are not live certification; follow the existing bounded authorization and qualification workflow.

Each provider's public docs must describe the default capture scope, memory inclusion, source lifecycle and process/connection effects, restored execution behavior, real options and defaults, exclusions, prerequisites, and partial-failure cleanup/recovery. Mark planned behavior separately from implemented and live-qualified behavior. Update these docs with the implementation; capability metadata alone is not sufficient documentation.

Accepted recovery direction: application-owned JSON persistence; credential-independent resource and operation references; no API-key HMAC requirement; read-only observation plus explicit, durably checkpointed continuation of proven unsubmitted stages; complete E2B capture/restore/cleanup with separate build and deletion identities. These requirements supersede the older read-only-only recovery restriction and the in-flight credential-signed receipt design.

Accepted snapshot direction: no-argument `snapshot()` with adapter-owned native defaults; only real configuration choices; Daytona container source restart by default when previously running; optional exact requirement checks; explicit returned capture/restore semantics; no implicit archive or cross-provider fallback. Explicit restore networking, native create-time mounts first, and durability-required destruction for writable mounts remain in the broader proposal. No production exports or provider behavior change with this document.

## Foundation implementation decisions

This section records the already-merged foundation, including its earlier required-preservation request shape. The next snapshot slice must update that shape and its checks to the optional request/default behavior above; this historical implementation does not override the accepted design.

The first bounded slice exports a version-1 resource reference schema and scope/identity checks, read-only snapshot-profile evaluation, asynchronous capability observations, and create-time snapshot requirements through direct and service clients. Reference ownership is explicit; generations are opaque native evidence and must be supplied for reusable locators. Existing sandbox/image identity APIs and recovery-reference version 2 remain intact. The adapter mutation resource constraint accepts resource references while retaining the legacy sandbox observation field; artifact operation kinds and result dispatch wait for their feature slice.

An optional typed `snapshotCapture` declaration gates the read-only `snapshotProfiles` hook. No public capture method or native capture implementation is added. Other snapshot operations, volumes and suspension remain unsupported. Profiles include mount handling and minimum retention evidence; resolved plans report restore restrictions as unknown, because restore restrictions need the next slice's inspected artifact evidence. Cleanup preferences are manual in this slice. A check is not a reservation. Required creation checks evaluate the selected environment for a future running source and require the adapter to return unknown if class evidence cannot be established without effects. Unsupported creation throws effect-free `UNSUPPORTED`; unavailable and unknown requirements block creation with `UNAVAILABLE`, retaining distinct statuses in the read-only check. Persisted requirements are rechecked in the service runner before submission.

The direct capability getter is now asynchronous. Service connection observations select the first verified installed connection in creation order; a scoped prepared-image binding selects its connection for request evaluation. No placement/filtering engine is added. Built-in provider support is unchanged and has no state-operation qualification claim.

Review clarification: capability revalidation finishes before the durable submission barrier, and SDK dispatch reuses that validation without running read hooks after the marker. Lifecycle outcomes resolve relative to observed source state, so unchanged accepts a stopped outcome for an already-stopped source. Resource service URLs accept only HTTP(S) endpoints without userinfo, query, or fragment components.
