---
title: boxd (external, experimental)
description: Use the external boxd adapter for microVMs, independent disks and warm lifecycle operations.
---

The external `@sandbar-sdk/boxd` package implements the public Sandbar adapter interface. It is available in this repository; publication remains separate from its recorded live baseline. Use Node 20+ or Bun. Native SDK version: `@boxd-sh/sdk@0.2.15`.

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
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

Use a member API key and its authenticated default org ID/slug. Userless org keys and custom endpoints are outside this adapter's initial scope. Sandbar verifies org identity and cluster zone; saved references work with current same-scope credentials.

## Defaults and networking

`image` defaults to boxd's authenticated cluster default OCI image. `lifetimeSeconds` defaults to 900, configurable from 60 to 3,600, and sets the default renewal window. `size` optionally selects 1/2/4/8 vCPU (respectively 4/8/16/32 GiB RAM); omitted uses account defaults. Native private disk is fixed at 100 GB. `preview` defaults to protected lookup (unsupported); explicit `{ access: "public", ports: [3000] }` creates pinned routes and disables browser protection after expiry installation. At most 16 configured ports. Native ingress remains independently public; the protected lookup default does not privatize it.

`volumes.sizeBytes` defaults to 10 GiB per new disk, configurable from 1 GiB to 1 TiB subject to native quotas.

`networkPolicy: "internet"` is an explicit required setup choice. Ordinary `create()` uses that choice; an explicit blocked request rejects before allocation. The adapter enables native peer/metadata isolation, which **does not block internet egress**. Native allowlists do not establish Sandbar's strict blocked contract. Region and label overrides are unsupported.

## Adapter support

Implemented features have deterministic native-boundary coverage. The four baseline workflows—sandbox lifecycle, captured execution, binary files/overwrite and scoped reopening—passed at `fcb59d4056b71529b7e8d0c8c3f5a2b17f76b72e` on October 11, 2026 (four cases, 15 assertions). The run used Bun 1.3.14/darwin-arm64, native SDK 0.2.15, the provider-default OCI image, explicit internet policy and a 900-second expiry. Its one owned sandbox was destroyed and the client closed; no storage was allocated. Suspend/resume, renewal, directories, disks/mounts and other configurations remain unqualified.

| Feature                                                 | Support                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compute lifecycle                                       | Create, metadata inspection, inventory, reference reopening and confirmed destruction.                                                                   |
| Commands                                                | Buffered argv/shell with cwd/env; exact stdout/stderr bytes, combined bounded capture up to 1 MiB; finite byte stdin up to 1 MiB followed by native EOF. |
| Files                                                   | Binary read/overwrite write up to 1 MiB; actual upload byte-count acknowledgement. Default exclusive-create no-clobber helper.                           |
| Directory operations                                    | Complete bounded directory browsing, stat/exists and recursive-opt-in mkdir/remove.                                                                      |
| Volumes                                                 | Independent block disks; CRUD and create-time whole-disk read-only/read-write mounts.                                                                    |
| Warm lifecycle                                          | Suspend/resume preserves memory, processes and sockets; renewal resets wall-clock expiry.                                                                |
| Snapshots                                               | Unsupported: exact generation restore/delete is not established for latest-only native snapshots.                                                        |
| Interactive processes                                   | Unsupported: native stream cancellation kills the process group and cannot provide detach/disconnect.                                                    |
| Other filesystem operations                             | Python 3 regular-file copy, same-filesystem move, staged write and incremental read streams; walk/text lines compose these hooks.                        |
| Public previews                                         | Explicit public setup; read-only lookup of pinned configured ports on running compute.                                                                   |
| Strict blocked egress, protected previews, image builds | Unsupported. OCI boot does not allocate an image-build artifact.                                                                                         |

Native overwrite/read/directory listing and finite stdin need no installed helper. Expanded filesystem operations require Python 3 in the chosen Linux image. Stream/copy publication needs hard links in the destination filesystem; no-clobber move needs Linux `renameat2`. Cross-filesystem move rejects without copy/delete. Mounted storage must supply those primitives and remains unqualified. A truncated native listing rejects with `OUTPUT_CAPACITY`; no successful prefixes. Stat defaults to lstat, and dangling symlinks exist. Recursive removal does not walk final symlinks. Streams transfer bounded 64 KiB chunks with backpressure, without whole-file buffering or a default total-size ceiling; ordinary buffered convenience retains 1 MiB. Each helper has a 30-second RPC bound, with SDK transfer cancellation/inactivity/overall bounds. Reads observe a changing file, not a snapshot.

