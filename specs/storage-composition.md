# Storage composition

Proposal · revised October 2, 2026 against Sandbar `52a95be` · native evidence inspected October 1 · no runtime changes

## Recommendation

Use **`mounts: MountSpec[]` on both create and restore**, with the existing `volume.at(path)` helper. One descriptor selects storage for the workload; there is no second `attach` input or sharing permission flag. Start with **Daytona mount-free filesystem snapshot restore plus caller-selected volumes**: reusable private code/configuration state alongside independently retained application data. This does **not** capture and restore an already mounted workspace; that second workflow needs native exclusion/provenance evidence.

For a mount-free snapshot, omitted `mounts` means no mounts. Supplying the same volume deliberately shares its current mutable data; selecting a separately created volume gives separate data. Neither choice pins captured-time bytes or copies data. Never create storage implicitly, substitute a missing volume or silently discard recorded mounts. Existing mounted-source and memory-plus-storage restore remain unsupported in the first slice.

The migration decision is concrete: replace the exposed but currently unsupported restore action-map with the common array input in the next coordinated SDK/adapter API change. Give old action-map callers an actionable migration error, preserve compatible mount-free calls and saved references, and review release/versioning implications before implementation. Do not retain two permanent APIs to avoid migrating an inactive extension point.

Daytona's existing native create path accepts snapshot identity, volume IDs and network policy together. This is enough to begin scoped mapping/fixture work, not enough to claim startup safety. **Release requires evidence that mounts and policy apply before application startup**, including image entrypoints. A post-create read cannot prove that order. Missing evidence blocks this mapping; optional stronger storage guarantees do not.

Storage implementation is **fourth**, after active [suspend/resume](sandbox-lifecycle.md), [default creation/everyday files](sandbox-basics-dx.md), and [preview/process basics](preview-and-process-control.md). Research may continue now; it does not change the [roadmap](../ROADMAP.md) or authorize implementation. This proposal supplements [state portability](provider-state-portability.md) and [ordinary recovery DX](sdk-recovery-dx.md).

## Mocked application walkthrough

These are **proposed, uncompiled examples with deterministic mock responses**, not live-provider instructions or a new exported mock API. Restore currently rejects nonempty mounts and exposes the legacy action-map shape. The examples also use creation defaults and text helpers from the earlier [everyday DX proposal](sandbox-basics-dx.md). Implementation must turn these scenarios into compiled public examples backed by native-boundary fixtures.

The mock represents a qualified filesystem/fresh-execution adapter. It supplies a caller-provisioned `report-worker-v1` image, a ready mount-free snapshot, ready ID-addressable volumes and support for the requested network policy. Its simulated startup installs mounts and policy before the image entrypoint. These fixture assumptions do not establish Daytona's native startup order, capture exclusions or shutdown durability; those remain the release gates below. IDs such as `snapshot-001` and `volume-001` are mock responses, never IDs applications construct.

### 1. Configure once, create data and capture private state

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

function openClient() {
  return Sandbar.connect(daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    target: "us",
    environment: Image.prepared("report-worker-v1"), // proposed setup default
  }));
}

const client = await openClient();
const data = await client.volumes.create({ name: "customer-data" });
const writer = await client.sandboxes.create({
  mounts: [data.at("/data")],
});
await writer.writeTextFile("/data/report.json", '{"total":7}', {
  overwrite: true, // Daytona mounted writes require this choice.
});

