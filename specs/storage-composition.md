# Storage composition

Proposal · October 1, 2026 · inspected Sandbar `0c39ca3` · no runtime changes

## Recommendation

Start with **Daytona filesystem snapshot restore plus caller-selected volumes**. Keep `volume.at(path)` and let callers explicitly select storage on restore. Prefer the same mount vocabulary as creation; the additive `attach` spelling below is a compatibility candidate pending the migration decision. This composes a reusable private code/configuration checkpoint with independently retained application data. It does **not** capture and restore an already mounted workspace. That useful second workflow needs native exclusion and startup evidence which the pinned container sources do not establish.

A supplied volume is a deliberate selection of live mutable storage. Omitted `attach` means no new attachments; it never selects saved volumes, creates billed resources, copies data or discards a recorded mount. Existing mounted-source and memory-plus-storage restores stay unsupported. The first slice uses one actual adapter and its existing ID-based create-time mount path; changing adapters remains concentrated in connection setup where support exists. There is no promise of provider parity or cross-provider backups.

Native feasibility is backed by Daytona's create request accepting snapshot identity, volume IDs and network policy together. **Release requires evidence that mounts and policy apply before application startup**, including image entrypoints. A read after creation cannot prove this order. If that evidence cannot be established, defer the slice rather than weaken its guarantee.

**Ergonomics under review:** `attach` below is the additive compatibility candidate, not an accepted final name. The preferred everyday target is the same `mounts: MountSpec[]` input on create and restore. The shipped restore action-map is currently unsupported everywhere; implementation must assess migration/deprecation of that shape rather than let it permanently dictate a second everyday noun. Do not silently reinterpret old action-map inputs. Recorded-mount safety still requires explicit intent regardless of the chosen spelling.

This proposal supplements [state portability](provider-state-portability.md) and [ordinary recovery DX](sdk-recovery-dx.md); it does not change the active [suspend/resume slice](sandbox-lifecycle.md).

## Everyday workflows

All snippets below are proposed usage, not compiled examples against exported APIs. `attach` does not exist today. The existing calls and helper vocabulary are retained; implementation must add compiled public examples.

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

const client = await Sandbar.connect(daytona({
  apiKey: process.env.DAYTONA_API_KEY!,
  target: "us",
}));

// Existing: independent mutable data, then compute using it.
const data = await client.volumes.create({ name: "customer-data" });
const box = await client.sandboxes.create({
  environment: Image.prepared("daytona-small"),
  mounts: [data.at("/data")],
});
// data persists after compute deletion; snapshot(box) is unsupported today.
```

Before this proposal, restore rejects every nonempty mount choice. After the first slice:

```ts
// Build/checkpoint code on private disk, before attaching external data.
const base = await client.sandboxes.create({
  environment: Image.prepared("daytona-small"),
});
// Install/configure the application on private disk here.
const captured = await base.snapshot();
await database.save({
  snapshot: captured.snapshot.reference,
  data: data.reference,
});

