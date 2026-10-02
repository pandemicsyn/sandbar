# Storage composition

Accepted design · revised October 2, 2026 against Sandbar `0a022a8` · implementation brief, no runtime changes

## Scope

Use **`mounts: MountSpec[]` on both create and restore**, with the existing `volume.at(path)` helper. One descriptor selects storage for the workload; there is no second `attach` input or sharing permission flag. Start with **Daytona mount-free filesystem snapshot restore plus caller-selected volumes**: reusable private code/configuration state alongside independently retained application data. This does **not** capture and restore an already mounted workspace; that second workflow needs native exclusion/provenance evidence.

For a mount-free snapshot, omitted `mounts` means no mounts. Supplying the same volume deliberately shares its current mutable data; selecting a separately created volume gives separate data. Neither choice pins captured-time bytes or copies data. Never create storage implicitly, substitute a missing volume or silently discard recorded mounts. Existing mounted-source and memory-plus-storage restore remain unsupported in the first slice.

The next coordinated SDK/adapter API release replaces the inactive restore action-map with this array. Keep the SDK-only empty-object mount-free alias through that release and one subsequent published release; remove it in the following API release. Nonempty legacy maps reject with a migration message. The [migration contract](#compatibility-and-migration) below is settled.

Daytona's native create path accepts snapshot identity, volume IDs and network policy together. Implement the scoped mapping with the [startup acceptance gate](#startup-evidence-and-bounded-live-acceptance). The read-only check found useful mount ordering evidence but contrary evidence for early `networkBlockAll` enforcement in an older public runner. Keep `daytona-default` explicit; do not advertise blocked-before-entrypoint behavior without applicable ordering evidence and the live check.

Creation defaults, text helpers, lifecycle operations and process termination are merged on this baseline. Follow the [roadmap](../ROADMAP.md) for scheduling; this brief does not reorder work. It supplements [state portability](provider-state-portability.md) and [ordinary recovery DX](sdk-recovery-dx.md). Runtime implementation and the bounded live run will be delegated separately after this spec review.

## Mocked application walkthrough

These are **proposed, uncompiled examples with deterministic mock responses**, not live-provider instructions or a new exported mock API. Restore currently rejects nonempty mounts and exposes the legacy action-map shape. Creation defaults and text helpers are shipped; the array restore input is proposed. See [everyday files](sandbox-basics-dx.md) for those existing helpers. Implementation must turn these scenarios into compiled public examples backed by native-boundary fixtures.

The mock represents a qualified filesystem/fresh-execution adapter. It supplies a caller-provisioned `report-worker-v1` image, a ready mount-free snapshot, ready ID-addressable volumes and support for the requested network policy. Its simulated startup installs mounts and policy before the image entrypoint. These fixture assumptions do not establish Daytona's native startup order, capture exclusions or shutdown durability; those remain the release gates below. IDs such as `snapshot-001` and `volume-001` are mock responses, never IDs applications construct.

### 1. Configure once, create data and capture private state

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

function openClient() {
  return Sandbar.connect(daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    target: "us",
    environment: Image.prepared("report-worker-v1"),
    networkPolicy: "daytona-default",
  }));
}

const client = await openClient();
const data = await client.volumes.create({ name: "customer-data" });
const writer = await client.sandboxes.create({
  networkPolicy: "daytona-default",
  mounts: [data.at("/data")],
});
await writer.writeTextFile("/data/report.json", '{"total":7}', {
  overwrite: true, // Daytona mounted writes require this choice.
});