// Capture private application state from a separate, mount-free sandbox.
const base = await client.sandboxes.create();
await base.writeTextFile("/tmp/app-version.txt", "v1");
const captured = await base.snapshot();
```

Mock observations: `data.id === "volume-001"`; capture returns `snapshot-001`, filesystem preservation and fresh restore execution. The snapshot contains `/tmp/app-version.txt`; it does not contain the writer's `/data/report.json`. `data.at("/data")` constructs a descriptor without a provider call. Snapshotting `writer` remains unsupported in slice 1.

The same descriptor vocabulary works for both operations:

```ts
const mount = data.at("/data");
const created = await client.sandboxes.create({ mounts: [mount] });
const restored = await captured.snapshot.restore({
  networkPolicy: "blocked",
  mounts: [mount],
});
console.log(await restored.readTextFile("/tmp/app-version.txt")); // "v1"
console.log(await restored.readTextFile("/data/report.json"));    // '{"total":7}'
```

Mock observations: `created` starts from the configured image; `restored` starts from `snapshot-001`. Both select exactly `volume-001`. Selecting that volume deliberately shares its current mutable data with the writer and other users. A snapshot does not freeze those bytes. The mock establishes the expected mapping, not portable concurrent-writer or flush guarantees. `blocked` requires Daytona account policy eligibility; if unavailable it rejects before creation. An application that accepts provider-managed egress configures and selects `daytona-default` explicitly.

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
  networkPolicy: "blocked",
  mounts: [selectedData.at("/data")],
});
```

Mock observations: reopening inspects the saved snapshot and volume identities in the configured scope; restoration selects `snapshot-001` and `volume-001` even though `base` was destroyed. It needs neither the original handles nor the old API key. Production applications replace `records` with durable storage and retain the returned handles/references if saving fails. The map only demonstrates the JSON boundary; it does not survive a process restart. No resource is discovered or recreated by name.

### 3. Choose shared data, empty independent data or private state only

