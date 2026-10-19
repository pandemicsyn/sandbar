---
title: Daytona
description: Use the Daytona adapter for sandboxes from prepared snapshots, with previews, snapshots, volumes and suspend/resume.
---

The `@sandbar-sdk/daytona` package runs Sandbar sandboxes on [Daytona](https://www.daytona.io) through its REST API, with no native SDK dependency. Install it with `npm install sandbar-sdk @sandbar-sdk/daytona`; it is a supported provider. Use Node 20+ or Bun.

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { daytona } from "@sandbar-sdk/daytona";

const client = await Sandbar.connect(
  daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    target: "us",
    environment: Image.prepared("daytona-small"),
    lifecycle: { lifetimeSeconds: 600 },
    network: "daytona-default",
  }),
);

try {
  const box = await client.sandboxes.create();
  try {
    await box.exec(["/bin/sh", "-c", "printf ready"]);
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

Set `DAYTONA_API_KEY` on the server. `connect` reads the key's organization and checks that the `target` region is available to it. Everything is scoped to that organization, region and network setting; a rotated key for the same organization works with saved references.

## Setup

| Setting                         | Default           | Notes                                                                                                                                                                                  |
| ------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                        | required          | Daytona API key.                                                                                                                                                                       |
| `target`                        | required          | Daytona region id, such as `us`.                                                                                                                                                       |
| `environment`                   | none              | Default image for `create()`: a prepared Daytona snapshot (`Image.prepared(...)`) or an OCI image. A per-call `environment` wins. With neither, `create()` rejects `INVALID_ARGUMENT`. |
| `network`                       | `daytona-default` | `daytona-default`, `internet` or `blocked`. See [Network policy](#network-policy). Deprecated alias: `networkPolicy`; setting both rejects.                                            |
| `lifecycle.lifetimeSeconds`     | 900               | Lifetime at create and the default `renew()` window. Rounded up to whole minutes. No adapter maximum.                                                                                  |
| `ttlMinutes`                    | `15`              | Older way to set the lifetime in whole minutes. Set this or `lifecycle.lifetimeSeconds`, not both.                                                                                     |
| `lifecycle.idleSeconds`         | off               | Stop the sandbox after this many idle seconds, rounded up to minutes, up to 86,400. Off means Daytona's native 15-minute idle stop is disabled.                                        |
| `lifecycle.suspension.preserve` | `filesystem`      | `filesystem+memory` rejects `UNSUPPORTED` at connect.                                                                                                                                  |
| `preview.access`                | `protected`       | `public` rejects `UNSUPPORTED` at connect, because Daytona would publish every port of the sandbox.                                                                                    |
| `snapshots.restartAfterCapture` | `true`            | Restart a running source after `snapshot()`. `false` leaves it stopped.                                                                                                                |
| `resources`                     | none              | Minimum `{ vcpus, memoryMiB }`. OCI builds use it; a prepared snapshot must already meet it. Not accepted by `daytona()`; pass it in adapter `config` with `daytonaAdapter`.           |

Create-time `env` is sent as native sandbox environment variables, so it applies to every command, including after reopening; per-call `env` overrides a name. Values are not stored in references and are redacted from Daytona error text. Create-time `labels` are supported. An invalid image override never falls back to the default or starts an unrequested build.

## What works

| Feature                      | Support                                                                                                        | Live tested |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------- |
| Sandbox lifecycle            | Create, inspect and destroy. Destroy waits for confirmed deletion.                                             | Yes         |
| Reconnect later              | `sandboxes.get(reference)` reopens the same sandbox without starting or extending it.                          | Yes         |
| Lifetime renewal             | `renew()` resets the deadline, rounded up to whole minutes.                                                    | Yes         |
| Pause and resume             | Native stop/start. Files are kept; processes are not.                                                          | Yes         |
| Commands                     | argv and shell, exact stdout/stderr bytes up to 1 MiB per stream, deadline default 300 seconds.                | Yes         |
| Streaming and terminals      | `processes.start()`, signals, terminals and reattaching after reconnecting.                                    | Yes         |
| Command input                | Finite byte stdin.                                                                                             | No          |
| Files                        | Binary read and write up to 16 MiB, overwrite and no-clobber, plus byte streams.                               | Yes         |
| Directories                  | List, stat, create, remove, copy and move.                                                                     | Yes         |
| HTTP previews                | Protected only, with an `x-daytona-preview-token` header. Public previews are not supported.                   | Yes         |
| Images                       | Prepared snapshots and OCI builds; `images.get`, `list` and `delete` over native snapshots.                    | No          |
| Network controls             | `daytona-default`, `internet` or strict `blocked`, set once per connection.                                    | No          |
| Snapshots                    | Filesystem capture and restore into a new sandbox.                                                             | Yes         |
| Volumes and mounts           | Create, delete and mount object-backed volumes, including at restore.                                          | Yes         |
| Listing sandboxes and images | `sandboxes.list()` returns Sandbar-created sandboxes only; `images.list()` returns all organization snapshots. | No          |

Live results cover the tested image, region and network setting; see [Provider support](/docs/providers/support/). Live runs used the prepared `daytona-small` snapshot in `us` with `daytona-default`; other snapshots are not qualified.

## Network policy

The policy is set once on the connection and is part of its scope. A per-call policy must match it; open another connection to use a different one. There is never a fallback.

- `daytona-default` keeps Daytona's organization-managed egress rules. On lower tiers this still allows some essential services, so it is neither unrestricted nor strictly blocked.
- `internet` asks for unrestricted egress. It needs an organization without limited sandbox egress (Tier 3 and above); otherwise create rejects before anything is allocated.
- `blocked` asks for strict no egress. Connect must verify the organization supports native block-all; if the check is restricted or unreadable, creation is unavailable.

Earlier releases defaulted to `blocked`. To reopen sandboxes created under that default, connect with `network: "blocked"`. See [Images and networking](/docs/guides/images-and-networking/#select-a-network-policy).

## Image requirements

Start from an active, Linux snapshot available to your organization in the target region. Public (general) snapshots can be used but are never deleted by Sandbar.

The image needs `/bin/sh`, `mktemp`, `mkfifo`, `cat`, `wc`, `head`, `od` and `rm` for command output, plus `mkdir`, `rmdir`, `mv`, copy and link utilities for file writes. Atomic no-clobber writes need `ln -T` and hard links. Directory operations and streaming processes need Python 3; no-clobber rename also needs Linux libc `renameat2`. Streaming needs writable private `/tmp`. Nothing is installed for you.

`images.list()` reports every snapshot in the organization; general ones show as `public` and ownership is unknown. `images.delete()` refuses general snapshots, other organizations' snapshots, snapshots captured from a sandbox (use `snapshots.delete()`), and any snapshot an organization warm pool uses or when warm pools cannot be read, because Daytona's delete cascades to them. See [Images and networking](/docs/guides/images-and-networking/).

## Lifetime, idle stop and suspension

The lifetime is a hard wall-clock deadline. When it passes, Daytona deletes the sandbox, even while it is stopped or archived, so saved files can be lost. `renew()` sets a new deadline from now, which may shorten a longer one; it is not additive. `renew({ forSeconds: 61 })` becomes 120 seconds. Renewal and preview access need a running sandbox.

Idle stop is separate from the lifetime and renewing does not disable it. Daytona natively stops sandboxes after 15 idle minutes, even with background processes running; the adapter turns that off unless you set `lifecycle.idleSeconds`. `inspect()` reports the policy as `idleStop`.

`suspend()` stops the container and `resume()` starts it under the same id. Files are kept; processes end and sockets drop. The lifetime keeps running while suspended and resume does not reset it. Only containers with no mounts and Daytona's auto-delete-after-stop disabled qualify: mounted sandboxes reject `UNSUPPORTED` and enabled auto-delete rejects `UNAVAILABLE`. Suspending an inactive sandbox or resuming a running one rejects `CONFLICT`. See [Renew lifetime](/docs/guides/resources/#renew-lifetime) and [Suspend and resume](/docs/guides/resources/#suspend-and-resume).

## Snapshots and volumes

`box.snapshot()` stops a running sandbox, captures its filesystem, and starts it again (unless `snapshots.restartAfterCapture` is `false`). An already stopped source stays stopped. Processes end; memory and volumes are not captured. If the capture succeeds but the restart fails, the error is `SOURCE_RESTART_FAILED` and still carries the snapshot reference. Snapshots survive their source. Deleting one is refused while a warm pool uses it or warm pools cannot be read.

Volumes are object storage, not POSIX filesystems: no file locking or atomic rename. They attach at create, or when restoring a snapshot taken without mounts, with optional subpaths. Restore with mounts needs `internet` or `daytona-default`; `blocked` rejects. On mounted paths, `writeFile` needs `overwrite: true`; no-clobber writes, stream writes and copy/move destinations reject `UNSUPPORTED` before any change; and a completed write does not guarantee durability at shutdown. See [Snapshots and volumes](/docs/guides/snapshots-and-volumes/).

## Limits

- Creates Daytona refuses map to `INVALID_ARGUMENT` (400, 422), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404) or `RATE_LIMIT` (429) with Daytona's reason; nothing was created. A 409, server error or lost response is `OUTCOME_UNKNOWN`, as is a refused create after an OCI snapshot was built, because that snapshot remains. See [Errors and recovery](/docs/guides/recovery/).
- Command `deadlineSeconds` (default 300) sets Daytona's native timeout. Cleanup of child processes at timeout is not verified, and a lost response does not prove the command stopped. See [Execution and waiting timeouts](/docs/guides/resources/#execution-and-waiting-timeouts).
- A preview token grants full sandbox access, including command execution and files. Treat it as a credential, send it with `redirect: "error"`, and know it cannot be revoked individually; stop/start rotates it. See [Preview access](/docs/guides/preview-access/).
- Public previews, memory suspension and mounted suspension are not supported.
- `sandboxes.list()` only covers sandboxes with Sandbar labels in the configured organization and region; pages can hold fewer items than `limit`.
- `close()` does not stop compute. Snapshots you built from OCI images need separate cleanup.
- Only the Daytona cloud endpoints are trusted by default.

See the [Daytona docs](https://www.daytona.io/docs/), [snapshots](https://www.daytona.io/docs/en/snapshots/), [volumes](https://www.daytona.io/docs/en/volumes/), [wall-clock TTL](https://www.daytona.io/docs/en/sandboxes/#wall-clock-ttl) and the [runnable agent examples](/docs/guides/runnable-agent-examples/).