// Capture private application state from a separate, mount-free sandbox.
const base = await client.sandboxes.create({ networkPolicy: "daytona-default" });
await base.writeTextFile("/tmp/app-version.txt", "v1");
const captured = await base.snapshot();
```

Mock observations: `data.id === "volume-001"`; capture returns `snapshot-001`, filesystem preservation and fresh restore execution. The snapshot contains `/tmp/app-version.txt`; it does not contain the writer's `/data/report.json`. `data.at("/data")` constructs a descriptor without a provider call. Snapshotting `writer` remains unsupported in slice 1.

The same descriptor vocabulary works for both operations:

```ts
const mount = data.at("/data");
const created = await client.sandboxes.create({
  networkPolicy: "daytona-default",
  mounts: [mount],
});
const restored = await captured.snapshot.restore({
  networkPolicy: "daytona-default",
  mounts: [mount],
});
console.log(await restored.readTextFile("/tmp/app-version.txt")); // "v1"
console.log(await restored.readTextFile("/data/report.json"));    // '{"total":7}'
```

Mock observations: `created` starts from the configured image; `restored` starts from `snapshot-001`. Both select exactly `volume-001`. Selecting that volume deliberately shares its current mutable data with the writer and other users. A snapshot does not freeze those bytes. The mock establishes the expected mapping, not portable concurrent-writer or flush guarantees. This example explicitly accepts provider-managed egress through `daytona-default`; it makes no blocked-network promise. A stricter policy must be qualified under the startup gate and otherwise reject before creation, never fall back.

### 2. Save full references and reopen through a fresh connection

```ts
// In-memory stand-in for the application's database, not SDK persistence.
const records = new Map<string, string>();
records.set("report-job", JSON.stringify({
  snapshot: captured.snapshot.reference,
  data: data.reference,
}));
await base.destroy(); // The snapshot remains independently addressable.

const freshClient = await openClient(); // Current credentials, same verified scope.
const saved = JSON.parse(records.get("report-job")!);
const snapshot = await freshClient.snapshots.get(saved.snapshot);
const selectedData = await freshClient.volumes.get(saved.data);
const reopened = await snapshot.restore({
  networkPolicy: "daytona-default",
  mounts: [selectedData.at("/data")],
});
```

Mock observations: reopening inspects the saved snapshot and volume identities in the configured scope; restoration selects `snapshot-001` and `volume-001` even though `base` was destroyed. It needs neither the original handles nor the old API key. Production applications replace `records` with durable storage and retain the returned handles/references if saving fails. The map only demonstrates the JSON boundary; it does not survive a process restart. No resource is discovered or recreated by name.

### 3. Choose shared data, empty independent data or private state only

```ts
const experimentData = await freshClient.volumes.create({ name: "experiment-data" });
const experiment = await snapshot.restore({
  networkPolicy: "daytona-default",
  mounts: [experimentData.at("/data")],
});
const privateOnly = await snapshot.restore({ networkPolicy: "daytona-default" });
```

| Mock restore input | Selected data | Expected observation |
| --- | --- | --- |
| `[selectedData.at("/data")]` | Existing `volume-001` | `/data/report.json` contains the current shared data |
| `[experimentData.at("/data")]` | New empty `volume-002` | `/data/report.json` is absent; writes do not change `volume-001` |
| Omitted `mounts` or `[]` | No external volume | Private captured state only; this fixture has no `/data/report.json` |

All three restore `/tmp/app-version.txt` as `v1`. The experiment is an independent **empty** data workspace, not a copy of the original. Forking existing volume bytes needs a separately qualified native copy/version operation. There is no implicit volume creation, recursive copy or portable `fork()` here. Attachment hides any private snapshot directory at its mountpoint without erasing its underlying bytes; the mock's absent file is not a general promise of an empty underlying directory.

### 4. Unsupported combinations fail at the ordinary call

Callers make the same `snapshot.restore({ networkPolicy, mounts })` call and handle the result; no capability negotiation is required. A UI may inspect support to explain available choices. Each row below is a separate mock fixture, not an assertion that an unimplemented provider is usable today.

| Fixture and requested operation | Expected result before provider mutation |
| --- | --- |
| Restore hook has no mount support, even though the provider supports volume CRUD | `UNSUPPORTED`, effect `none`; reason identifies restore-with-mounts; zero create calls and no dropped mount |
| Selected volume belongs to another provider/account/partition | Reject under existing scope validation; zero create calls; no same-name substitute |
| Cold-only mapping receives a filesystem+memory snapshot and new mounts | `UNSUPPORTED`, effect `none`; reason identifies the unsupported preservation/execution combination |
| Snapshot mount provenance is unknown | Reject before restore dispatch; do not assume it was mount-free |
| Older custom restore hook lacks the array-input marker | Reject before hook preparation/submission with adapter-upgrade guidance; mount-free work remains compatible |

For the first row, the ordinary caller can explain the failure without losing the selected data:

```ts
import { UnsupportedFeatureError } from "sandbar-sdk";

