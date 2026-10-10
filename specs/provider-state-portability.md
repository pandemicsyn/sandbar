# Provider state portability

Direction accepted September 28, 2026; recovery and E2B requirements revised September 29, 2026 · Snapshots, core volumes, reopen/inspect, renewal, suspend/resume and selected-volume cold restore implemented; broader storage composition and volume versions remain deferred

This records the accepted SDK and adapter direction for snapshots, volumes, and lifecycle control. Daytona, E2B, Vercel Sandbox, and Tensorlake inform the portable contracts; implementing the future Vercel and Tensorlake adapters is separate work to specify later. Existing exports remain the authority for implemented behavior. Use the [snapshots and volumes guide](../apps/docs/src/content/docs/docs/guides/snapshots-and-volumes.md), [recovery guide](../apps/docs/src/content/docs/docs/guides/recovery.md) and public exports for current signatures. Deferred mount barriers and volume versions below are design constraints, not implemented APIs.

## Delivery scope

Remaining feature slices target the SDK and public adapter API. SDK references, provider scope checks, mutation identity, and reconciliation without blind mutation replay remain mandatory. Applications own persistence of references for SDK crash/serverless recovery.

## Recommendation

Make `box.snapshot()` the normal capture path. Each adapter selects sensible native defaults and performs the lifecycle steps needed to capture state. Configuration exposes real choices, not permission switches for unavoidable provider mechanics. A provider need not support snapshots or volumes to be a valid adapter. Unsupported requests reject before mutation; there is no implicit file-copy snapshot, provider switch, or mount omission.

The portable contract is the call and resource lifecycle, not identical captured state across providers. A default capture may contain files only on one provider and files plus memory on another. Document that behavior before use and return the actual guarantees with the result. Applications that need stricter guarantees can opt into requirement checks; these remain exact and cannot silently degrade. This supersedes the earlier mandatory `preserve`, pause-only default, and explicit stop-permission design.

Keep four concepts separate:

| Concept | Meaning | Surface |
| --- | --- | --- |
| Prepared image | A provider-ready starting environment built or registered before execution | Existing `images.build`, `Image.prepared` |
| Sandbox snapshot | An immutable capture of private sandbox state, used to create a new sandbox | `box.snapshot`, `snapshot.restore` |
| Persistent volume | A mutable filesystem with a lifecycle independent of compute | `client.volumes`, create-time `mounts` |
| Suspension | Retain one logical sandbox for later explicit resumption | `box.suspend`, `box.resume` |

Use **snapshot** as the public noun for the sandbox checkpoint described in the earlier proposal. Do not expose synonymous `checkpoint()` and `snapshot()` methods for that operation. A **volume version** remains distinct from a sandbox snapshot.

An image and a snapshot can refer to the same native artifact, but must retain their separate provenance and guarantees. Do not infer runtime-snapshot support from an adapter's existing `prepared` image support.

## 1. Discover guarantees, not just feature flags

Support distinguishes implemented support, unsupported operations, unavailable access/configuration/state and unknown facts. Snapshot profiles report preservation, eligible source states, interruption, final source lifecycle, connection effects, consistency and fresh/resumed restore execution.

Profiles describe valid combinations and include adapter orchestration, not only the raw native capture endpoint. For example, Daytona's default running-container profile includes stop, capture, and restart. `defaultProfileId` selects the profile for the configured adapter and target class/state; unknown target facts produce unknown/unavailable rather than a guessed default. Separate arrays of preservation modes and disruption levels would incorrectly suggest every combination works. Profile IDs are opaque descriptions, not application branching keys.

Use `await client.capabilities()` for the verified connection and `await box.capabilities()` for the actual sandbox class/state. Preserve the existing command/image/network facts.

`supported` means the adapter implements the stated contract for the checked scope; upstream documentation alone does not qualify it. Publish fixture, packed-consumer, and live evidence separately. Connection capabilities are a dated observation, not a permanent entitlement or reservation. A beta feature without account access is unavailable, not automatically supported. An unimplemented adapter operation is unsupported even if the provider supports it natively. Capture, restore, inventory, and deletion are independently advertised; `RestoreCapabilities` describes enforceable policy, resource, mount, and lifecycle-independence constraints. A restore-only adapter need not support capture.