An interrupted or rejected streamed publication can leave a `.sandbar-<uuid>` staging file beside the destination. Transfer errors preserve its path, transferred count and confirmed effects; inspect and explicitly remove that correlated artifact or destroy owned compute. No mutation is replayed. Buffered exclusive creation has no hidden staging file; unconfirmed writes can leave partial bytes at the requested path. Cancellation reaches finite filesystem helper exec groups; ordinary exec still drains abandoned local observation until its explicit deadline.

`preview: { access: "public", ports: [3000, 8080] }` intentionally exposes configured routes. `box.preview(3000)` only reads the running scoped machine and an existing pinned route, verifies browser protection is disabled, and returns `{ access: "public", url }`. It never creates routes, changes protection or wakes compute. Auto-detected default routes are excluded because they may retarget another port. A URL does not prove listener readiness. Protected/header-auth previews are unsupported. Public native ingress can wake compute after lookup.

Finite stdin, expanded filesystem helpers, size selection and previews have offline coverage only. They do not inherit the baseline's live pass. Sustained streaming, PTYs, signals and process reopening remain unsupported: native exec closes kill the process group, and provides no persistent process generation/attach handle. A finite filesystem helper cannot supply those guarantees; a durable supervisor would be a separate architecture addition.

## Snapshot and lifecycle behavior

Native boxd snapshots capture private disk and RAM, pause/resume the source and restore memory into new compute. They are whole-machine captures, with no memory-exclusion or targeted-path option exposed here. Native selectors are versioned latest-only, with no established immutable generation or atomic version condition for restore/delete. Sandbar therefore rejects `snapshot()` before native effects; it does not expose a capture-only workflow.

`suspend()` uses native pause. `resume()` wakes standby or hibernated compute under its original UUID; RAM, processes and sockets are preserved. Metadata inspect/reopen does not intentionally wake compute. Native inbound traffic can wake sleeping machines automatically. These are adapter-owned mechanics, not per-call native-state choices.

## Storage and recovery

A disk attaches to one machine at a time, including read-only mounts. There are no subpaths or versions; native host placement can prevent a multi-disk create. Independent disks survive compute destruction and require explicit deletion. Durability/locking/rename guarantees remain unknown. Flush application writers before teardown and explicitly choose `storage: "allow-unconfirmed"` when destroying mounted compute, or configure `cleanup: { storage: "allow-unconfirmed" }` when connecting. Cleanup reports retained UUIDs and mount paths.

Create and hard-expiry installation are separate native mutations. Sandbar retains the acknowledged machine UUID before follow-up stages. If expiry installation or the initial readiness probe is unconfirmed, the error's `outcome.kind` is `"create"` and `outcome.status` is `"partial"`. Its `outcome.sandbox` is a normal persisted, reopenable sandbox reference; `outcome.setup.expiry` and `outcome.setup.readiness` independently say `"acknowledged"` or `"unconfirmed"`. A `REFERENCE_SAVE_FAILED` error also retains the known outcome when saving a reference fails. Persist that sandbox reference and use `await client.sandboxes.get(error.outcome.sandbox)` with current same-scope credentials to inspect or explicitly destroy the known machine. No provider-token decoding is necessary. Unconfirmed expiry means the machine may lack a hard expiry. Recovery observation reads metadata and never reinstalls expiry or repeats the initial readiness probe. A lost initial create acknowledgement cannot be recovered by replaying or adopting a name. Persist SDK references when work spans application invocations.

A lost disk-create acknowledgement can leave a disk with no saved UUID. Volume CRUD support does not provide automatic reconciliation for that case: preserve unresolved custody, inspect authenticated native inventory manually, and establish the exact identity and creation ownership before explicit cleanup. Do not replay disk creation or adopt/delete a disk by name. Independent disks have no native expiry fallback.

Mutations are single-attempt. Local read cancellation reaches the transport. Buffered exec uses an explicit execution deadline; local wait cancellation is not confirmed guest termination. Closing the client drains dispatched finite commands until their deadline rather than implicitly cancelling them, then releases the channel. It does not destroy machines or disks. Missing exit evidence is unknown, never inferred success.

The maintained external profile reuses the ordinary Bun sandbox and volume suites. It now declares no-clobber, finite stdin, filesystem and explicitly public preview cases while retaining their live not-run status; it independently tests disk CRUD and mounts, and keeps exact snapshot roundtrip unsupported. Further paid runs need explicit authorization. [Sanitized baseline evidence](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/boxd/qualification/live-qualification.md) records the tested revision and configuration.

See the [provider implementation brief and plan](https://github.com/pandemicsyn/sandbar/issues/41) and [official boxd SDK docs](https://docs.boxd.sh/reference/typescript-sdk).