try {
  await snapshot.restore({
    networkPolicy: "daytona-default",
    mounts: [selectedData.at("/data")],
  });
} catch (error) {
  if (error instanceof UnsupportedFeatureError) {
    console.error(error.unmetRequirements.join("\n"));
    // Mock reason: this adapter does not support restore with mounts.
    // selectedData.reference still identifies the retained data.
  }
  throw error;
}
```

E2B's native volume support does not imply its Sandbar adapter qualifies this combination. Tensorlake's future adapter can use the same caller syntax for a qualified cold snapshot and supported filesystem selection; this is a mapping target, not current support. A provider must reject a requested combination it cannot guarantee rather than quietly ignore `mounts`, resume incompatible memory or select substitute storage. Native live-filesystem selection, immutable read-only versions and writable forks remain distinct.

### 5. Clean up compute while retaining chosen data

After successful work in the first three examples, the application can release its known compute and snapshot resources separately:

```ts
await writer.destroy({ storage: "allow-unconfirmed" });
await created.destroy({ storage: "allow-unconfirmed" });
await restored.destroy({ storage: "allow-unconfirmed" });
await reopened.destroy({ storage: "allow-unconfirmed" });
await experiment.destroy({ storage: "allow-unconfirmed" });
await privateOnly.destroy();
await snapshot.delete();

