---
title: Vercel Sandbox
description: Run commands, work with files, suspend persistent sandboxes and restore filesystem snapshots on Vercel.
---

The `@sandbar-sdk/vercel` package runs short-lived [Vercel Sandbox](https://vercel.com/docs/sandbox) VMs in an existing Vercel team and project. Install it with `npm install sandbar-sdk @sandbar-sdk/vercel`. It is experimental: it has not yet been tested against the live Vercel service. Use Node 20+ or Bun.

```ts
import { Sandbar } from "sandbar-sdk";
import { vercel } from "@sandbar-sdk/vercel";

const client = await Sandbar.connect({
  adapter: vercel,
  config: {
    teamId: process.env.SANDBAR_VERCEL_TEAM_ID!,
    projectId: process.env.SANDBAR_VERCEL_PROJECT_ID!,
    network: "blocked",
  },
  credentials: { token: process.env.VERCEL_TOKEN! },
});
try {
  const box = await client.sandboxes.create();
  try {
    await box.writeFile("/tmp/example.bin", new Uint8Array([0, 255, 129]), { overwrite: true });
    console.log((await box.exec(["node", "-e", "console.log('ready')"])).stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

Use a token that can access the team and project. `connect` checks the team, project and access with read-only requests and allocates no compute. Saved sandbox references contain no credentials.

## Setup

| Setting                      | Default                           | Notes                                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `teamId`, `projectId`        | required                          | The existing team and project.                                                                                                                                                                                                                                    |
| `credentials.token`          | required                          | Token with access to that team and project.                                                                                                                                                                                                                       |
| `region`                     | `iad1`                            | One of the 19 supported Vercel regions. No automatic failover.                                                                                                                                                                                                    |
| `image`                      | `vercel/sandbox/universal:latest` | Also `vercel/sandbox/node:22`, `node:24` or `node:26`. Only the universal image supports processes and terminals. Use `node:24` to keep working with sandboxes from the earlier default.                                                                          |
| `resources`                  | 2 vCPUs                           | Minimum `{ vcpus, memoryMiB }`. Picks the smallest of 1 or an even count up to 32 vCPUs, with 2 GiB per vCPU. Your plan limit still applies. Deprecated alias: `vcpus` (2, 4 or 8).                                                                               |
| `lifecycle.lifetimeSeconds`  | `900`                             | Initial session lifetime, up to 86,400 seconds; values under 60 become 60. `create({ lifecycle })` can override it per sandbox, except with `persistent: true`. Vercel enforces lower plan limits itself (Hobby: 45 minutes). Deprecated alias: `timeoutSeconds`. |
| `network`                    | `blocked`                         | `blocked` (Vercel deny-all) or `internet` (allow-all). Deprecated: `networkPolicy`, `vercel-deny-all`, `vercel-allow-all`.                                                                                                                                        |
| `ports`                      | `[]`                              | Up to 15 distinct ports to expose as public HTTPS previews.                                                                                                                                                                                                       |
| `persistent`                 | `false`                           | Keep files across suspend and resume. See [Persistent sandboxes](#persistent-sandboxes).                                                                                                                                                                          |
| `snapshots.preserve`         | `filesystem`                      | Vercel snapshots keep files only; `Preserve.FILESYSTEM_AND_MEMORY` rejects `UNSUPPORTED` at connect.                                                                                                                                                              |
| `snapshots.retentionSeconds` | 30 days                           | Seconds a snapshot is kept after its last use; `0` never expires. Disposable mode only.                                                                                                                                                                           |

Create-time image, region and network must match this setup. `create({ env })` sets Vercel session variables that every command inherits unless it overrides them; values are not saved in references and are redacted from Vercel error text. `labels` accepts up to four entries, and keys starting with `sandbar` are rejected. Mounts are rejected with `UNSUPPORTED`. See [environment variables](/docs/guides/images-and-networking/#set-environment-variables).

## What works

| Feature                      | Support                                                                                              | Live tested |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ----------- |
| Sandbox lifecycle            | Create, inspect and destroy, with confirmed termination.                                             | No          |
| Reconnect later              | `sandboxes.get(reference)` with the same team, project and region.                                   | No          |
| Lifetime renewal             | `renew()` adds seconds to the running session.                                                       | No          |
| Pause and resume             | `suspend()` and `resume()` with `persistent: true`. Files are kept; RAM and processes are not.       | No          |
| Commands                     | argv or shell, `cwd`, `env`; exact stdout/stderr bytes up to 1 MiB combined, with a truncation flag. | No          |
| Streaming and terminals      | Text and byte output, stdin, signals, resize and reopen. Universal image only.                       | No          |
| Command input                | Finite stdin up to 1 MiB, verified before the command starts.                                        | No          |
| Files                        | Byte-exact reads and writes up to 1 MiB, file streams beyond that, no-clobber writes.                | No          |
| Directories                  | List, stat, exists, mkdir, remove, copy and move. Recursive changes need explicit opt-in.            | No          |
| HTTP previews                | Public HTTPS URL for each configured port.                                                           | No          |
| Images                       | Vercel's four managed images only. Image get, list and delete reject with `UNSUPPORTED`.             | —           |
| Network controls             | `blocked` or `internet`. No allowlists.                                                              | No          |
| Snapshots                    | Filesystem capture (stops the source), restore, inspect and delete.                                  | No          |
| Volumes and mounts           | Not supported                                                                                        | —           |
| Listing sandboxes and images | Sandboxes in the configured project and region. Images not supported.                                | No          |

Live results cover the tested image, region and network setting; see [Provider support](/docs/providers/support/).

## Lifetime, cleanup and reopening

`box.destroy()` stops the VM session and waits until termination is confirmed. Closing the client only releases local resources. The native timeout is a fallback, not proof of cleanup.

`box.renew({ forSeconds })` **adds** 1 to 86,400 seconds to the running session. Vercel caps total session time by plan (Hobby 45 minutes, Pro and Enterprise 24 hours) and rejects requests over the cap. Inspecting or reopening a sandbox never renews or resumes it.

Reopening searches at most 10,000 project sessions and fails if it cannot confirm the sandbox. `sandboxes.list()` returns every sandbox in the project and region by default; with `persistent: true` it returns only named sandboxes Sandbar created. Listed sandboxes have `ownership: "unknown"`.

When Vercel refuses a create, nothing was created and `create()` rejects with Vercel's reason: 400 and 422 map to `INVALID_ARGUMENT`, 401 to `UNAUTHENTICATED`, 402 to `CAPACITY`, 403 to `FORBIDDEN`, 404 to `NOT_FOUND` and 429 to `RATE_LIMIT`. A 409, server error or lost response is `OUTCOME_UNKNOWN` and is never retried. See [recovery](/docs/guides/recovery/) and [resources](/docs/guides/resources/).

## Persistent sandboxes

With `persistent: true`, `box.suspend()` stops compute and saves the filesystem, and `box.resume()` starts a fresh VM with those files. The reference stays the same; `inspect().execution` names the current VM session. Suspension ends processes and connections and **does not save RAM**, so restart servers after resume. Nothing resumes an inactive sandbox automatically. A session timeout also stops compute and saves the filesystem.

- Vercel bills stored checkpoints. The adapter keeps one rolling checkpoint, but Vercel's expiration still applies, so this is not permanent storage.
- `destroy()` deletes the named sandbox but keeps its snapshots and reports their IDs. Delete them separately.
- Serialize lifecycle changes for a sandbox, including those made outside Sandbar. Vercel has no atomic check on named resume or delete, so a sandbox replaced under the same name during a call could be affected. Detected replacements and changed settings are rejected.
- `box.snapshot()` is unsupported in persistent mode; use `suspend()` instead. Restoring a snapshot taken in disposable mode can create a new persistent sandbox.

## Snapshots

**`box.snapshot()` terminates the source sandbox.** It captures the filesystem only; restore creates a new, independent sandbox. Capture needs a disposable sandbox with no mounts that was created, restored or recovered in the current connection. Reopening from a reference alone is not enough. Restore uses the same configured image, and snapshots found only by listing cannot be restored through Sandbar.

Snapshots expire 30 days after their last use. Set `snapshots: { retentionSeconds }` to change that, with `0` for never; restoring from a snapshot resets its clock. The setting needs disposable mode and rejects `UNSUPPORTED` with `persistent: true`. Consistency is not guaranteed, and a minimum retention is guaranteed only up to the configured `retentionSeconds`. Requests needing more fail before capture. **Delete snapshots separately from compute cleanup**, since Vercel bills them until they expire. If a capture response is lost, the adapter does not guess which snapshot is yours. See [snapshots and volumes](/docs/guides/snapshots-and-volumes/).

## Limits

- Not yet tested against the live Vercel service. Network isolation has not been independently verified.
- Preview ports are public from creation, before your app is ready, and protected previews are unsupported. See [preview access](/docs/guides/preview-access/).
- Processes and terminals need the universal image. Moves with `overwrite: false` do too.
- Paths must be absolute. Directory listings fail above 1,024 entries or 65,536 bytes of names rather than truncating.
- Interrupted file transfers can leave temporary files until the sandbox is destroyed.
- No custom or OCI images, volumes, mounts, egress allowlists, custom firewall rules or OIDC credential discovery.

See the [Vercel Sandbox docs](https://vercel.com/docs/sandbox), [pricing and limits](https://vercel.com/docs/sandbox/pricing), the [adapter README](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/README.md) and the [native audit](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/NATIVE.md).