Use request-specific, read-only checks: `box.checkSnapshot()` evaluates capture, and `client.sandboxes.checkCreate(input)` evaluates ordinary creation defaults and policy. These have distinct plan types; creation does not accept speculative snapshot-preservation requirements. With no request, it resolves the configured native default. Its supported result contains a resolved plan: preservation, disruption, source state after capture, restored process behavior, mount handling, restore restrictions, and retention evidence. Optional hard requirements validate that plan; they do not silently choose another capture mode. Unknown facts remain unknown and cannot satisfy a hard requirement. Running the mutation revalidates that plan's constraints and scope. A check never allocates probe compute, reserves capacity, builds an image, or guarantees a future call will succeed.

## 2. Snapshot and restore

`SandboxState` represents observed creating, running, stopped, suspended, restoring, destroying and destroyed states, with unknown for incomplete native evidence. Wait options retain `AbortSignal` behavior.

### Adapter defaults

The adapter's typed setup owns real native choices. Daytona containers default to restarting a previously running source after capture; `snapshots.restartAfterCapture: false` leaves it stopped. E2B has no reusable-capture option to exclude memory or disable its native brief pause.

| Behavior | Daytona containers | E2B reusable snapshots |
| --- | --- | --- |
| Default capture | Whole private filesystem, excluding external mounts | Private filesystem plus memory/process state, excluding external mounts |
| Running source | Adapter stops it, captures, then starts it | Native capture briefly pauses and resumes it |
| Source already stopped | Capture and leave stopped | Native capture requires a running source; reject before effects |
| Source processes after capture | Previous processes ended; restart does not recover them | Continue; active connections are dropped |
| Restored sandbox | Fresh process execution | Captured process execution resumes |
| Actual configuration choice | `restartAfterCapture: false` leaves a previously running source stopped | None for memory inclusion or automatic pause |

Daytona's native container endpoint requires a stopped source; automatic stop/capture/start is Sandbar adapter orchestration. E2B performs its pause/resume natively. Do not add `allowSourceRestart`, `pauseOnly`, or mandatory `memory: "required"` settings to acknowledge fixed behavior. Daytona VM capture is a separate class-specific implementation: when implemented and qualified, it can expose an actual filesystem/memory selection with cold capture as its default. Do not advertise VM capture merely because the container adapter supports capture.

The default filesystem scope is the provider's whole private persistent filesystem, not a caller-selected directory. External mounts, pseudo-filesystems, and other native exclusions must be reported; do not promise every path under `/`. A future `workspace.snapshot()` or path-scoped export would be a distinct capability with its own fidelity and consistency contract. Portable workspace storage, automatic archives, and cross-provider transfer are outside this slice.

Behavior:

- No-argument capture accepts the configured native profile, including its memory behavior and lifecycle steps. Explicit preservation requirements remain exact: memory capture cannot substitute for required filesystem-only capture, and cold restore cannot satisfy required memory preservation.
- Disruption is reported independently of preservation. Stopping and restarting must never be described as nondisruptive. The default restores the source's prior lifecycle state where the adapter can implement it; Daytona containers restart only if running before capture. A provider unable to do this must document its different default and expose only alternatives it actually supports.
- `sourceAfter: "unchanged"` means lifecycle state, not unchanged files, processes, or sockets. Report process loss and connection interruption separately. Unknown disruption cannot satisfy an explicit finite bound.
- Default consistency is crash consistency only where established by the adapter. Do not require `caller-quiesced` merely to acknowledge native behavior. It asserts the caller stopped application writes beforehand; Sandbar does not certify application-level consistency. Profiles and artifact metadata must represent unknown consistency honestly where evidence is insufficient, and unknown cannot satisfy a requested guarantee.
- Restore creates a new logical sandbox with independent private captured state. Resume is a different operation. Neither promises cross-provider portability. Account, region, class, image, resource, and native dependency restrictions travel with the snapshot.
- `SnapshotInfo` includes exact preservation, fresh/resumed process behavior on restore, source identity/class, excluded paths and mounts, allowed restore overrides, parent/deletion dependencies, creation time, and known expiration behavior. These facts travel with the artifact; reopening it with different connection defaults must not reinterpret its captured state. Unknown values are explicit. Expiry can be absolute or idle-based; inspect reports the latest evidence rather than a fictitious permanent timestamp.
- Minimum retention is a requirement within the documented provider contract, absent explicit deletion. Unknown expiry cannot satisfy it. Cleanup preference must not precede the minimum. Direct mode has no scheduler: requested cleanup is reported as manual unless native expiry enforces it.
- Snapshotting does not capture external volumes by default. Record every exclusion. The implemented selected-volume cold restore accepts a verified mount-free snapshot and `MountSpec[]`; mounted-source capture, unknown mount provenance and memory-plus-storage restore remain unsupported under the [storage contract](storage-composition.md). Future recorded-mount support must require an explicit selection for every recorded path; omission cannot silently discard mounts. Even read-only live mounts can change externally.
- Memory restore with mounts is unsupported until the adapter verifies handling of saved mount credentials, caches, sessions, dirty buffers, and writers. Required network restrictions and attachment changes must take effect before resumed code can run. Reject incompatible overrides before restore submission.
- No atomic root-plus-volume capture is promised. Version a volume separately when supported; application coordination is needed for a consistent multi-resource checkpoint.