// Keep customer data. Delete only the now-unused experiment data.
await experimentData.delete();
await freshClient.close();
await client.close();
```

Mock observations: all acknowledged compute deletions are confirmed; the snapshot and `volume-002` are deleted; `volume-001` remains accessible through its saved reference. In an application, update/tombstone saved records only after the relevant artifact deletion is confirmed. This is a successful cleanup sequence, not an unconditional `finally`: if restore or cleanup has an uncertain outcome, preserve identities and reconcile the acknowledged compute before deleting dependent artifacts.

The configured cleanup policy can supply the repeated compute choice. `allow-unconfirmed` accepts unconfirmed shutdown durability; it is not a flush promise. Retained resources remain the application's responsibility until separately deleted.

## Public and adapter shape

Keep `volume.at(path, { access, subpath })`, bound snapshot handles and the ordinary result/error model. The only workload-input change is:

```ts
interface RestoreRequest {
  networkPolicy: string;
  mounts?: MountSpec[];
  resources?: { vcpu?: number; memoryMiB?: number; diskMiB?: number };
  requireIndependentLifecycle?: boolean;
}
// Existing RestoreCapabilities / SnapshotInfo.restore.mounts: boolean
// Optional adapter hook marker: snapshotRestore.mountInput?: "specs"
// Existing snapshotRestore.prepare / submit / observe operations remain.
```

The support boolean describes the qualified combination, not every snapshot/mount combination. Callers need no negotiation. Nonempty arrays require the hook marker before adapter preparation; see migration below.

Slice 1 accepts a ready snapshot with `preserve: "filesystem"`, `restoreExecution: "fresh"`, no recorded native mounts and `mountHandling: "none"` under the existing capture-reference validation. Validate selected volume provider, authority, routing scope, exact native ID and readiness; reject unsupported read-only access, overlapping paths, subpaths/classes and policy combinations before dispatch. Revalidate at submission; preparation is not a reservation.

Reuse Daytona `checkMounts` and the create driver: one `POST /sandbox` selects the exact snapshot ID, `volumes: [{ volumeId, mountPath, subpath }]` and the explicit supported network policy. Confirm actual snapshot identity and the complete expected mount set before returning success. No post-create attachment, name-based replacement or automatic retry.

Selected mounts belong in restore recovery input and direct outcomes, separate from the sandbox reference. Keep ordinary sandbox references limited to identity and native creation selectors under the [reopening contract](sandbox-lifecycle.md#reopening-and-identity). Obtain current mounts through authenticated native inspection for reopening, cleanup and read-only recovery; saved selections are not current observations.

## Existing capture provenance supports reopening

Read-only inspection at `0a022a8` confirms this path already exists; no new provenance fields are needed:

- [`observedCapture` / `inspectSnapshot`](../packages/providers/daytona/src/state-native.ts) issue existing snapshot `history` containing source ID/class, filesystem preservation, `mounts: "none"` and consistency. [`resourceHistory.read`](../packages/providers/daytona/src/resource-history.ts) validates its schema, kind, native ID and generation. Inspection separately verifies native snapshot ID, organization, source-sandbox ID, container class and regional readiness before reusing historical capture facts.
- Reopening reads the retained snapshot, not the original source sandbox. Existing [native-boundary tests](../packages/providers/daytona/src/state-native.test.ts) serialize the full reference, use a fresh connection/key and make source reads return 404 while snapshot inspection still reports `mountHandling: "none"`. The first implementation extends that case through mounted restore. Native retention of the corroborating snapshot fields is part of live acceptance; if missing, provenance remains unavailable.
- These are references in an application-owned trusted store, not signed attestations. Keep full returned history and the existing validation. Malformed history cannot supply provenance and native identity/source/class mismatches reject, but the validator does not independently authenticate historical mount absence; well-formed forged history is outside the trusted-store contract. `inspectSnapshot` restores the existing mount-free classification from matching source/class/preservation history, not a new mount attestation. Imported snapshots without usable provenance remain unknown. Snapshot history is distinct from the observation-free **sandbox** reference.

Here, mount-free means the capture mapping records no native provider volume attachments. It does not enumerate every guest filesystem or certify absence of guest-created FUSE/network mounts. Source-local private filesystem state is the supported claim; external flush, atomicity and remote-storage consistency stay unknown. The merged E2B lifecycle likewise allows private filesystem/RAM preservation when native mount metadata is missing and rejects known attached volumes for its initial subset. That lifecycle rule does not enable E2B mounted snapshot restore or change this Daytona-only implementation slice.

## Startup evidence and bounded live acceptance

**Focused finding, October 2:** published SDK `@daytona/sdk@0.218.0` forwards snapshot, volumes and `networkBlockAll` together. The available public runner tag `v0.190.0` at `01c502bb1f1ff8f2885d0cd490e043736083dca8` prepares volume binds before `ContainerCreate`, then calls `Start`; however, `networkBlockAll` rules are set asynchronously **after** `Start`. `Start` calls `ContainerStart` before waiting for daemon readiness. This source is not verified as the deployed v0.218 API backend, so it establishes a concrete ordering risk, not the behavior of every production sandbox.

Evidence: [SDK 0.218.0 artifact](https://registry.npmjs.org/@daytona/sdk/-/sdk-0.218.0.tgz), [runner create](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/runner/pkg/docker/create.go#L152), [runner start](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/runner/pkg/docker/start.go#L55), and [entrypoint selection](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/runner/pkg/docker/container_configs.go#L143). The production [volume contract](https://www.daytona.io/docs/en/volumes/#mount-volumes) documents creation-time mounts; the [network contract](https://www.daytona.io/docs/en/network-limits/) documents policy selection and account eligibility, but does not establish earliest-entrypoint enforcement. A native flag read after creation cannot close that gap.

**Release rule:** qualify native-ID mounts with explicit `daytona-default` using the documented creation contract, the relevant source ordering and the entrypoint sentinel below. This policy accepts provider-managed egress; do not relabel it isolated. Enabling `blocked` for this mounted-restore slice additionally requires an applicable deployed-server ordering path or explicit provider guarantee that policy precedes the image workload, plus the same live check. The inspected docs alone do not satisfy that stricter claim; a finite passing probe cannot override the contrary source ordering. Until that evidence is available, reject `blocked` plus mounts before dispatch. This is a specific policy boundary, not an unbounded proof obligation or a requirement for universal atomicity against other actors.

The implementation's maintained live scenario uses a caller-provided prepared container image/test fixture. It must preserve a boot sentinel as the image's first application action across snapshot capture/restore, including any native daemon wrapper. It keeps the toolbox reachable for inspection on failure but runs no application work until the sentinel succeeds. Do not add an image-build framework, entrypoint API or new service merely for qualification.

1. **Budget and setup.** After separate live authorization, allocate at most four sandboxes total (one mount-free capture source, one volume seeder, two restore candidates), two new volumes and one captured snapshot. Borrow the supplied image and an existing operator-controlled TCP canary; never delete those. Require a confirmed image size/default no greater than 2 vCPU, 4 GiB RAM and 10 GiB disk; set each compute TTL to 10 minutes and cap the run at 20 minutes including cleanup. Write at most 1 MiB per volume. No automatic replacement allocations on uncertainty. If the fixture, policy eligibility or budget cannot be met, report not-run before allocation.
2. **Prepare exact data.** The seeder writes a unique marker to each volume and application data only to volume A; B has no application data. Confirm both markers from the seeder and the canary's reachability as a positive control. The fixture starts idle without application work when its private config is absent, so the bootstrap sentinel does not require a configured data profile; the seeder still receives both volume mounts at creation, while the capture source has none. The mount-free source stores a table mapping both marker IDs to their expected application-data hash/absence and policy in that private config, then captures with the existing `restartAfterCapture: false` setup option. Save the full returned snapshot/volume references and destroy the source before reopening them through a fresh connection. Destroy the seeder when finite writes complete, explicitly accepting unconfirmed shutdown durability; inability to read the markers later fails the case rather than inventing a flush guarantee.
3. **Observe the first application action.** On each cold restore the sentinel replaces any inherited report, records the current native sandbox ID and a newly generated per-start nonce, and immediately checks `/data/.sentinel-id` and expected data/absence. It makes up to three bounded one-second TCP attempts to the controlled canary before any application work: success is expected for this `daytona-default` fixture; all attempts must fail for a separately qualified `blocked` run. It must not wait for mounts/policy to become ready or retry until a mismatch disappears. Write a bounded private report containing those initial observations and then a distinct application-start marker only on success. Native inspection must also match the exact snapshot, complete selected mounts and requested policy. Bind the report to the current sandbox and fresh start so captured source output cannot count as a pass. The sentinel permits application start only for a recognized A/B profile; the harness must correlate its reported marker/data profile with the exact volume requested for that restore. Passing the other recognized profile is a mismatch, even if its data are internally consistent.
4. **Two restores and pass criteria.** Restore with A, then restore with B using the same captured private state. Both must observe the correct marker on their first attempt; A sees the seeded application data and B sees its absence. The network behavior and native policy must match the selected scenario before the application-start marker. Confirm a fresh-client sandbox reopen with the unchanged identity-only reference and a native mount read. The run qualifies the tested image, region, provider configuration and revision; it does not prove continuous enforcement on every deployment or concurrent-writer consistency. An unreachable positive-control canary, stale/missing report, mismatch, unexpected connection or uncertain native outcome is a failure/inconclusive result, never a pass from timeout alone.
5. **Cleanup.** Record every acknowledged compute, snapshot and volume identity as soon as received. Destroy known compute first with the deliberate writable-storage cleanup policy, then delete the captured snapshot and both test-created volumes after dependencies are confirmed clear. Verify deletion/absence through their existing native identity checks; report retained/uncertain resources and stop rather than blindly retry or delete shared/borrowed data. Preserve failed evidence as well as successful evidence in the maintained qualification records.

A sentinel can reveal incorrect initial data or an observed early connection; its negative network result cannot prove the absence of every startup race. That is why the blocked-policy gate needs applicable ordering evidence. Post-create inspection and mock request serialization remain useful checks, but neither substitutes for observing the first application action.

## Outcomes and explicit cuts

| Outcome | Preserve and next action |
| --- | --- |
| Volume creation succeeds; later restore rejects | Keep the received volume reference for reuse or deliberate deletion |
| Compute acknowledged; identity/mount verification fails | Direct unknown/partial outcome retains scoped compute identity and selected volumes; inspect that compute without replay |
| Capture completes; source restart fails | Existing partial capture result retains snapshot and source/restart evidence |
| Response lost after dispatch | Preserve received IDs/native operation selectors; read-only reconciliation, no automatic replacement |
| Deletion uncertain or dependency conflict | Keep retained identities and prior confirmed deletions; reconcile before explicit cleanup |

Extend the existing ordinary outcome union only enough to expose acknowledged restored compute and selected volumes directly. No composite manifest, persistence callback, generic recovery engine or compensation cascade. Applications own the allocation-to-save crash window. Do not turn missing optional metadata into “nothing created.” Existing scope/ownership and deletion checks remain in force.

Mounted-source capture, mount omission, memory composition, resizing, post-create attachment, copy/version/fork and stronger flush/locking/rename guarantees are outside PR 1. A possible later mounted-capture slice requires specific production container/FUSE exclusion and retained-declaration evidence; filesystem capture alone does not establish exclusion. It would reuse the array to require a descriptor for every recorded path. Omitted/empty input must never silently discard recorded mounts. Guest mounts remain outside the native enumeration guarantee.

The common syntax is intentionally extensible beyond Daytona. E2B volume CRUD/account eligibility and native-ID mounting are separate questions; its name-based mounting is not inherently impossible, but its current Sandbar mapping does not qualify this cold-restore combination. [E2B mounting](https://docs.e2b.dev/volumes/mount) and [snapshot semantics](https://docs.e2b.dev/sandbox/snapshots) remain the native references. Tensorlake's [research #45](https://github.com/pandemicsyn/sandbar/issues/45), [snapshot docs](https://docs.tensorlake.ai/sandboxes/snapshots) and [filesystem mount docs](https://docs.tensorlake.ai/sandboxes/mount-filesystems) own its broader evidence. Its native snapshot ID plus filesystem mount shape fits this vocabulary; live filesystem selection, immutable read-only versions and writable forks remain different operations. Name reuse/generation binding and combined restore ordering must be qualified for that adapter; they are not Daytona prerequisites or authorization to implement another provider.

## Compatibility and migration

The next coordinated SDK/adapter API release changes public `RestoreRequest.mounts` types/schema to `MountSpec[]`. Let that release be R: the SDK accepts legacy empty `{}` at runtime as a deprecated mount-free alias in R **and the next published release R+1**, then removes it in the next API release after R+1 with the appropriate semver boundary. New public types and examples teach only arrays. Nonempty legacy action maps reject before effects with a specific migration message; `share`, `replace` and `omit` are never reinterpreted. Once the empty alias is removed, it follows the existing `INVALID_ARGUMENT` convention.

Repository facts checked at `0a022a8`: [`sandbar-sdk`](../packages/sdk/package.json) and [`sandbar-adapter`](../packages/adapter/package.json) both have manifest version `0.0.0`; [Changesets](../.changeset/config.json) fixes them into one version group and the [release manifest](../scripts/release-packages.json) contains exactly these two packages. There are no local version tags. This is repository state, not a registry publication claim. Use one coordinated changeset for the implementation, following the existing public-release process; record the actual R version in its changelog when versioning runs. If released stable types are affected, use the required breaking semver bump. This prose-only spec does not publish or version packages.

Before passing nonempty arrays, the SDK requires `snapshotRestore.mountInput: "specs"`. Missing marker rejects before adapter preparation/submission with upgrade guidance, even if the earlier capability boolean is true. Mount-free requests keep the old path and omit `mounts` at an older hook. The one optional marker is the complete compatibility mechanism; no top-level version negotiation or permanent second workload input.

Saved snapshot, volume and sandbox identity formats remain unchanged. Existing operation references must still parse and support read-only observation; normalization cannot replay mutations or unlock unsupported legacy requests. Preserve existing capture-history validation and observation-free sandbox references. Packed old-hook fixtures cover both nonempty rejection before invocation and continued mount-free operation.

## First implementation PR brief

**Deliver:** the common array migration, scoped SDK validation, Daytona native-ID cold restore mounts, direct partial outcomes, accurate public docs and compiled mock examples in one bounded SDK/adapter PR. Reuse current create/restore drivers and qualification suites. The default supported mounted-restore policy is explicitly configured `daytona-default`; add `blocked` only if the documented gate above is satisfied. Unsupported combinations reject without allocation. The approved design is ready for delegation; this spec review itself changes no runtime code and allocates no resources.

**Offline acceptance:** omitted/empty mount-free behavior and the migration window; matching/wrong/missing hook marker; full-reference fresh-client restore after source deletion using existing history; exact volume/subpath mapping; wrong scope/provider/access/overlap rejection before POST; unknown or conflicting provenance; unchanged sandbox references with current mounts from native inspection; complete-set mismatch/read failure retaining acknowledged compute/volumes; lost acknowledgement without replay; and cleanup that retains application volumes. Keep the known-native-mount versus arbitrary guest-mount distinction explicit. Mock fixtures assert native requests, identities and mutation counts, not only display strings.

**Ready to merge the implementation:** relevant repository/packed/docs gates pass; compiled examples exercise the exported API; independent correctness/DX review is clear; the bounded live scenario above has a recorded result for the supported policy, exact image/configuration/revision and confirmed cleanup. A failed or not-run startup check does not become a support claim. Report any remaining stricter-policy gate as unsupported rather than silently changing the requested policy. No optional mounted capture, universal storage guarantees or additional provider work is required to complete this first PR.