// Fresh process, same verified adapter binding and current credentials.
const snapshot = await freshClient.snapshots.get(saved.snapshot);
const selectedData = await freshClient.volumes.get(saved.data);
const restored = await snapshot.restore({
  networkPolicy: "blocked",
  attach: [selectedData.at("/data")],
});
// Run the application only after restore returns.
// blocked requires Daytona account policy eligibility; unsupported rejects
// before creation. Select daytona-default explicitly when that policy fits.
```

Selecting `selectedData` again deliberately shares its current bytes with any other users of that volume. The snapshot does not pin those bytes. To begin with empty independent data, create and save a separate volume first:

```ts
const experimentData = await client.volumes.create({ name: "experiment-data" });
const experiment = await captured.snapshot.restore({
  networkPolicy: "blocked",
  attach: [experimentData.at("/data")],
});
```

This is an independent **empty** data workspace, not a copy of the original. A restore with no attachments branches private filesystem state only. An independent fork including existing volume bytes requires a separately specified native copy/version operation; no automatic recursive copy, implicit volume creation or portable `fork()` is proposed. Copying between mounted volumes under application control does not establish atomicity, point-in-time consistency or clone independence.

Attachment hides any private snapshot directory at that path; it does not erase its underlying bytes. Do not teach omission as rollback or data deletion. Deleting compute, snapshot and volume are separate decisions:

```ts
await restored.destroy({ storage: "allow-unconfirmed" });
await captured.snapshot.delete();
// Delete selectedData only when the application decides it owns the data,
// has saved what it needs, and other users/dependencies no longer need it.
```

The existing configured cleanup policy can supply that compute choice. `allow-unconfirmed` accepts unconfirmed shutdown durability; it is not a flush promise. Storage and snapshots remain retained until separately deleted, with provider-specific retention costs; the production Daytona volume documentation currently lists volumes as included at no additional cost. Never infer that retained compute/snapshots or other providers' storage are free.

## Public and adapter shape: additive candidate

Retain current create `mounts: MountSpec[]`, `Volume.at(path, { access, subpath })`, ordinary snapshot result and resource managers. For the additive candidate, add only:

```ts
// Proposed additive fields in sandbar-adapter's executable schemas,
// re-exported as public SDK types.
interface RestoreRequest {
  networkPolicy: string; // existing required policy
  attach?: MountSpec[];  // new create-time attachments; default []
  // Existing resources, requireIndependentLifecycle and mounts remain.
}
interface RestoreCapabilities {
  attach: boolean; // new; false for adapters that do not implement this slice
  // Existing mounts remains support for recorded-mount dispositions.
}
// SnapshotInfo.restore carries the same additive attach evidence.
// Existing adapter mutation hook, no separate attach operation:
// snapshotRestore.prepare/submit({ snapshot, request }, context)
// snapshotRestore.observe(attempt, context)
```

Default the additive capability field to `false` when decoding older adapter responses. Ordinary callers invoke restore directly and get an actionable unsupported error; capability lookup is optional, not ceremony. `attach` is intentional parallel vocabulary to create-time `mounts`, avoiding immediate migration of the shipped `RestoreRequest.mounts` action map. Keep adapter mechanics inside setup and mapping; volume identity and deliberate sharing are workload choices per call. No adapter-configured default volume identity.

For slice 1 the snapshot must positively have `preserve: "filesystem"`, `restoreExecution: "fresh"`, no recorded mounts and `mountHandling: "none"`. Unknown provenance never passes. Validate every selected reference against the configured provider, authority and routing scope; inspect exact volume ID readiness; reject read-only, overlapping paths, unsupported subpaths/access/classes and incompatible requirements before dispatch. Do not select volumes by reusable names. Repeat relevant checks at submission; prepare is not a reservation.

Daytona mapping reuses `checkMounts` and the create driver: `POST /sandbox` with exact snapshot ID, `volumes: [{ volumeId, mountPath, subpath }]` and `networkBlockAll`. Confirm the actual snapshot identity plus the complete expected mount set, not merely one matching subset, before success. Preserve mounts in the resulting sandbox reference and in saved recovery input so fresh-process inspection/cleanup and read-only observation know the selected storage. Do not restore memory, mount after creation or accept a substitute volume if lookup fails. Native boot-order proof is a release gate, separate from request serialization and fixture tests.

## Mounted capture and recorded mounts: useful, deferred

A filesystem-only capture excluding external volume bytes is useful for retaining code plus a list of data connections. Daytona containers would be the natural extension of the current implementation, but pinned source only says filesystem capture; it does not prove FUSE mount exclusion. Daytona's alternate v2 documentation explicitly excludes **VM** volumes; that cannot qualify this container mapping. Do not enable mounted capture merely by changing `mountHandling` to `excluded`.

A later mounted capture should return the actual exclusion scope, captured private state and full mount descriptors (`volume` reference, absolute path, access, subpath). Descriptors are external references, not a volume snapshot/version or evidence of flushed data. Record whether the native artifact itself retains mount declarations; current inspected container evidence leaves this unknown. Never label included bytes or an unverified scope as excluded. Underlying private bytes at mountpoints also need fixture/native evidence before promising their contents.

Retain the shipped minimal action-map for that later slice, keyed by the recorded absolute mount path:

```ts
type RecordedMountChoice =
  | { action: "share" } // same exact volume, path, access and subpath
  | { action: "replace"; mount: MountSpec }
  | { action: "omit" };
