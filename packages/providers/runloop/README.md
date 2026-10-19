# @sandbar-sdk/runloop

Experimental external Runloop adapter for Sandbar. Runloop sign-ups are currently by invitation only. Implementation and offline fixtures are available; no live Runloop run has been made yet. Install with `npm install sandbar-sdk @sandbar-sdk/runloop`. Requires Node 20+ or Bun and a Runloop API key. Calls the Runloop REST API v1 directly, with no native SDK dependency.

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
  } finally { await box.destroy(); }
} finally { await client.close(); }
```

Scope is the account id from `GET /v1/accounts/me` plus the fixed `https://api.runloop.ai` endpoint. References hold the Devbox id and scope, never the API key.

## Setup defaults

| Setting | Behavior |
| --- | --- |
| `network` | `blocked` (default) attaches a managed deny-all network policy named `sandbar-blocked`; `internet` attaches none. |
| `image` | `runloop-default` (no blueprint), or a blueprint id or name. No OCI images. |
| `resources` | Optional minimum `{ vcpus, memoryMiB }`; picks the smallest Runloop size from `X_SMALL` (0.5 vCPU, 1 GiB) to `XX_LARGE` (8, 32 GiB), then a custom 16 vCPU size with 32 or 64 GiB. `inspect().resources` reports the size. |
| `lifecycle.lifetimeSeconds` | 900; 60 s to 48 h. Expiry shuts the Devbox down. |
| `lifecycle.idleSeconds` | Suspend after this idle time instead of a fixed lifetime. Not combined with `lifetimeSeconds`. |
| `preview.access` | `protected` (default) previews need the returned auth header; `public` URLs are open. |

## Behavior

- **Create** sends `sandbar_operation`/`sandbar_submission` metadata, a tunnel and create-time `env`, then waits for `running`. A lost response is recovered by finding the marker, never by resending.
- **Exec** supports argv and shell, `cwd`, `env`, finite stdin and deadlines up to an hour. A small `sh` wrapper keeps arguments quoted; results up to 32 KiB return inline as base64 and larger ones are downloaded as bytes. Output is bounded to 1 MiB per stream. Deadline overruns kill the execution and report `OUTCOME_UNKNOWN`.
- **Files** read and overwrite up to 64 MiB. No-clobber writes are unsupported.
- **Suspend/resume** keeps the disk only; resume starts fresh processes.
- **Snapshots** capture the disk asynchronously while the Devbox keeps running; restore creates a new Devbox. List, inspect and delete are supported.
- **Preview** returns the tunnel URL for a port.
- **Destroy** shuts the Devbox down and confirms the `shutdown` status. Snapshots survive.
- Unsupported: OCI images and image builds, volumes, mounts, egress allowlists, renewal, interactive processes, directory operations, regions and labels.

Every mutation is sent once. 4xx refusals become ordinary errors; lost responses and 5xx become `OUTCOME_UNKNOWN` and are never replayed.

See the [provider page](https://sandbarsdk.dev/docs/providers/runloop/) and the [research issue](https://github.com/pandemicsyn/sandbar/issues/47).
