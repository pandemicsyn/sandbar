---
title: E2B
description: Use the E2B adapter for template-based sandboxes with commands, files, streaming, pause/resume, snapshots and public previews.
---

The `@sandbar-sdk/e2b` package runs Sandbar sandboxes on [E2B](https://e2b.dev) through the pinned `e2b@2.51.0` client. Install it with `npm install sandbar-sdk @sandbar-sdk/e2b`; it is a supported provider. Use Node 20+ or Bun.

```ts
import { Sandbar } from "sandbar-sdk";
import { e2b } from "@sandbar-sdk/e2b";

const client = await Sandbar.connect(
  e2b({ apiKey: process.env.E2B_API_KEY!, lifecycle: { lifetimeSeconds: 600 } }),
);

try {
  const box = await client.sandboxes.create();
  try {
    await box.exec(["/bin/sh", "-c", "printf ready"]);
    await box.renew();
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

Set `E2B_API_KEY` on the server. `E2B_API_ID` is not required and is not a team ID. Without `teamId`, `connect` verifies the key with an authenticated read and scopes everything to that key, so rotating the key changes the scope. With `teamId`, it verifies the team instead, and you can rotate keys within that team without losing access to saved references.

## Setup

| Setting                     | Default   | Notes                                                                                                                                                                       |
| --------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                    | required  | E2B API key.                                                                                                                                                                |
| `teamId`                    | none      | Verified team scope. Needed to rotate keys and still reopen saved sandboxes and snapshots.                                                                                  |
| `templateId`                | `base`    | E2B's public `base` template, or an owned template ID or name. Names must be untagged or use `:default`; other tags and public aliases are unsupported.                     |
| `network`                   | `blocked` | `blocked` or `internet`, mapped to E2B's internet-access setting. Deprecated alias: `networkPolicy` (set one, not both). See [network and previews](#network-and-previews). |
| `timeoutSeconds`            | 900       | Native sandbox lifetime, 60 to 86,400 seconds. E2B kills the sandbox when it expires.                                                                                       |
| `lifecycle.lifetimeSeconds` | none      | Initial lifetime and default `renew()` window, up to 86,400 seconds; values under 60 become 60. Set this or `timeoutSeconds`, not both.                                     |
| `lifecycle.suspension`      | none      | `{ preserve: Preserve.FILESYSTEM }` pauses without memory, so resume cold-boots. Default `Preserve.FILESYSTEM_AND_MEMORY` keeps memory and processes.                       |
| `snapshots`                 | none      | `{ preserve: Preserve.FILESYSTEM }` captures disk only and restores with fresh processes. Default `Preserve.FILESYSTEM_AND_MEMORY` captures memory too.                     |
| `preview.access`            | `public`  | `public` opens the sandbox to inbound traffic. `protected` keeps it closed, and `preview()` then rejects `UNSUPPORTED`.                                                     |
| `resources`                 | none      | Minimum `{ vcpus, memoryMiB }`. OCI images are built at that size; a prepared template must already meet it, so `base` is rejected.                                         |

`create({ env })` sets E2B's sandbox environment, which applies to every command and process, including after reopening; per-call `env` overrides a name. Values are not saved in recovery references and are redacted from E2B error text. `labels` are stored as E2B metadata; Sandbar's reserved keys reject `INVALID_ARGUMENT`. A per-call `environment` (image) overrides `templateId` for that call, and an invalid or unavailable override never falls back to `base`. `region` and mounts reject `UNSUPPORTED`.

## What works

| Feature                      | Support                                                                                         | Live tested |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ----------- |
| Sandbox lifecycle            | Create, inspect and destroy.                                                                    | Yes         |
| Reconnect later              | `get(reference)` reopens the same sandbox without waking or extending it.                       | Yes         |
| Lifetime renewal             | `renew()` resets the deadline, 60 to 86,400 seconds.                                            | Yes         |
| Pause and resume             | Memory pause keeps files, memory and processes; sockets drop.                                   | Yes         |
| Commands                     | argv and Bash scripts, `cwd`, `env`, binary output up to 1 MiB per stream.                      | Yes         |
| Streaming and terminals      | `processes.start()` text and byte streams, incremental input, SIGTERM/SIGKILL, PTYs and resize. | Yes         |
| Command input                | Finite stdin up to 1 MiB, staged as a file under `/tmp`.                                        | No          |
| Files                        | Binary read, overwrite and no-clobber writes; byte streams for large files.                     | Yes         |
| Directories                  | List, stat, mkdir, remove, copy, move, walk and text lines.                                     | Yes         |
| HTTP previews                | Public URLs only.                                                                               | Yes         |
| Images                       | Owned templates and OCI builds; get, list and delete templates.                                 | No          |
| Network controls             | `blocked` or `internet`; blocking is not reliable.                                              | Failed      |
| Snapshots                    | Filesystem, memory and process capture; restore into new compute; inspect and delete.           | Yes         |
| Volumes and mounts           | Volume create, inspect, list and delete (E2B private beta). Mounts not supported.               | No          |
| Listing sandboxes and images | Sandboxes created by this Sandbar scope; all team templates.                                    | No          |

Live results cover the tested image, region and network setting; see [Provider support](/docs/providers/support/).

## Network and previews

`network: "blocked"` sets E2B's internet access off. Do not rely on it for isolation: in the live test a blocked sandbox resolved no hostnames but could still open a direct IPv4 TCP connection (to `1.1.1.1:443`). Restored snapshots keep the same weakness. See [select a network policy](/docs/guides/images-and-networking/#select-a-network-policy).

Previews are public by default. A public sandbox accepts inbound traffic from the moment it is created or restored, before you call `preview()`, and anyone with the URL `https://<port>-<sandbox-id>.e2b.app` can reach that port. `preview()` requires running compute with auto-resume off. With `preview.access: "protected"`, sandboxes are created closed to inbound traffic, but the adapter cannot fetch E2B's access token, so `preview()` rejects instead of falling back to public. Denial of inbound traffic in protected mode has not been live-tested. See [public access with E2B](/docs/guides/preview-access/#public-access-with-e2b).

## Commands and files

Shell scripts run under Bash. Exec's `deadlineSeconds` defaults to 300 and sets E2B's RPC timeouts: it limits how long Sandbar waits, not how long the command runs, so a command can continue after the deadline. An abort `signal` also stops only local waiting. Neither kills the process nor changes the sandbox lifetime; see [execution and waiting timeouts](/docs/guides/resources/#execution-and-waiting-timeouts). Process termination does not guarantee that child processes stop.

Files were live-tested in `/home/user` on `base`; an overwrite directly in the sticky `/tmp` directory failed, so check other paths and custom templates yourself. Buffered reads and writes default to 1 MiB and accept `maxBytes` up to 16 MiB; use byte streams for larger files. Your template needs:

- GNU `ln -T` and hard-link support for no-clobber writes.
- Linux and Python 3 for directory listing, stat and race-safe removal. The adapter installs nothing.
- Linux libc `renameat2` for no-clobber moves.
- envd 0.5.7 or newer for streamed uploads, and 0.5.2 or newer for incremental process input.

See [files and output](/docs/guides/files-and-output/).

## Lifetime, pause and snapshots

Renewal, pause and resume need running compute that Sandbar created with kill-on-timeout and auto-resume off. If that policy is missing or was changed outside Sandbar, they reject `UNAVAILABLE`. `renew()` sets a new deadline from now; it is not additive and can shorten a longer one. E2B enforces lower plan limits itself (Hobby allows one hour). Reopening never applies the connection's lifetime unless you call `renew()`.

`suspend()` uses E2B's memory pause, or a filesystem-only pause with `lifecycle.suspension: { preserve: Preserve.FILESYSTEM }`. Paused sandboxes are kept indefinitely, so destroy them explicitly. `resume()` restarts the clock with the current connection's configured lifetime. `get()`, `inspect()`, exec and files never resume a paused sandbox. Sandboxes with E2B volume mounts cannot be suspended (`UNSUPPORTED`). Suspending an already paused sandbox or resuming a running one rejects `CONFLICT`. See [suspend and resume](/docs/guides/resources/#suspend-and-resume).

`snapshot()` uses E2B's native capture and needs envd 0.5.0 or newer. By default it captures memory: it briefly pauses the source, which drops active connections, then resumes it. Configure `snapshots: { preserve: Preserve.FILESYSTEM }` for a filesystem-only capture; restored sandboxes then boot fresh. A call requirement that differs from the configured depth rejects before anything changes. Restore uses the exact captured build, never a newer `default` build. Each snapshot lives in its own E2B template; deleting it removes that template after checking that nothing else shares it. See [snapshots and volumes](/docs/guides/snapshots-and-volumes/).

Destroy each sandbox, then close the client; the native timeout is only a fallback. Snapshot templates and templates built from OCI images survive sandbox destruction and need `snapshots.delete()` or `images.delete()`. `images.delete()` only removes a private template with one build, no other alias, no snapshot and no listed sandbox using it; anything else rejects `CONFLICT` before E2B is called.

## Limits

- `network: "blocked"` did not stop direct IPv4 connections in the live test.
- Previews are public only; protected mode cannot return a preview.
- No region selection and no Sandbar volume mounts. Live volume creation was refused (HTTP 403) for the tested account.
- `sandboxes.list()` returns only sandboxes this binding created, so a page can hold fewer items than `limit`. Paused sandboxes list as `suspended`. Image listings cover all team templates with unknown ownership.
- Saved references hold no credentials. Reopen with the same template and the same key, or the same `teamId`.
- A refused create maps HTTP 400 to `INVALID_ARGUMENT`, 401 to `UNAUTHENTICATED`, 403 to `FORBIDDEN`, 404 to `NOT_FOUND` and 429 (including the concurrent sandbox limit) to `RATE_LIMIT`; nothing was created. Server errors, lost responses and refusals after an OCI build (the template remains) are `OUTCOME_UNKNOWN`; see [recovery](/docs/guides/recovery/).

See [E2B sandbox lifecycle](https://docs.e2b.dev/sandbox), [persistence](https://docs.e2b.dev/sandbox/persistence), [snapshots](https://docs.e2b.dev/sandbox/snapshots), [volumes](https://docs.e2b.dev/volumes/manage) and the [compiled suspend/resume example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-suspend-resume.ts).