Use `client.snapshots.get(reference)`, bounded/paginated `list`, and `delete` for supported inventory/cleanup operations. `get` inspects a scoped resource; it does not import ownership or change scope. List results state whether they cover the provider scope or only Sandbar-managed artifacts. Recovering an operation remains separate from opening an existing resource.

Initially use snapshot followed by restore for a fork workflow. A later `box.fork(request)` can use a native clone path only when it honors the same explicit preservation, interruption, mount, independence, and recovery contracts. Native fork availability is independent of reusable-snapshot availability; a provider might support one without the other. Avoid a generic multi-step fallback engine in the first release.

### Source restoration and partial failure

Daytona's default adapter submission records the observed initial state and each stop/capture/start stage. After a confirmed stop of a previously running source, attempt to start it again after either successful capture or a definitive capture failure. `restartAfterCapture: false` leaves it stopped on either path. An already-stopped source is never started by this option.

Do not claim full success until the requested final lifecycle state is confirmed. If capture succeeded but restart failed, preserve and report the snapshot reference, capture completion, observed source state, and restart failure; do not discard the artifact or submit a second capture. Report capture and restart failures separately when both fail. Restarting does not recover former processes or application readiness.

If a stop, capture, or start response is uncertain, retain its stage and recovery evidence. Do not replay it or start the source while capture may still be in progress. Once a definitive safe outcome is established, the active submission or an explicitly requested continuation may submit a proven never-submitted next stage through the controlled mutation path described below. Observation itself stays read-only. If the process exits or a local deadline expires, persist pending/unknown state; a later invocation must be able to reconcile and finish a still-required restart without capturing again. In particular, a capture that becomes ready after the local wait budget must not strand the source merely because submission waiting ended. Cancellation does not prove remote work stopped and does not authorize background work beyond bounded finalization; a caller can subsequently request continuation from saved state. Never repeat an uncertain mutation.

## 3. Persistent volumes and mount sessions

`volume.at(path, options)` constructs a mount descriptor without IO. Unversioned mounts default to read-write. Deferred volume-version support must default pinned mounts to read-only. The provider must enforce every requested access mode.

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

Sandbox destruction never deletes volumes. Extend the destroy result to include confirmed compute termination, retained resources, and per-mount durability outcomes. With writable mounts, the implemented default is `storage: "require-durable"`; use provider durability evidence or a supported barrier, and reject before compute deletion if it cannot be established. A barrier must cover the departing session through shutdown, using a verified drain/freeze/close protocol; flushing while writers continue is insufficient. A failed cleanup after a submitted flush can have storage effects and must not be called effect-free. Explicit `storage: "allow-unconfirmed"` still permits compute cleanup and reports the risk to unsaved data. Volume-free destroy retains today's behavior. This default is preserved by the connection cleanup policy.

### Implemented cleanup configuration

Applications may choose the writable-volume cleanup policy upfront for a client connection and override it per destroy call. Resolve the explicit call option first, then the configured policy, then the existing `require-durable` default. PR #34 implements `cleanup.storage` on SDK connections, with a per-call `storage` override. `allow-unconfirmed` permits compute cleanup without claiming a durability barrier, and never deletes retained volumes. Keep actual per-mount durability and retained-resource reporting. Selected-volume cold restore is also implemented in #69; richer volume guarantees remain separate in [the roadmap](../ROADMAP.md).

