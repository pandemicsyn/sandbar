# @sandbar-sdk/boxd

Experimental external boxd adapter for Sandbar. Implementation, offline fixtures and a live baseline are available; Install with `npm install sandbar-sdk @sandbar-sdk/boxd`. Requires Node 20+ or Bun and a boxd **member API key** fenced to your default organization. Native SDK pinned to `@boxd-sh/sdk@0.2.15`.

```ts
import { Sandbar } from "sandbar-sdk";
import { boxdAdapter } from "@sandbar-sdk/boxd";

const client = await Sandbar.connect({
  adapter: boxdAdapter,
  credentials: { apiKey: process.env.BOXD_API_KEY! },
  config: { org: "my-org", networkPolicy: "internet" },
});
try {
  const box = await client.sandboxes.create();
  try {
    console.log((await box.exec(["/bin/sh", "-c", "printf ready"])).stdoutText());
  } finally { await box.destroy(); }
} finally { await client.close(); }
```

The organization ID/slug must match authenticated default-org inventory. Scope includes its verified ID, the fixed hosted endpoint and cluster zone. References contain UUIDs and routing, never API keys or JWTs; reopen with current credentials for the same scope.

## Setup defaults

| Setting | Behavior |
| --- | --- |
| `org` | Required authenticated default organization ID or slug. |
| `networkPolicy` | Required literal `internet`; omitted per-call policy uses this explicit choice. |
| `size` | Optional 1, 2, 4 or 8 vCPU size class; RAM is respectively 4, 8, 16 or 32 GiB. Omitted uses native account defaults. Fixed native 100 GB private disk. |
| `preview` | Defaults to `{ access: "public", ports: [3000] }`: create pins HTTPS routes and disables browser protection; at most 16 ports. Explicit `protected` keeps browser protection on with no routes (lookup unsupported). |
| `image` | Optional OCI reference; defaults to the authenticated cluster's default image. |
| `lifetimeSeconds` | Initial hard expiry/default renewal window: 900 seconds, minimum 60, no adapter maximum (boxd documents none for `setDeleteAfter`). |
| `volumes.sizeBytes` | Per-new-disk size: 10 GiB, configurable 1 GiB–1 TiB; native quotas still apply. |

Create uses peer/metadata isolation, with **internet egress allowed**. `isolated` is not deny-all networking. Explicit blocked policy, regions and labels are rejected before allocation. The production endpoint is fixed. Native image startup can run workload code before the separate expiry-setting request; create and expiry installation are not atomic.

## Support

| Feature | Adapter behavior |
| --- | --- |
| Compute | Create/readiness, scoped inspect/reopen/inventory and confirmed destroy. |
| Exec | Safely quoted argv/shell, cwd/env, original stdout/stderr bytes; combined output collection bounded to 1 MiB with truthful truncation. Finite byte stdin up to 1 MiB, in 64 KiB frames followed by native EOF. Sustained processes, PTYs, signals and process reopening remain unsupported. |
| Files | Bounded binary reads/writes up to 1 MiB. Overwrite uses native upload with an actual byte-count acknowledgement. Default no-clobber uses Python 3 exclusive creation. Complete bounded `readDirectory`; recursive-opt-in mkdir/remove. |
| Extra filesystem operations | Python 3 lstat/stat/exists (dangling links exist), regular-file copy, same-filesystem move, staged writes and incremental reads in 64 KiB chunks. Walk/text lines compose these hooks. |
| Volumes | Independent block disks; CRUD and whole-disk create-time mounts, read-only/read-write, one machine at a time even read-only. No subpaths or versions. |
| Suspend/resume | Pause retains files, RAM, processes and sockets. Resume/wake handles standby and hibernation under the same UUID. Inbound native traffic can wake compute automatically. |
| Renew | Resets sandbox-wide wall-clock deletion window (at least 60 seconds, no maximum; `renewCapabilities` omits `maxSeconds`); acknowledgement and observed expiry are separate. |
| Snapshots | Unsupported in Sandbar: native snapshots are versioned latest-only; immutable-generation restore/delete targeting is not established. No capture-only artifact allocation. |
| Previews | Default public setup, existing pinned route and running scoped compute with browser protection disabled. Read-only lookup. Protected access unsupported. |
| Strict network policy / builds | Unsupported. OCI images boot directly; there is no image-build artifact. |

Native snapshots capture private disk plus RAM, briefly pause/resume the source and restore running memory into a new machine. They are not targeted workspace snapshots. The current latest-only selectors cannot promise Sandbar's exact saved-artifact lifecycle, so `snapshot()` rejects before stopping or capturing anything. Memory exclusion, no-pause and version selection are not offered as fictitious configuration options.

## Disks and cleanup

```ts
const volume = await client.volumes.create({ name: "workspace" });
const box = await client.sandboxes.create({ mounts: [volume.at("/workspace")] });
// Durability remains unknown. The ordinary cleanup default refuses mounted
// destruction unless the caller explicitly accepts this uncertainty.
await box.destroy({ storage: "allow-unconfirmed" });
await volume.delete();
```

You can choose `cleanup: { storage: "allow-unconfirmed" }` when connecting and retain per-call overrides. Compute destruction never deletes independent disks. Returned cleanup details retain actual disk UUIDs and mount paths. Native disks are host-local and exclusive; multi-disk placement can fail even if each disk is individually ready. Flush application writes before teardown; Sandbar does not certify durability, locking or rename semantics. Explicit caller-selected volume deletion checks scope, identity and native attachments, including after a fresh connection.