// snapshot.restore({ networkPolicy: "blocked", mounts: {
//   "/data": { action: "share" },
// } });
```

**No automatic recorded-mount disposition.** Every recorded mount requires an explicit choice, matching the accepted storage follow-up. Unknown keys reject; missing keys reject before effects. Replacement must retain the recorded path; a different volume/subpath/access is deliberate intent. Under the additive candidate, new paths use `attach`; overlap between the two inputs rejects. Reusing a current volume means sharing its mutable contents, not restoring its captured-time data.

Do not release `omit` initially: it may expose an underlying captured directory and cause application writes to land on private disk. A later implementation must establish and document exactly which directory becomes visible before startup; an unexplained empty-directory assumption is insufficient. No silent masking or directory clearing. Memory restoration with changed, shared or omitted external storage remains unsupported until native compatibility and pre-execution ordering are established; quiescing writers alone cannot prove compatibility with captured process caches/open handles. Copy/version/fork remains a separate explicit operation, not another restore action.

| Default alternative | Assessment |
| --- | --- |
| Automatically reuse recorded volumes | Convenient restart, but a restore may unexpectedly expose shared live mutable data; reject as default |
| Automatically clone or omit | Invents independent bytes or loses intended data access; extra resources/costs or directory exposure; reject |
| Require choices only for recorded mounts | Recommended; mount-free restore stays simple, explicit attachment needs no separate sharing flag |

## Identity, observations and failures

Persist exact existing resource references: version/kind, provider, native ID, immutable generation where required, and verified native authority/partition. E2B's snapshot reference needs the captured build generation as well as containing template identity; a current default/tag lookup is insufficient. A volume name is a display/lookup aid, not exact identity. Preserve existing history/deletion safeguards for compatibility; assess them before any schema removal.

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

Inspected October 1, 2026. These are docs/source observations, no paid/live calls or account probes. Sandbar source/fixtures are at `0c39ca3`; historical account/evidence status remains in the [support table](../apps/docs/src/content/docs/docs/providers/support.md).

| Provider | Native evidence | Implemented Sandbar / proposed use |
| --- | --- | --- |
| Daytona production v0.220 docs; pinned published SDK/API baseline v0.218.0 | Snapshot plus ID-based create-time volumes and policy; SDK forwards both in one create request. Container capture API takes `{ name }`, gives no mounted-byte scope proof. FUSE storage persists separately; [deletion returns 409 while active mounts remain](https://www.daytona.io/docs/en/volumes/#delete-volumes) | Volumes and read-write/subpath creation implemented, mounted capture/restore rejected. First slice adds explicit attachments to mount-free container cold restore; startup proof required |
| E2B `e2b@2.51.0` | Create serializes volume objects as `{ name, path }`, discarding object ID. Snapshot capture contains filesystem+memory. Volume private beta has no volume snapshots/server-side copies/read-only mounts; resume retains original mounts | Volume management mapped, account qualification blocked by recorded HTTP 403; mounts independently unsupported due exact-ID gap. No mounted capture/restore proposal for this adapter |
| Tensorlake `tensorlake@0.5.136`; [research #45](https://github.com/pandemicsyn/sandbar/issues/45) | Native filesystem/cold and memory/warm snapshots; create options contain snapshot ID and filesystem mounts. Live mounts and permanent-snapshot read-only pins are distinct. `fileSystemId` is the filesystem name, not demonstrated immutable generation identity | No Sandbar adapter. Basic create/restore mount vocabulary fits conceptually, but combined restore behavior, pre-entrypoint ordering, mounted capture scope and name-reuse protection require qualification. Version/fork APIs stay deferred |
| Modal `modal@0.10.1` | Native sandbox API exposes volume mounts and filesystem snapshots; volume commit/reload governs visibility, concurrent modification requires application coordination | Current adapter exposes neither snapshots nor volume management/mounts. Native surface is a design cross-check, not implemented support or authorization for a new mapping |

Primary sources and exact inspected artifacts:

- Daytona [production snapshots](https://www.daytona.io/docs/en/snapshots/), [volumes](https://www.daytona.io/docs/en/volumes/), [OpenAPI](https://www.daytona.io/docs/openapi.json); pinned [SDK 0.218.0 tarball](https://registry.npmjs.org/@daytona/sdk/-/sdk-0.218.0.tgz), `cjs/Daytona.js` create body and `cjs/Sandbox.js:createSnapshot`; API baseline described in [adapter README](../packages/providers/daytona/README.md). Client source establishes request shape, not server boot ordering or byte exclusion.
- Daytona [alternate v2 volume docs](https://daytona-website-website-prod.daytona.workers.dev/docs/en/volumes): different `/vms`, project scope, disk/bucket types and commit behavior. Do not mix this contract with production `/sandbox`, organization-scoped FUSE mapping; upgrading it is separate provider work.
- E2B [mounting](https://docs.e2b.dev/volumes/mount), [beta access](https://docs.e2b.dev/volumes), [beta limitations](https://docs.e2b.dev/faq/volumes-beta-limitations), [sandbox snapshots](https://docs.e2b.dev/sandbox/snapshots); pinned [2.51.0 tarball](https://registry.npmjs.org/e2b/-/e2b-2.51.0.tgz), `dist/index.mjs:SandboxApi.createSandbox` and `createSnapshot`. No inference that sandbox snapshots support mounted memory composition from volume-snapshot limitations.
- Modal [volume guide](https://modal.com/docs/guide/volumes), pinned [0.10.1 tarball](https://registry.npmjs.org/modal/-/modal-0.10.1.tgz), `dist/index.d.ts:SandboxCreateParams` and `Sandbox.snapshotFilesystem`; [adapter source](../packages/providers/modal/src/index.ts). Vercel and Tensorlake implementation remain behind the usability gate.

## Tensorlake cross-check

[Issue #45](https://github.com/pandemicsyn/sandbar/issues/45) is the research home; this is only its consequence for SDK design. Rechecked October 1 against [snapshot docs](https://docs.tensorlake.ai/sandboxes/snapshots), [mount docs](https://docs.tensorlake.ai/sandboxes/mount-filesystems), [create API](https://docs.tensorlake.ai/api-reference/v2/sandboxes/create), and published [SDK 0.5.136](https://registry.npmjs.org/tensorlake/-/tensorlake-0.5.136.tgz), `dist/index.d.ts:CreateSandboxOptions/FileSystemMount` and `dist/index.js:fileSystemMountToWire`. Snapshot ID and mounts coexist in the native create schema; this supports the design shape, not proof that all combinations work. Filesystem snapshots cold-boot; memory snapshots fix image/resources/entrypoint. Mount readiness before reporting running does not alone prove readiness before an image entrypoint.

Tensorlake exposes three materially different selections: current live filesystem, immutable read-only filesystem version, and a separately forked writable filesystem. Keep them distinct. Ordinary `volume.at(path)` can represent the first; a future version handle can compose through the same mount descriptor once qualified. A pin is not a writable clone, and a sandbox snapshot must not be assumed to pin mounted data automatically. Do not add version/fork operations to the first Daytona PR merely to exercise future extension points.

There is an identity gap to resolve before any Tensorlake exact-resource promise: `fileSystemId` is the caller-created name. Establish whether deletion/recreation changes a discoverable immutable generation and whether mounting can select/verify it without a substitution race. This is the same category of question raised by E2B; calling a field “ID” does not answer it. Sandbox snapshot mounted-byte scope, retention of mount declarations and memory/external-data compatibility remain unverified by the inspected cross-check. The vocabulary can fit Tensorlake, but no adapter implementation or end-to-end support is claimed.

## Delivery and decisions

Two bounded implementation PRs at most; only the first is currently backed enough to start design/fixture work. Neither is a dependency of active suspend/resume or permission for paid qualification.

1. **Daytona cold restore with explicit attachments** — medium complexity, after lifecycle slice. Resolve the mount-input migration decision, add the selected input and separate attachment-support evidence, SDK checks, reuse native create mapping and ordinary outcome preservation, docs and compiled examples. Tests: mount-free/no-attach behavior unchanged; one exact mount and subpath; fresh connection restore after source deletion; wrong scope/provider/read-only/overlap rejected before POST; complete mount mismatch/read failure preserves acknowledged compute/volumes; lost response never replayed; cleanup retains volumes and respects configured policy. Packed consumer and docs checks required. Release gate: pinned/deployed startup-order evidence for mounts and network before application entrypoint, with maintained live scenario marked not-run until authorized. No capture with mounts, resize, detach, copy, versions or memory composition.
2. **Daytona mounted filesystem capture with explicit share/replace** — conditional medium-to-large complexity, depends on PR 1 and precise cold-container exclusion/provenance evidence. Stop/capture/restart must preserve mount identities; serialized reopen after source deletion must reconstruct safe scope. Test bytes outside mounts captured, external writes not frozen, declarations retained or explicitly external, stale/replaced volume IDs reject, complete dispositions checked before effects, partial restart retains snapshot. Unknown exclusion or startup behavior blocks release. Omit, memory, copy/version/fork and suspension remain cuts; do not open this PR until native feasibility is established.

Compatibility for the additive candidate: preserve shipped `RestoreRequest.mounts` action-map and strict schema behavior; no array overload or reinterpretation of `replace` as new attachment. If the consistent `mounts: MountSpec[]` target is chosen, specify an intentional migration/deprecation for the inactive action-map before implementation; do not silently reinterpret existing inputs. Older adapters decode missing `attach` support as false. Existing nonempty dispositions remain explicitly unsupported until PR 2; mount-free calls keep their current behavior. `SnapshotInfo.restore.mounts` must not advertise saved-mount support merely because `attach` is supported. This changes no shipped cleanup/deletion or retention contract. The later usability gate does not require PR 2 or universal parity; unknown native facts can be explicitly dispositioned as deferred with the user.

Real decisions for user review:

- **Product:** choose consistent create/restore `mounts` with an explicit migration for the inactive action-map, or the additive `attach` compatibility candidate? Keep explicit storage selection and no implicit share default either way.
- **Validation gate:** can Daytona production cold-container startup order be established? If not, defer PR 1 despite valid create request shape.
- **Feasibility:** does the selected production container snapshot exclude FUSE bytes and retain usable mount provenance after source deletion? If not established, defer PR 2 and keep mounted capture unsupported.

Suspend/resume remains owned by its lifecycle task and excludes mounted sources. E2B resume retains original mounts and deleting a mounted volume may prevent resume; different external data can invalidate captured process assumptions. Daytona alternate disk-volume pause limits do not establish production FUSE behavior. Research these implications when a concrete mounted-lifecycle workflow is selected; do not expand the active slice here.
