---
title: Runloop
description: Use the Runloop adapter for Devboxes with blocked egress, disk snapshots, suspend/resume and previews.
---

The `@sandbar-sdk/runloop` package implements the public Sandbar adapter interface for [Runloop](https://runloop.ai) Devboxes. Install it with `npm install sandbar-sdk @sandbar-sdk/runloop`; it is experimental, and Runloop sign-ups are currently by invitation only. Use Node 20+ or Bun. It calls the Runloop REST API v1 (`https://api.runloop.ai`) directly, with no native SDK dependency.

```ts
import { Sandbar } from "sandbar-sdk";
import { runloopAdapter } from "@sandbar-sdk/runloop";

const client = await Sandbar.connect({
  adapter: runloopAdapter,
  credentials: { apiKey: process.env.RUNLOOP_API_KEY! },
  config: { network: "blocked" },
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

Create an API key in the Runloop dashboard. `connect` verifies it with `GET /v1/accounts/me`, requires an enabled account, and scopes everything to that account id.

## Setup

| Setting                     | Default           | Notes                                                                                                                                                                                                                                      |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `network`                   | `blocked`         | `blocked` attaches a deny-all account network policy named `sandbar-blocked`, created on first use and re-checked before each create. `internet` attaches no policy. Allowlists are unsupported.                                           |
| `image`                     | `runloop-default` | Runloop's default Devbox image. Any other value is a blueprint id (when one exists) or a blueprint name. OCI images and image builds are unsupported.                                                                                      |
| `resources`                 | Runloop default   | Minimum `{ vcpus, memoryMiB }`. Picks the smallest of `X_SMALL` (0.5 vCPU, 1 GiB), `SMALL` (1, 2 GiB), `MEDIUM` (2, 4 GiB), `LARGE` (2, 8 GiB), `X_LARGE` (4, 16 GiB), `XX_LARGE` (8, 32 GiB), or a custom 16 vCPU size with 32 or 64 GiB. |
| `lifecycle.lifetimeSeconds` | 900               | 60 seconds to 48 hours. Runloop shuts the Devbox down when the time is up. `create({ lifecycle })` can override it per sandbox unless `idleSeconds` is set.                                                                                |
| `lifecycle.idleSeconds`     | none              | Suspend after this many idle seconds instead of using a fixed lifetime. Set either this or `lifetimeSeconds`, not both.                                                                                                                    |
| `preview.access`            | `protected`       | `protected` previews need the returned `X-Runloop-Tunnel-Authorization` header. `public` URLs are open to anyone who has them.                                                                                                             |
| `snapshots.preserve`        | `filesystem`      | Runloop snapshots keep the disk only; `Preserve.FILESYSTEM_AND_MEMORY` rejects `UNSUPPORTED` at connect.                                                                                                                                   |

Create-time `env` is sent as Runloop environment variables. `region`, `labels` and mounts are rejected.

## What works

Everything below is tested against a simulated Runloop API on every change. **No live Runloop run has been made yet.**

| Feature           | Support                                                                                                                                                     | Live tested |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Compute lifecycle | Create, inspect, inventory, `sandboxes.list()`, reference reopening, and destroy by confirmed shutdown.                                                     | No          |
| Commands          | argv and shell, with `cwd` and `env`; exact stdout/stderr bytes up to 1 MiB per stream; finite byte stdin; deadlines up to an hour.                         | No          |
| Streaming output  | Live stdout/stderr as UTF-8 text from Runloop's log streams; stop with `terminate()`. No byte output.                                                       | No          |
| Files             | Binary read and overwrite write up to 64 MiB. No-clobber writes are unsupported.                                                                            | No          |
| Suspend/resume    | `suspend()` keeps the disk; `resume()` starts fresh processes. Memory and connections are not kept.                                                         | No          |
| Snapshots         | `snapshot()` captures the disk while the Devbox keeps running; `restore()` creates a new Devbox from it; list, inspect and delete.                          | No          |
| Previews          | `preview(port)` returns the Devbox tunnel URL for that port, created with the Devbox.                                                                       | No          |
| Unsupported       | OCI images and image builds, volumes, mounts, egress allowlists, renewal, piped input, byte streaming, terminals, directory operations, regions and labels. | —           |

## How streamed commands work

`processes.start({ output: { mode: "stream" } })` starts the command with Runloop's `execute`, with no deadline and stdin from `/dev/null`. Output comes from Runloop's server-sent `stream_stdout_updates` and `stream_stderr_updates` endpoints as UTF-8 text with byte offsets; a stream that closes while the command is still running, or a dropped connection, is reopened from its offset. Exit comes from Runloop's status long-poll. If the log streams have not closed 10 seconds after exit, the output is reported incomplete. Byte output (`format: "bytes"`) and callback exec are not supported. `terminate()` kills the execution through Runloop; `detach()` leaves it running.

## How commands keep bytes and arguments

Runloop runs one shell string and returns stdout/stderr as text. To keep argv as separate arguments and output as exact bytes, the adapter sends a small POSIX `sh` wrapper: arguments are single-quoted, the command's stdout and stderr go to private files under `/tmp`, and the wrapper prints one record with the exit code and byte counts. Results of 32 KiB or less come back inline as base64; larger results are downloaded as binary files and the guest directory is removed afterwards. Finite stdin is uploaded to a `/tmp/sandbar-stdin-*` file first. Your image needs `sh`, `mktemp`, `base64`, `head`, `wc`, `tr` and `env`.

A command that passes its deadline is killed through Runloop and reported as `OUTCOME_UNKNOWN`.

## Destroy, snapshots and recovery

`destroy()` shuts the Devbox down and waits for the `shutdown` status. Runloop refuses shutdown while a disk snapshot is in progress; that is reported as `CONFLICT`. Snapshots survive their source.

Sandbar sends each mutation once and the adapter adds no retries. Creates and snapshot captures carry `sandbar_operation` and `sandbar_submission` metadata, so a create or capture whose response was lost is found by that marker instead of being resent. A refusal Runloop answers with a 4xx is reported as that error; a lost response or 5xx is `OUTCOME_UNKNOWN`. A lost or failed command result is never replayed. Listed Devboxes and snapshots not created through this connection report `ownership: "unknown"`.

See the [provider research issue](https://github.com/pandemicsyn/sandbar/issues/47) and the [Runloop API reference](https://docs.runloop.ai/docs/api-reference).