```ts
const experimentData = await freshClient.volumes.create({ name: "experiment-data" });
const experiment = await snapshot.restore({
  networkPolicy: "blocked",
  mounts: [experimentData.at("/data")],
});
const privateOnly = await snapshot.restore({ networkPolicy: "blocked" });
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
    networkPolicy: "blocked",
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

The configured cleanup policy can supply the repeated compute choice. `allow-unconfirmed` accepts unconfirmed shutdown durability; it is not a flush promise. Storage and snapshots remain retained until separately deleted, with provider-specific retention costs; the production Daytona volume documentation currently lists volumes as included at no additional cost. Never infer that retained compute/snapshots or other providers' storage are free.

## Public and adapter shape

Retain `Volume.at(path, { access, subpath })`, ordinary snapshot results, scoped resource managers, and `snapshot.restore()`. Change only the restore mount input; no new volume mutation or recovery operation:

```ts
// Proposed SDK and sandbar-adapter schema change; other fields retained.
interface RestoreRequest {
  networkPolicy: string;
  mounts?: MountSpec[];
  resources?: { vcpu?: number; memoryMiB?: number; diskMiB?: number };
  requireIndependentLifecycle?: boolean;
}
// Existing RestoreCapabilities / SnapshotInfo.restore.mounts: boolean
// means this adapter implements the selected mount workflow, subject to
// snapshot provenance and native constraints. False still rejects mounts.
// Proposed optional marker on the existing adapter hook:
// snapshotRestore.mountInput?: "specs"
// snapshotRestore.prepare/submit({ snapshot, request }, context)
// snapshotRestore.observe(attempt, context)
```

Keep the existing `restore.mounts` support field; callers do not negotiate capabilities. The hook marker below is an internal SDK/adapter compatibility check, not a workload option. True alone never authorizes arbitrary snapshot/mount combinations: SDK/adapter validation still checks actual capture scope and execution. An old adapter cannot be assumed to accept arrays merely because it advertises the earlier action-map support. Coordinate the adapter contract migration described below.

Slice 1 requires positively known `preserve: "filesystem"`, `restoreExecution: "fresh"`, no recorded mounts and `mountHandling: "none"`. Unknown provenance rejects. Validate every selected volume reference against the configured provider, authority and routing scope; inspect readiness; reject read-only, overlapping paths, unsupported subpaths/access/classes and incompatible requirements before dispatch. The selected Daytona mapping uses exact native volume IDs. Revalidate at submission; preparation is not a reservation. Meaningful provider mechanics/defaults stay in typed setup; selected volume identities and sharing intent stay in the workload call.

Reuse Daytona `checkMounts` and the create driver: `POST /sandbox` with exact snapshot ID, `volumes: [{ volumeId, mountPath, subpath }]` and `networkBlockAll`. Confirm actual snapshot identity and the complete expected mount set before success. Preserve mounts in the resulting sandbox reference and saved recovery input for reopening, cleanup and read-only observation. Do not restore memory, attach after creation or accept a substitute on failed lookup. Native boot-order proof is separate from serialization/fixture correctness.

## Mounted capture and recorded mounts: useful, deferred

A filesystem-only capture excluding external volume bytes is useful for retaining code plus a list of data connections. Daytona containers would be the natural extension of the current implementation, but pinned source only says filesystem capture; it does not prove FUSE mount exclusion. Daytona's alternate v2 documentation explicitly excludes **VM** volumes; that cannot qualify this container mapping. Do not enable mounted capture merely by changing `mountHandling` to `excluded`.

A later mounted capture should return the actual exclusion scope, captured private state and full mount descriptors (`volume` reference, absolute path, access, subpath). Descriptors are external references, not a volume snapshot/version or evidence of flushed data. Record whether the native artifact itself retains mount declarations; current inspected container evidence leaves this unknown. Never label included bytes or an unverified scope as excluded. Underlying private bytes at mountpoints also need fixture/native evidence before promising their contents.

The same array should later select live storage for every recorded mount path. For example, `mounts: [originalData.at("/data")]` explicitly reuses/shares that data; `mounts: [replacementData.at("/data")]` replaces it. No additional `share`/`replace` action map is needed.

**Every recorded path needs a supplied descriptor.** A missing descriptor rejects before effects, including omitted input and `[]`; it never means omission. Native validation determines whether access/subpath replacements are supported. New mount paths are allowed only when the adapter can enforce them before startup; overlap rejects. Returning a recorded descriptor in inspect metadata is useful, but the caller must deliberately select it for restore. Reuse means current mutable data, not captured-time bytes.

Explicit omission remains deferred: it may expose an underlying captured directory and cause application writes to land on private disk. A later implementation must establish and document exactly which directory becomes visible before startup; an unexplained empty-directory assumption is insufficient. No silent masking or directory clearing. Memory restoration with changed, shared or omitted external storage remains unsupported until native compatibility and pre-execution ordering are established; quiescing writers alone cannot prove compatibility with captured process caches/open handles. Copy/version/fork remains a separate explicit operation, not a mount selection.

| Default alternative | Assessment |
| --- | --- |
| Automatically reuse recorded volumes | Convenient restart, but a restore may unexpectedly expose shared live mutable data; reject as default |
| Automatically clone or omit | Invents independent bytes or loses intended data access; extra resources/costs or directory exposure; reject |
| Require choices only for recorded mounts | Recommended; mount-free restore stays simple, explicit attachment needs no separate sharing flag |

## Identity, observations and failures

Persist exact existing resource references: version/kind, provider, native ID, immutable generation where required, and verified native authority/partition. E2B's snapshot reference needs the captured build generation as well as containing template identity; a current default/tag lookup is insufficient. A volume name may be a native selector; do not present it as immutable identity without evidence of lifetime/generation and binding behavior. Preserve existing history/deletion safeguards for compatibility; assess them before any schema removal.

Slice 1 adds no composite manifest: applications save the snapshot and chosen volumes separately, then reopen through the current verified connection. Snapshot reopening must remain source-independent where supported after original compute deletion. A future mounted-capture descriptor can live in snapshot metadata once; do not duplicate it in accumulated journals. Historical application-saved mount/capture observations cannot authorize use/deletion or be presented as fresh state. If reopening cannot verify the facts necessary for safe restore, return unavailable/unsupported rather than trusting edited JSON to unlock it.

| Outcome | Preserve and next useful action |
| --- | --- |
| Volume created; later compute create/restore rejects | Return/retain the already received volume reference; caller can reuse or explicitly delete it. No composite helper hides that success |
| Native compute acknowledged; mount/detail verification fails | Ordinary unknown/partial error retains confirmed scoped compute ID/reference and selected volume identities. Inspect that exact compute; never blind retry creation or auto-delete shared storage |
| Capture completes; source restart fails | Existing partial capture result keeps snapshot reference and actual source/restart evidence; use the snapshot or address the source separately |
| Response lost after dispatch | Existing unknown result retains every received ID/native operation selector; read-only observation may reconcile, absence from list does not prove no effect |
| Compute deletion uncertain or snapshot/volume deletion conflicts | Preserve confirmed prior deletions, retained identities and ownership; inspect dependency/use state and explicitly retry only when safe under existing deletion rules |

The first restore PR must extend the existing ordinary error outcome union only as needed to expose acknowledged compute and its selected volumes directly; recovery tokens alone are not the public handoff. No new recovery engine, automatic compensation, persistence callback or deletion cascade. Never convert known allocation into “nothing created” because metadata assembly failed. Reopening cannot promise recovery across the application's allocation-to-save crash window.

Visibility and durability remain distinct. Current Daytona mapping reports immediate visibility and last-writer-wins with durability/locking/rename unknown; validate its visibility assertion against the deployed backend before reusing it as stronger acceptance evidence. Production FUSE documentation does not prove cross-writer atomicity or durable shutdown. E2B beta limitations forbid treating locks or permission bits as isolation. Modal's native commit/reload model is a real provider-specific boundary, but its Sandbar adapter implements neither volumes nor snapshots. Do not add universal `flush`, locking, rename or checkpoint APIs for this slice. Read-only must mean native enforcement, never an SDK convention.

## Provider evidence and limits

Inspected October 1, 2026. These are docs/source observations, no paid/live calls or account probes. Sandbar source/fixtures were initially inspected at `0c39ca3`; guidance was reconciled against `52a95be` on October 2; historical account/evidence status remains in the [support table](../apps/docs/src/content/docs/docs/providers/support.md).

| Provider | Native evidence | Implemented Sandbar / proposed use |
| --- | --- | --- |
| Daytona production v0.220 docs; pinned published SDK/API baseline v0.218.0 | Snapshot plus ID-based create-time volumes and policy; SDK forwards both in one create request. Container capture API takes `{ name }`, gives no mounted-byte scope proof. FUSE storage persists separately; [deletion returns 409 while active mounts remain](https://www.daytona.io/docs/en/volumes/#delete-volumes) | Volumes and read-write/subpath creation implemented, mounted capture/restore rejected. First slice adds explicit attachments to mount-free container cold restore; startup proof required |
| E2B `e2b@2.51.0` | Create serializes volume objects as `{ name, path }`, discarding object ID. Snapshot capture contains filesystem+memory. Volume private beta has no volume snapshots/server-side copies/read-only mounts; resume retains original mounts | Volume management mapped, account qualification blocked by recorded HTTP 403; mounts independently unsupported: current mapping has no exact mounted-ID evidence. Name-based selection is unqualified for the promised exact-resource workflow, not inherently impossible |
| Tensorlake `tensorlake@0.5.136`; [research #45](https://github.com/pandemicsyn/sandbar/issues/45) | Native filesystem/cold and memory/warm snapshots; create options contain snapshot ID and filesystem mounts. Live mounts and permanent-snapshot read-only pins are distinct. `fileSystemId` is the filesystem name, not demonstrated immutable generation identity | No Sandbar adapter. Basic create/restore mount vocabulary fits conceptually, but combined restore behavior, pre-entrypoint ordering, mounted capture scope and name-reuse protection require qualification. Version/fork APIs stay deferred |
| Modal `modal@0.10.1` | Native sandbox API exposes volume mounts and filesystem snapshots; volume commit/reload governs visibility, concurrent modification requires application coordination | Current adapter exposes neither snapshots nor volume management/mounts. Native surface is a design cross-check, not implemented support or authorization for a new mapping |

Primary sources and exact inspected artifacts:

- Daytona [production snapshots](https://www.daytona.io/docs/en/snapshots/), [volumes](https://www.daytona.io/docs/en/volumes/), [OpenAPI](https://www.daytona.io/docs/openapi.json); pinned [SDK 0.218.0 tarball](https://registry.npmjs.org/@daytona/sdk/-/sdk-0.218.0.tgz), `cjs/Daytona.js` create body and `cjs/Sandbox.js:createSnapshot`; API baseline described in [adapter README](../packages/providers/daytona/README.md). Client source establishes request shape, not server boot ordering or byte exclusion.
- Daytona [alternate v2 volume docs](https://daytona-website-website-prod.daytona.workers.dev/docs/en/volumes): different `/vms`, project scope, disk/bucket types and commit behavior. Do not mix this contract with production `/sandbox`, organization-scoped FUSE mapping; upgrading it is separate provider work.
- E2B [mounting](https://docs.e2b.dev/volumes/mount), [beta access](https://docs.e2b.dev/volumes), [beta limitations](https://docs.e2b.dev/faq/volumes-beta-limitations), [sandbox snapshots](https://docs.e2b.dev/sandbox/snapshots); pinned [2.51.0 tarball](https://registry.npmjs.org/e2b/-/e2b-2.51.0.tgz), `dist/index.mjs:SandboxApi.createSandbox` and `createSnapshot`. No inference that sandbox snapshots support mounted memory composition from volume-snapshot limitations.
- Modal [volume guide](https://modal.com/docs/guide/volumes), pinned [0.10.1 tarball](https://registry.npmjs.org/modal/-/modal-0.10.1.tgz), `dist/index.d.ts:SandboxCreateParams` and `Sandbox.snapshotFilesystem`; [adapter source](../packages/providers/modal/src/index.ts). Vercel and Tensorlake implementation remain behind the usability gate.

## Name-based selection and Tensorlake cross-check

[Issue #45](https://github.com/pandemicsyn/sandbar/issues/45) is the research home; this is only its consequence for SDK design. Rechecked October 1 against [snapshot docs](https://docs.tensorlake.ai/sandboxes/snapshots), [mount docs](https://docs.tensorlake.ai/sandboxes/mount-filesystems), [create API](https://docs.tensorlake.ai/api-reference/v2/sandboxes/create), and published [SDK 0.5.136](https://registry.npmjs.org/tensorlake/-/tensorlake-0.5.136.tgz), `dist/index.d.ts:CreateSandboxOptions/FileSystemMount` and `dist/index.js:fileSystemMountToWire`. Snapshot ID and mounts coexist in the native create schema; this supports the design shape, not proof that all combinations work. Filesystem snapshots cold-boot; memory snapshots fix image/resources/entrypoint. Mount readiness before reporting running does not alone prove readiness before an image entrypoint.

Tensorlake exposes three materially different selections: current live filesystem, immutable read-only filesystem version, and a separately forked writable filesystem. Keep them distinct. Ordinary `volume.at(path)` can represent the first; a future version handle can compose through the same mount descriptor once qualified. A pin is not a writable clone, and a sandbox snapshot must not be assumed to pin mounted data automatically. Do not add version/fork operations to the first Daytona PR merely to exercise future extension points.

E2B SDK 2.51.0 serializes even a `Volume` object by `name`; Tensorlake SDK 0.5.136 documents `fileSystemId` as the caller-created filesystem name. These are exact client-side observations, not proof of server-side substitution behavior. Investigate whether names are nonreusable during the reference lifetime, whether an immutable generation is observable/selectable, or whether native creation conditionally binds the intended generation before execution. A provider can implement exact reopening through a name if its native contract establishes that binding.

Practical limit: lookup-then-create plus checking identity after startup cannot by itself prevent transient use of replacement data. If a provider only supports selecting the current resource at a name, state that live namespace semantics explicitly and review whether it meets the workload contract; do not advertise saved exact-artifact reopening or silently degrade to it. Application discipline against concurrent deletion/recreation can be a documented operational constraint, not an atomic SDK guarantee. Read-only pins preserve a data version but do not by themselves prove filesystem namespace identity or authorization across recreation.

For Tensorlake, combined restore behavior, startup ordering, sandbox snapshot mounted-byte scope and retained declarations remain unverified by the inspected cross-check. The common vocabulary fits; exact-resource and supported-combination claims await evidence. Issue #45 owns broader provider investigation. Do not turn these questions into prerequisites for the Daytona ID-based slice or permission for a Tensorlake adapter.

## Delivery and decisions

Two bounded candidates, scheduled only after the earlier roadmap work. Native evidence can be investigated now; no storage coding is authorized by this spec.

1. **Daytona cold restore with explicitly selected mounts** — medium complexity. Coordinate the mount-input migration, SDK validation, existing native create mapping, direct partial outcomes, docs and compiled versions of the mocked walkthrough above. Each fixture asserts native requests, resulting identities, retained resources and mutation counts, not just returned strings. Tests: omitted/empty mount-free restore unchanged; one exact mount/subpath; restore after source deletion through fresh connection; wrong scope/provider/read-only/overlap rejected before POST; mount mismatch/read failure preserves acknowledged compute/volumes; lost response never replayed; cleanup retains volumes and respects policy. Native gate: mounts/network before image entrypoint. Maintain a live acceptance scenario as not-run until separately authorized. Cuts: mounted capture, sizing, detach, copy, versions and memory composition. No dependency on stronger flush/locking/rename guarantees.
2. **Daytona mounted filesystem capture with explicit storage selection** — conditional medium-to-large complexity, depends on PR 1 and precise container/FUSE exclusion/provenance evidence. Use the same array to require each recorded path; test private bytes captured, external bytes not frozen, mount declarations/identities retained, safe serialized reopen after source deletion, missing paths/replaced IDs rejected, and restart failure retaining snapshot. Missing native scope/order evidence defers this PR. Cuts: omission, memory, copy/version/fork and mounted suspension. This is optional for the usability gate, not a mandatory universal-storage milestone.

## Compatibility and migration decision

Recommend changing `RestoreRequest.mounts` from the inactive action-map to `MountSpec[]` in a coordinated SDK/adapter release. Preserve omitted input; retain the existing empty-object spelling as a deprecated SDK-only mount-free alias normalized to `[]` for one migration window. New documentation/types teach arrays. Nonempty legacy action maps currently fail unsupported; continue failing before effects with a specific migration message instead of reinterpreting `share`, `replace` or `omit`. Once the alias is removed, invalid input uses the existing `INVALID_ARGUMENT` convention. No `attach` alternative.

This is a public schema/type change even though no mapped workflow accepts nonempty action maps today. Review third-party adapters and release/version policy before committing to the migration window. Before passing nonempty arrays to an adapter, the SDK requires `snapshotRestore.mountInput: "specs"` on that operation hook. A missing marker rejects before prepare/submit with upgrade guidance; the old capability boolean is insufficient. Mount-free requests keep their existing path, omitting the mount field when addressing an older hook. This one optional operation marker preserves older adapters for supported mount-free work; it adds no top-level version framework or caller negotiation. A packed old-hook fixture must prove rejection before any adapter mutation, even if the old hook advertises mount support.

Do not alter saved snapshot/volume/sandbox identity formats. Preserve parsing/read-only observation of already saved legacy operation references; normalization must not replay a mutation or convert unsupported old mount requests into new authority. Add regression fixtures for that migration. Mount-free restore, deletion/cleanup and retention keep their current behavior. The user's final approval covers naming and the intentional migration, not automatic implementation.

Real decisions for user review:

- **Product / migration:** accept the common array recommendation and SDK-only empty-object transition, and choose its release window after checking third-party adapter compatibility?
- **Validation gate:** can Daytona production cold-container startup order be established? If not, defer PR 1 despite valid create request shape.
- **Feasibility:** does the selected production container snapshot exclude FUSE bytes and retain usable mount provenance after source deletion? If not established, defer PR 2 and keep mounted capture unsupported.

Suspend/resume remains owned by its lifecycle task and excludes mounted sources. E2B resume retains original mounts and deleting a mounted volume may prevent resume; different external data can invalidate captured process assumptions. Daytona alternate disk-volume pause limits do not establish production FUSE behavior. Research these implications when a concrete mounted-lifecycle workflow is selected; do not expand the active slice here.
