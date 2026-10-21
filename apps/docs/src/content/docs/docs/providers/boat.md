---
title: Boat
description: Use the Boat adapter for full Ubuntu VMs with commands, files, archive/resume and renewal.
---

The `@sandbar-sdk/boat` package implements the public Sandbar adapter interface for [Boat](https://boat.dev). Install it with `npm install sandbar-sdk @sandbar-sdk/boat`; it is experimental. Use Node 20+ or Bun. Native SDK version: `@boatdev/sdk@1.9.9`, Boat Public API v1.

```ts
import { Sandbar } from "sandbar-sdk";
import { boatAdapter } from "@sandbar-sdk/boat";

const client = await Sandbar.connect({
  adapter: boatAdapter,
  credentials: { apiKey: process.env.BOAT_API_KEY! },
  config: { network: "internet" },
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

Create an API key in the Boat dashboard. `connect` verifies it with `GET /me` and scopes everything to that account id. Sandboxes made by other members of a Boat organization are outside the scope: inspect, reopen and inventory reject or skip them.

## Setup

| Setting                     | Default        | Notes                                                                                                                                                                                             |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`                   | required       | Must be `"internet"`. Boat has no provider-level egress controls, so blocked or allowlisted creates fail before anything is allocated.                                                            |
| `image`                     | `ubuntu-24.04` | Boat's stock Ubuntu 24.04 machine. Any other value is a Boat named snapshot (`my-base`) or a `bsh_` share code, sent as `from`. OCI images are unsupported.                                       |
| `resources`                 | `default` type | Minimum `{ vcpus, memoryMiB }`. Picks the smallest of `small` (2 vCPU, 4 GiB), `default` (4, 8 GiB), `large` (8, 16 GiB) or `xlarge` (16, 32 GiB; plan-dependent). Deprecated alias: `machine`.   |
| `environment`               | none           | Name of a Boat environment to attach. **Omitted, sandboxes start with `noEnv`: none of your account's variables, secret files or logins.** Name an environment only for code you trust with them. |
| `lifecycle.lifetimeSeconds` | 900            | 60 seconds to 30 days. Boat archives (not deletes) the sandbox when it expires; `renew()` moves the deadline. The timer counts from create or resume, not from activity.                          |

Boat runs sandboxes in the EU (Germany, Finland, France) and does not let you pick a region, so `region` and `labels` are rejected. Mounts, snapshot requirements and image builds are unsupported.

## What works

Everything below is tested on every change, using the real Boat client against a simulated API. **No live Boat run has been made yet.**

| Feature           | Support                                                                                                                                                 | Live tested |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Compute lifecycle | Create with an `Idempotency-Key`, inspect, inventory, reference reopening, and destroy by permanent delete with confirmed teardown.                     | No          |
| Commands          | argv and shell, with `cwd` and `env`; exact stdout/stderr bytes up to 1 MiB per stream; finite byte stdin; deadlines up to 600 seconds.                 | No          |
| Streaming output  | Live stdout/stderr as UTF-8 text from detached commands, with no 600-second cap; stop with `terminate()`. No byte output.                               | No          |
| Files             | Binary read and overwrite write up to 5 MiB, under `/home/user` or `/tmp`. No-clobber writes are unsupported.                                           | No          |
| Suspend/resume    | `suspend()` archives the disk and stops the machine; `resume()` restores the disk onto a fresh machine. Memory, processes and connections are not kept. | No          |
| Renewal           | `renew()` sets a new auto-stop window of 60 seconds to 30 days.                                                                                         | No          |
| Unsupported       | Snapshots, volumes, previews, piped input, byte streaming, terminals, directory operations, blocked egress, regions and labels.                         | —           |

## How streamed commands work

`processes.start({ output: { mode: "stream" } })` starts the command detached, so Boat's 600-second limit does not apply, then follows `GET /commands/{processId}/stream`. Boat sends output there as UTF-8 text with byte offsets, and ends each connection after 10 minutes with a reconnect line; the adapter reattaches from those offsets, so nothing is lost or repeated. A dropped connection is reattached for up to 60 seconds. Invalid UTF-8 in the command's output is replaced by Boat, so byte output (`format: "bytes"`) and callback exec are not supported. Stdin is `/dev/null`. `terminate()` stops the command through Boat's stop endpoint; `detach()` leaves it running.

## How commands keep bytes and arguments

Boat runs one shell string and returns stdout/stderr as UTF-8 text. To keep argv as separate arguments and output as exact bytes, the adapter sends a small POSIX `sh` wrapper: arguments are single-quoted, the command's stdout and stderr go to private files under `/tmp`, and the wrapper returns the exit code, the byte counts and base64 of each stream (bounded in the guest). Finite stdin is uploaded to a `/tmp/sandbar-stdin-*` file first and removed after the command. Your image needs `sh`, `mktemp`, `base64`, `head`, `wc` and `env`, which the stock Ubuntu machine has.

Shell commands run as `/bin/sh -c`, as Boat's `user` account. A command that hits its deadline is stopped by Boat and reported as `OUTCOME_UNKNOWN`, because its output is not returned.

## Destroy, suspend and recovery

`destroy()` permanently deletes the sandbox and its automatic snapshots with `DELETE /sandboxes/{id}` and the `X-Ascii-Confirm-Delete` header, then waits for Boat's deletion operation to finish removing the machine. Named snapshots survive, because Boat keeps them independent of their source.

`suspend()` is Boat's stop: it saves the disk first and is refused if that save fails, leaving the sandbox running. An archived sandbox uses no machine time; Boat keeps its disk free for 14 days.

Sandbar sends each mutation once; the generated client and the adapter add no retries, and the SDK's convenience helpers that resend commands are not used. Create sends the Sandbar submission id as Boat's `Idempotency-Key`. A refusal Boat documents as having no effect (4xx, `retryable: true`, `sandbox_restoring`, or `503 no_ready_machine`/`out_of_capacity`) is reported as that error. A lost response, `409 idempotency_in_progress` or another 5xx is `OUTCOME_UNKNOWN`. A lost or failed command result is never replayed, because Boat documents commands as not idempotent.

If provisioning outlasts the in-call wait, the sandbox id is already saved and Sandbar finishes by reading its state. If a create ends `cancelled` or `error`, the error's `outcome.sandbox` holds the reference so you can inspect or destroy it.

See the [provider research issue](https://github.com/pandemicsyn/sandbar/issues/40), [Boat API docs](https://docs.boat.dev/api/v1) and [TypeScript SDK docs](https://docs.boat.dev/sdks/typescript).
