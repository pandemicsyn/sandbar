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

The adapter uses these defaults:

- **Image:** the default OCI image configured for your boxd account.
- **Lifetime:** 15 minutes. Set `lifetimeSeconds` from 60 to 3,600 seconds; this also sets the default renewal window.
- **Compute size:** your account default. Set `size` to 1, 2, 4 or 8 vCPUs for 4, 8, 16 or 32 GiB RAM. The machine's private disk is fixed at 100 GB.
- **New volumes:** 10 GiB each. Set `volumes.sizeBytes` from 1 GiB to 1 TiB, subject to your quota.
- **Preview lookup:** disabled unless you explicitly choose public access. See [Public previews](#public-previews).

You must set `networkPolicy: "internet"` when connecting. Ordinary sandbox creation uses that setting. Requests for blocked internet access fail before a machine is allocated. boxd isolates machines from peers and metadata services, but **internet access remains enabled**. Region and label overrides are unsupported.

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

## Files and streams

Native file reads, overwrite writes, directory listing and finite command input work without an installed helper. The additional filesystem operations require **Python 3 in your Linux image**: stat/exists, exclusive writes, mkdir/remove, copy/move and file streams. Sandbar does not install Python for you.

Buffered reads and writes are limited to 1 MiB. Use file streams for larger files: they transfer 64 KiB chunks without loading the whole file into memory. Streams have no default total-size limit; SDK transfer options let you set size and time limits. Each helper call has a 30-second deadline. A streamed read can see changes made to the file while reading.

Directories are listed completely or the call fails with `OUTPUT_CAPACITY`; Sandbar does not return a successful partial list. `statFile()` inspects a symlink itself by default, and `fileExists()` returns true for dangling symlinks. Creating missing parent directories or deleting a directory's contents requires `recursive: true`. Recursive deletion does not follow a symlink at the requested path.

Copying and publishing a streamed write require hard links in the destination filesystem. Moving without overwrite requires Linux `renameat2`; moving across filesystems fails without copying or deleting the source. These requirements also apply to mounted storage, which has not been live-qualified.

A streamed write uses a temporary `.sandbar-<uuid>` file beside the destination. If writing or publishing fails, the error retains the temporary path, confirmed byte count and known effects. Inspect that file and explicitly remove it, or destroy compute you own. Sandbar never retries the mutation automatically. An exclusive buffered write writes directly to the requested path, so an interrupted write may leave partial contents there.

## Public previews

Enable public previews when connecting:

```ts
import { Sandbar } from "sandbar-sdk";
import { boxdAdapter } from "@sandbar-sdk/boxd";

const client = await Sandbar.connect({
  adapter: boxdAdapter,
  credentials: { apiKey: process.env.BOXD_API_KEY! },
  config: {
    org: "my-org",
    networkPolicy: "internet",
    preview: { access: "public", ports: [3000, 8080] },
  },
});
```

This creates routes for the selected ports and disables boxd's browser protection during sandbox setup. Configure 1–16 distinct ports. **The routes are publicly accessible.** Protected previews and authentication headers are unsupported.

After starting a server, call `box.preview(3000)` to get `{ access: "public", url }`. The lookup checks the running machine and its configured route. It does not create routes, change protection or wake the machine. The returned URL does not prove your server is ready.

The default `preview.access` is `"protected"`, so preview lookup fails as unsupported unless public access is selected. This setting does **not** make boxd's own ingress private. Native public traffic can still reach or wake a machine. Auto-detected routes are excluded because their target port can change.

Finite stdin, expanded filesystem operations, size selection and previews have offline coverage only. They do not inherit the baseline's live pass.

## Snapshot and lifecycle behavior

boxd snapshots include the machine’s private disk and RAM, but a newer snapshot can replace the saved version. The API does not establish a way to restore or delete one exact saved version safely. Sandbar therefore rejects `snapshot()` before creating any snapshot.

`suspend()` uses native pause. `resume()` wakes standby or hibernated compute under its original UUID; RAM, processes and sockets are preserved. Metadata inspect/reopen does not intentionally wake compute. Native inbound traffic can wake sleeping machines automatically. Your application uses the same `suspend()` and `resume()` calls for both native sleep states.

## Storage and recovery

A disk attaches to one machine at a time, including read-only mounts. There are no subpaths or versions; native host placement can prevent a multi-disk create. Independent disks survive compute destruction and require explicit deletion. The adapter has not established persistence, locking or rename guarantees for mounted disks. Flush application writers before teardown and explicitly choose `storage: "allow-unconfirmed"` when destroying mounted compute, or configure `cleanup: { storage: "allow-unconfirmed" }` when connecting. Cleanup reports retained UUIDs and mount paths.

Creating a machine and setting its expiry are separate requests. Sandbar retains the acknowledged machine UUID before follow-up stages. If expiry installation or the initial readiness probe is unconfirmed, the error's `outcome.kind` is `"create"` and `outcome.status` is `"partial"`. Its `outcome.sandbox` is a normal persisted, reopenable sandbox reference; `outcome.setup.expiry` and `outcome.setup.readiness` independently say `"acknowledged"` or `"unconfirmed"`. A `REFERENCE_SAVE_FAILED` error also retains the known outcome when saving a reference fails. Persist that sandbox reference and use `await client.sandboxes.get(error.outcome.sandbox)` with current same-scope credentials to inspect or explicitly destroy the known machine. No provider-token decoding is necessary. Unconfirmed expiry means the machine may lack a hard expiry. Recovery observation reads metadata and never reinstalls expiry or repeats the initial readiness probe. A lost initial create acknowledgement cannot be recovered by replaying or adopting a name. Persist SDK references when work spans application invocations.

A lost disk-create acknowledgement can leave a disk with no saved UUID. Volume CRUD support does not provide automatic reconciliation for that case: keep a record of the failed attempt and inspect your native disk inventory manually. Confirm the exact disk identity and that your attempt created it before deleting it. Do not replay disk creation or adopt/delete a disk by name. Independent disks have no native expiry fallback.

Sandbar sends each mutation once. Local read cancellation reaches the transport. Buffered exec uses an explicit execution deadline; local wait cancellation is not confirmed guest termination. Closing the client drains dispatched finite commands until their deadline rather than implicitly cancelling them, then releases the channel. It does not destroy machines or disks. Missing exit evidence is unknown, never inferred success.

The maintained external profile reuses the ordinary Bun sandbox and volume suites. It now declares no-clobber, finite stdin, filesystem and explicitly public preview cases while retaining their live not-run status; it independently tests disk CRUD and mounts, and keeps exact snapshot roundtrip unsupported. New live tests require explicit authorization. [Sanitized baseline evidence](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/boxd/qualification/live-qualification.md) records the tested revision and configuration.

See the [provider implementation brief and plan](https://github.com/pandemicsyn/sandbar/issues/41) and [official boxd SDK docs](https://docs.boxd.sh/reference/typescript-sdk).
