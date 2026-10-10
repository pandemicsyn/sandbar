# sandbar-boxd

Experimental external boxd adapter for Sandbar. Implementation and offline fixtures are available; npm publication and live provider qualification are separate steps. Requires Node 20+ or Bun and a boxd **member API key** fenced to your default organization. Native SDK pinned to `@boxd-sh/sdk@0.2.15`.

```ts
import { Sandbar } from "sandbar-sdk";
import { boxdAdapter } from "sandbar-boxd";

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
| `image` | Optional OCI reference; defaults to the authenticated cluster's default image. |
| `lifetimeSeconds` | Initial hard expiry/default renewal window: 900 seconds, configurable 60–3600. |
| `volumes.sizeBytes` | Per-new-disk size: 10 GiB, configurable 1 GiB–1 TiB; native quotas still apply. |

Create uses peer/metadata isolation, with **internet egress allowed**. `isolated` is not deny-all networking. Explicit blocked policy, regions and labels are rejected before allocation. The production endpoint is fixed. Native image startup can run workload code before the separate expiry-setting request; create and expiry installation are not atomic.

## Support

| Feature | Adapter behavior |
| --- | --- |
| Compute | Create/readiness, scoped inspect/reopen/inventory and confirmed destroy. |
| Exec | Safely quoted argv/shell, cwd/env, original stdout/stderr bytes; combined output collection bounded to 1 MiB with truthful truncation. No finite stdin, sustained processes, PTYs, signals or process reopening. |
| Files | Bounded binary reads/writes up to 1 MiB. Writes require `overwrite: true` and an actual byte-count acknowledgement. Complete bounded `readDirectory`, nonrecursive mkdir, explicitly recursive remove. |
| Extra filesystem operations | Atomic no-clobber, stat/exists, safe copy/move and staged/large streaming transfers unsupported. |
| Volumes | Independent block disks; CRUD and whole-disk create-time mounts, read-only/read-write, one machine at a time even read-only. No subpaths or versions. |
| Suspend/resume | Pause retains files, RAM, processes and sockets. Resume/wake handles standby and hibernation under the same UUID. Inbound native traffic can wake compute automatically. |
| Renew | Resets sandbox-wide wall-clock deletion window; acknowledgement and observed expiry are separate. |
| Snapshots | Unsupported in Sandbar: native snapshots are versioned latest-only; immutable-generation restore/delete targeting is not established. No capture-only artifact allocation. |
| Strict network policy / previews / builds | Unsupported. OCI images boot directly; there is no image-build artifact. |

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

Deterministic tests use a local gRPC server and the pinned SDK's public protobuf codecs. They establish request construction, bounds, scope rejection, acknowledgement handling and no replay. They do not establish current hosted behavior. The shared Bun provider profile is `packages/sdk-qualification/provider-qualification/boxd-profile.ts`; paid runs require separate authorization. This experimental external package is excluded from the selected Daytona/E2B 1.0 release gate until separately qualified and scheduled for publication.