## Failures and cancellation

Each mutation has one native outbound attempt; transport retries are disabled. Create checkpoints its acknowledged UUID before native follow-up reads and expiry installation. A lost create acknowledgement is unknown and must not be replayed or adopted by name. If expiry installation or the initial guest-readiness probe is unconfirmed, the error retains `outcome.kind: "create"`, `outcome.status: "partial"`, and a normal reopenable `outcome.sandbox` reference. `outcome.setup.expiry` and `outcome.setup.readiness` independently report `"acknowledged"` or `"unconfirmed"`. `REFERENCE_SAVE_FAILED` also preserves this known outcome when a reference-persistence callback fails. Save the sandbox reference, reopen it with `await client.sandboxes.get(error.outcome.sandbox)`, then inspect or explicitly destroy that known machine; no provider-token decoding is needed. An unconfirmed expiry means the machine may lack a hard expiry. Recovery observation only reads metadata: it never reinstalls expiry or repeats the readiness probe. Persist SDK references if work crosses process invocations.

A lost disk-create acknowledgement can leave a disk with no saved UUID. Volume CRUD support does not provide automatic reconciliation for that case: preserve unresolved custody, inspect authenticated native inventory manually, and establish the exact identity and creation ownership before explicit cleanup. Do not replay disk creation or adopt/delete a disk by name. Independent disks have no native expiry fallback.

Native Exec cancellation terminates the guest process group. The adapter therefore does not advertise disconnect-safe process handles. A buffered command has an explicit execution deadline; stopping a local wait does not certify its exit or replay it. Closing a connection drains already-dispatched finite exec RPCs until their deadline before releasing that channel, rather than cancelling them as an implicit kill. Close does not delete compute or disks. Reads cooperate with local cancellation/deadlines. A missing exit receipt remains unknown.

The baseline passed at `fcb59d4056b71529b7e8d0c8c3f5a2b17f76b72e` on October 11, 2026: sandbox lifecycle, captured execution, binary files/overwrite and scoped reopening (four cases, 15 assertions). The run used Bun 1.3.14/darwin-arm64, native SDK 0.2.15, the provider-default OCI image, explicit internet policy and a 900-second expiry. Its one owned sandbox was destroyed and the client closed; no storage was allocated. Suspend/resume, renewal, directories, disks/mounts and other configurations remain unqualified. See [sanitized live evidence](qualification/live-qualification.md) and [support](qualification/support.md).

Deterministic tests use a local gRPC server and the pinned SDK's public protobuf codecs. They establish request construction, bounds, scope rejection, acknowledgement handling and no replay. They do not extend the live baseline to other behavior. The shared Bun provider profile is `packages/sdk-qualification/provider-qualification/boxd-profile.ts`; paid runs require separate authorization. This experimental external package is excluded from the selected Daytona/E2B 1.0 release gate until separately qualified and scheduled for publication.

## Filesystem prerequisites and transfer outcomes

Native overwrite/read/readDirectory and finite stdin require no installed helper. Expanded filesystem operations require Python 3 in the selected Linux image. No-clobber writes use `O_EXCL`; stream/copy publication uses same-directory staging and hard links. No-clobber move requires Linux `renameat2`; cross-filesystem rename rejects without a copy/delete fallback. These guarantees target the private filesystem; mounted storage must provide the corresponding filesystem primitives and remains unqualified. Buffered transfers retain the 1 MiB bound; larger files use ordinary `writeFileStream`/`readFileStream`. Streams have bounded application memory and no default whole-file ceiling. Each finite helper is bounded to 30 seconds; SDK transfer inactivity/overall cancellation also applies. Reads observe a changing file, not an immutable snapshot.

Paths are arguments, never interpolated programs. Recursive removal does not walk final symlinks; stat defaults to lstat and exists includes dangling links. Copies accept regular files; destination parents must exist. Interrupted or rejected streamed publication can retain a `.sandbar-<uuid>` file beside the destination. Transfer errors retain its path, byte count and any confirmed destination effect. Inspect and explicitly remove that correlated artifact or destroy owned compute; no mutation is replayed and caller files are never incidental cleanup targets. Buffered exclusive creation has no hidden staging file; an unconfirmed write can leave partial bytes at the requested path. Cancellation of a filesystem helper cancels its native exec group; ordinary user exec still drains locally abandoned observation until its execution deadline.

```ts
// Public exposure on port 3000 is the default; choose other ports when connecting:
// config: { org: "my-org", networkPolicy: "internet",
//   preview: { access: "public", ports: [3000, 8080] }, size: 1 }
const preview = await box.preview(3000); // read-only; requires this configured pinned route
```

Public setup disables native browser protection after initial expiry installation. A lost acknowledgement retains the ordinary partial-create reference; observation never repeats that setting. Lookup does not disable protection, pin ports, wake machines or prove listener readiness. Native HTTPS/SSH ingress exists independently of Sandbar preview setup; the `protected` lookup setting does not privatize it. Native inbound traffic may wake sleeping compute.

The new helpers, finite stdin, public preview and size option have deterministic/offline coverage only. The recorded `fcb59d4` live baseline continues to cover only lifecycle, captured execution, native binary overwrite/read and reopening, including its then-unsupported no-clobber assertion. It does not qualify these additions. See [implementation audit and bounded live proposal](qualification/implementation.md).