## 4. Suspension, resumption, and expiry

The implemented [lifecycle contract](sandbox-lifecycle.md) covers reopen/inspect (#38), renewal (#55) and native suspend/resume (#57), including native defaults and setup-time minimum preservation requirements.

Concentrate meaningful lifetime and preservation choices in adapter setup, with sensible native defaults. The application should not select native timeout scopes or pass preservation requirements on every call. `renew()` uses the configured initial lifetime; an explicit window is in portable seconds, with adapter-owned reset/add mechanics and upward rounding. Document expiry action, running-versus-hard-clock behavior, retention, process/connection effects and limitations for each provider. Explicitly configured suspension preservation is a minimum; additional memory preservation can satisfy filesystem preservation. Snapshot requirements retain their separate exact contract.

Resume retains logical identity and reports actual execution evidence or unknown. Expired saved state fails; never silently create a fresh empty sandbox. Do not synthesize checkpoint/delete/recreate and call it native suspension. `destroy` permanently ends logical compute; native stop alone is insufficient when that object can resume.

Get/inspect/list/recovery and guest operations do not implicitly resume or renew in this slice. Adapters avoid native helpers that auto-resume or replay commands. Unsupported operations reject before mutation without making the adapter unusable for unrelated features. No automatic paid snapshots or background heartbeat loops.

## 5. When a provider has no snapshots

The adapter omits snapshot operations and reports `snapshots.capture.status: "unsupported"` (and the same for each absent snapshot operation). SDK resource methods remain consistently named; calling `box.snapshot` throws a typed `UnsupportedFeatureError` with `code: "UNSUPPORTED"`, `effect: "none"`, the feature, and unmet requirements. It must happen before even stopping the sandbox.

Applications have three explicit choices:

1. Require snapshots and reject an adapter with unsupported capture before creating compute, using current connection capabilities. Resource-specific guarantees may still require `box.checkSnapshot()` after creation; there is no generic create-time snapshot-requirements hook. Read-only checks must not allocate probe compute or build an image. Callers can explicitly build first and evaluate the prepared result.
2. Make snapshots optional and branch on `checkSnapshot`. Continue without a checkpoint only if the application accepts losing that recovery feature. An unknown/unavailable result is distinct from unsupported and can justify retrying a read-only check.
3. Choose another explicitly configured provider before allocation. A direct client remains bound to its selected provider.

A volume can preserve selected working files when snapshots are absent, but not installed root packages or RAM. A rebuild recipe can recreate an environment, but not arbitrary runtime state. A future explicit archive/export API could copy selected files, with its own fidelity and consistency contract. None returns a fake `SnapshotHandle`.

Do not catch every snapshot exception and fall back. `UNSUPPORTED` before submission is effect-free; a failure after stop/capture dispatch can be partial or unknown. It may have stopped compute and retained a billed artifact. Return the existing recovery/effect error model with the known source and artifact facts, and never switch providers or submit another capture automatically.

## 6. Adapter/runtime implementation boundaries

The public adapter contract uses optional typed operations for snapshot capture/restore/delete, volume create/delete, mount barriers/versioning, and suspend/resume/timeout changes. Keep separate read methods for capabilities, inspect, and inventory. Derive SDK availability from both the declared profiles and actual operation implementations; absent methods cannot be advertised as supported. Keep provider-specific schemas and transports outside portable packages.

The September 30 [SDK results/errors direction](sdk-recovery-dx.md) governs the current DX follow-up and supersedes earlier requirements to expand application persistence callbacks or generic durable workflow recovery. Ordinary snapshot/volume methods and minimal saved resource identities are the primary contract. Existing mutation preparation, submission and read-only observation remain supported where implemented; a new mutation does not require a new workflow framework or submission API solely for uniformity.

The adapter owns its configured native workflow and preserves confirmed partial results if a later stage fails. Never put writes in `observe`, `inspect` or `get`, or automatically replay an uncertain effect. Preserve shipped continuation/checkpoint safety and compatibility without expanding them into a new workflow framework. Applications own persistence and subsequent recovery policy. No hidden database, scheduler is introduced.

`ResourceReference<K>` is versioned, serializable, and includes resource kind, provider, verified scope, native locator, and generation where native names are reusable. References hold no credentials and confer no provider authorization. They must remain usable with different valid credentials for the same native scope. Borrowed artifacts, SDK-created artifacts, and artifacts with uncertain creation provenance remain distinguishable; a name prefix alone is not creation evidence. Native identity, application-retained historical observations, and current provider observations are separate facts, not a single signed ownership credential.

### Application-owned persistence and credential-independent references

The SDK supplies minimal versioned resource identities that applications can persist in their chosen store. Reopening in a fresh process or Lambda invocation with current credentials is a required workflow. There is no required Sandbar backing store, long-lived client, process-local registry, or provider-API-key signing secret.

Keep two reference roles separate; the first is the ordinary public resource contract, while the second is existing advanced compatibility:

- **Resource reference:** resource kind, provider, required native scope/routing, stable native locator, and immutable generation/build selector where applicable. Retain only additional fields actually required for safe native restore/delete; keep descriptive observations in results rather than accumulating them in the locator. Reopening must not require the original source sandbox to remain alive where the artifact survives independently.
- **Operation reference (existing advanced API):** native attempt/correlation information for supported pending or uncertain work. Preserve necessary shipped formats and safeguards. Do not require this envelope or a persistence callback to save and reopen a known snapshot or volume, and do not promise missing-ID recovery without native correlation support.

Saving a completed resource reference leaves a crash window around native creation and application persistence. The application owns that policy. Report an ambiguous response with any known IDs and supported native operation handles; the caller can use available discovery/inspection to investigate. Listing alone does not certify ownership of a failed attempt or prove no effect. Do not require an awaited `onReference` hook or add an SDK persistence error for an application save performed after the SDK call returns. New/expanded callback and durable checkpoint contracts are deferred; retained legacy paths must continue to surface confirmed results correctly when a configured write fails.

Do not sign resource/operation references with provider credentials or require an adapter HMAC receipt to restore/delete a resource. Schema/version validation, authenticated scope verification, native identity checks, and current provider authorization remain required. Treat references as application-owned persisted input: historical observations retain their provenance and must not be relabeled as freshly verified native guarantees. Where a required fact cannot be established from native evidence or the trusted application's retained observations, report it as unknown or reject the specific guarantee. Applications exposing references to untrusted callers must enforce their own tenant authorization and storage integrity; the SDK does not turn a reference into an authorization token.

An explicit user-requested artifact deletion must not require proof that this particular SDK connection originally created it. Verify the target identity/scope and deletion semantics, enforce native restrictions, and respect known dependencies. Automatic or incidental cleanup is different: only clean up resources correlated to that operation, never infer cleanup ownership from a name or inventory listing. Credential rotation must not invalidate retained creation history or force callers to retain revoked credentials. No custom signing infrastructure is required by this contract.

### Reconciliation and explicit continuation

Native pending-operation observation may remain useful where the provider exposes an actual operation handle or reliable correlation. Without that native support, report uncertainty instead of inventing a portable reconciliation guarantee. Applications choose later actions using supported read-only APIs and current provider authorization.

Explicit continuation already shipped in the foundation is an advanced compatibility surface. Preserve its stage/identity checks, application serialization requirements and protection against replaying uncertain effects. Do not remove its existing dispatch barriers blindly, introduce a new continuation framework, or make its expansion an acceptance gate for every future adapter. The current follow-up exposes known resource identities and clear partial errors directly; a broader crash-recoverable workflow requires a separate demonstrated use case.

Deletion restricts rather than cascades. Track known artifact roles/dependencies so a snapshot exposed as an image is not deleted twice. Direct mode can enforce known dependencies and native restrictions, not invent a complete global ownership graph. Report unverified external dependencies. Unknown operations retain effect and retained-resource evidence and must not trigger garbage collection. Confirmed native deletion is not proof that billing already ended.

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

The implemented E2B contract requires a usable capture → inspect → restore → cleanup workflow. Independently advertised capabilities remain useful for genuinely partial adapters, but capture-only E2B support is not completion of this implementation unit. Its live roundtrip must not be replaced by an unsupported-capability short circuit.

- Use an unnamed native capture to allocate a dedicated snapshot template per Sandbar capture. Avoid intentionally reusing a named template across captures. The [E2B create-snapshot API](https://docs.e2b.dev/api-reference/sandboxes/create-snapshot) documents that a reused name appends a build to an existing template; an unnamed response uses the raw template ID with `:default`.
- Retain the native template ID and captured build UUID as separate facts. Establish the build from correlated native capture/template evidence; a later lookup of a moved tag must not invent the captured generation after an acknowledgement/evidence gap. Preserve unknown outcomes when that correlation cannot be established.
- Restore using the immutable selector `templateId:buildUUID`, not the mutable `:default` tag. The pinned E2B JavaScript SDK forwards this selector, and [upstream build selection](https://github.com/e2b-dev/infra/blob/48772bf11820dbd46474bf5dcdd419c7119b864f/packages/db/queries/templates/get_template_with_build_by_tag.sql) explicitly accepts a build UUID for snapshot templates. This is source evidence, not live qualification or a claim that the prose SDK docs guarantee every deployed API version. Validate against the supported native version before advertising it.
- Inspect the referenced captured build even when the default tag moves. A changed default tag alone must not invalidate an otherwise addressable captured build. Missing/deleted builds must fail; never restore the latest build as a substitute. Enforce requested network restrictions before resumed memory can execute.
- Model cleanup as deletion of the dedicated containing native snapshot template, not deletion of an individual build. E2B's documented `Sandbox.deleteSnapshot` uses template deletion. Retain that deletion target separately from the immutable restore selector; appending a build UUID to DELETE does not create a generation precondition.
- Verify native addressing, template identity, scope, and dependency behavior. Do not follow a reassigned alias into a different resource, silently delete shared templates, or cascade into unrelated resources. Reject known external changes that expand the deletion scope. Native APIs may not offer transactional protection against concurrent external mutation; document that boundary rather than invent a build-level compare-and-delete guarantee or demand proof of an unknowable global ownership graph.
- Use current credentials to reopen the saved reference and perform explicit cleanup. Automatic cleanup remains restricted to the operation's correlated resources. Do not keep all E2B restore/delete operations disabled merely because restore generation and deletion-resource identity are different concepts.

## 8. Regression and evidence boundaries

Snapshots, core volumes, cleanup configuration, ordinary partial results, reopen/inspect, renewal, suspend/resume and selected-volume Daytona cold restore are implemented. The [roadmap](../ROADMAP.md) owns remaining delivery order; focused [lifecycle](sandbox-lifecycle.md), [storage](storage-composition.md), [recovery](sdk-recovery-dx.md), [execution](interactive-execution-and-access.md) and [output](output-and-timeouts.md) contracts own their detailed boundaries.

Preserve deterministic coverage for configured defaults and exact requirements; unsupported-before-mutation; Daytona stop/capture/start, already-stopped and leave-stopped paths; restart after definitive capture failure; retained artifacts on restart failure; uncertain stages without replay or unsafe continuation; E2B native pause/resume without redundant lifecycle calls; capture/restore process semantics; lost responses; expired/foreign references; source-independent reopening and credential rotation. E2B coverage must distinguish immutable build restore from containing-template deletion, including tag movement, alias mismatch, missing build and incomplete correlation. Keep shipped legacy checkpoint/continuation regressions; expanded persistence machinery is deferred.

Provider qualification must distinguish fixture, packed-consumer and live evidence, and passed, failed, unsupported, blocked and not-run scenarios. Snapshot evidence requires actual capture, inspect, restore, file isolation, lifecycle/process behavior and owned cleanup; a pre-allocation unsupported gate is not snapshot qualification. Volume claims require compute-independent persistence and enforced access modes. Native retries/auto-resume, memory continuation and independent artifact lifetime need evidence when claimed. Follow the [maintained qualification workflow](../packages/sdk-qualification/provider-qualification/README.md); this contract authorizes no paid/live calls.

Provider docs must explain capture scope, memory inclusion, source lifecycle/process/connection effects, restored execution, real options, exclusions, prerequisites and partial-failure recovery. Distinguish planned, implemented and live-qualified behavior. Broader storage composition, versions and native forks require separately scoped work.
