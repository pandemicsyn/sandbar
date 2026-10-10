---
title: boxd (external, experimental)
description: Use the external boxd adapter for microVMs, independent disks and warm lifecycle operations.
---

The external `sandbar-boxd` package implements the public Sandbar adapter interface. It is available in this repository; publication and live qualification are separate steps. Use Node 20+ or Bun. Native SDK version: `@boxd-sh/sdk@0.2.15`.

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
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

Use a member API key and its authenticated default org ID/slug. Userless org keys and custom endpoints are outside this adapter's initial scope. Sandbar verifies org identity and cluster zone; saved references work with current same-scope credentials.

## Defaults and networking

`image` defaults to boxd's authenticated cluster default OCI image. `lifetimeSeconds` defaults to 900, configurable from 60 to 3,600, and sets the default renewal window. `volumes.sizeBytes` defaults to 10 GiB per new disk, configurable from 1 GiB to 1 TiB subject to native quotas.

`networkPolicy: "internet"` is an explicit required setup choice. Ordinary `create()` uses that choice; an explicit blocked request rejects before allocation. The adapter enables native peer/metadata isolation, which **does not block internet egress**. Native allowlists do not establish Sandbar's strict blocked contract. Region and label overrides are unsupported.

## Adapter support

All implemented features below have deterministic native-boundary coverage. **None has live hosted qualification yet.**

| Feature                                       | Support                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Compute lifecycle                             | Create, metadata inspection, inventory, reference reopening and confirmed destruction.                |
| Commands                                      | Buffered argv/shell with cwd/env; exact stdout/stderr bytes, combined bounded capture up to 1 MiB.    |
| Files                                         | Binary read/overwrite write up to 1 MiB; actual upload byte-count acknowledgement required.           |
| Directory operations                          | Complete bounded `readDirectory`; nonrecursive mkdir and explicitly recursive remove.                 |
| Volumes                                       | Independent block disks; CRUD and create-time whole-disk read-only/read-write mounts.                 |
| Warm lifecycle                                | Suspend/resume preserves memory, processes and sockets; renewal resets wall-clock expiry.             |
| Snapshots                                     | Unsupported: exact generation restore/delete is not established for latest-only native snapshots.     |
| Interactive processes                         | Unsupported: native stream cancellation kills the process group and cannot provide detach/disconnect. |
| Other filesystem operations                   | No atomic no-clobber, stat/exists, safe copy/move or staged/large streaming transfer.                 |
| Strict blocked egress, previews, image builds | Unsupported. OCI boot does not allocate a Sandbar image-build artifact.                               |

Writes require `{ overwrite: true }`; the default no-clobber write rejects without upload. A truncated native directory response fails with `OUTPUT_CAPACITY`, rather than returning a complete-looking prefix. Finite stdin, sustained streaming, PTYs, signals and process reopening are unsupported.

## Snapshot and lifecycle behavior

Native boxd snapshots capture private disk and RAM, pause/resume the source and restore memory into new compute. They are whole-machine captures, with no memory-exclusion or targeted-path option exposed here. Native selectors are versioned latest-only, with no established immutable generation or atomic version condition for restore/delete. Sandbar therefore rejects `snapshot()` before native effects; it does not expose a capture-only workflow.

`suspend()` uses native pause. `resume()` wakes standby or hibernated compute under its original UUID; RAM, processes and sockets are preserved. Metadata inspect/reopen does not intentionally wake compute. Native inbound traffic can wake sleeping machines automatically. These are adapter-owned mechanics, not per-call native-state choices.

## Storage and recovery

A disk attaches to one machine at a time, including read-only mounts. There are no subpaths or versions; native host placement can prevent a multi-disk create. Independent disks survive compute destruction and require explicit deletion. Durability/locking/rename guarantees remain unknown. Flush application writers before teardown and explicitly choose `storage: "allow-unconfirmed"` when destroying mounted compute, or configure `cleanup: { storage: "allow-unconfirmed" }` when connecting. Cleanup reports retained UUIDs and mount paths.

Create and hard-expiry installation are separate native mutations. Sandbar retains the acknowledged machine UUID before follow-up stages. If expiry installation or the initial readiness probe is unconfirmed, the error's `outcome.kind` is `"create"` and `outcome.status` is `"partial"`. Its `outcome.sandbox` is a normal persisted, reopenable sandbox reference; `outcome.setup.expiry` and `outcome.setup.readiness` independently say `"acknowledged"` or `"unconfirmed"`. A `REFERENCE_SAVE_FAILED` error also retains the known outcome when saving a reference fails. Persist that sandbox reference and use `await client.sandboxes.get(error.outcome.sandbox)` with current same-scope credentials to inspect or explicitly destroy the known machine. No provider-token decoding is necessary. Unconfirmed expiry means the machine may lack a hard expiry. Recovery observation reads metadata and never reinstalls expiry or repeats the initial readiness probe. A lost initial create acknowledgement cannot be recovered by replaying or adopting a name. Persist SDK references when work spans application invocations.

A lost disk-create acknowledgement can leave a disk with no saved UUID. Volume CRUD support does not provide automatic reconciliation for that case: preserve unresolved custody, inspect authenticated native inventory manually, and establish the exact identity and creation ownership before explicit cleanup. Do not replay disk creation or adopt/delete a disk by name. Independent disks have no native expiry fallback.

Mutations are single-attempt. Local read cancellation reaches the transport. Buffered exec uses an explicit execution deadline; local wait cancellation is not confirmed guest termination. Closing the client drains dispatched finite commands until their deadline rather than implicitly cancelling them, then releases the channel. It does not destroy machines or disks. Missing exit evidence is unknown, never inferred success.

The maintained external profile reuses the ordinary Bun sandbox and volume suites. It distinguishes unsupported no-clobber from conflict, independently tests disk CRUD and mounts, and keeps exact snapshot roundtrip unsupported. Paid runs need explicit authorization; no generated live pass is claimed by this page.

See the [provider implementation brief and plan](https://github.com/pandemicsyn/sandbar/issues/41) and [official boxd SDK docs](https://docs.boxd.sh/reference/typescript-sdk).
