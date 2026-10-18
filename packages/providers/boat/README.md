# @sandbar-sdk/boat

Experimental external Boat adapter for Sandbar. Implementation and offline fixtures are available; no live Boat run has been made yet. Install with `npm install sandbar-sdk @sandbar-sdk/boat`. Requires Node 20+ or Bun and a Boat API key. Native SDK pinned to `@boatdev/sdk@1.9.9` (Boat Public API v1).

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
  } finally { await box.destroy(); }
} finally { await client.close(); }
```

Scope is the account id from `GET /me` plus the fixed `https://boat.dev/api/v1` endpoint. References hold the sandbox id and scope, never the API key.

## Setup defaults

| Setting | Behavior |
| --- | --- |
| `network` | Required literal `internet`. Boat has no provider egress controls. |
| `image` | `ubuntu-24.04` (stock machine), a named snapshot, or a `bsh_` share code. No OCI images. |
| `machine` | `default`; also `small`, `large`, `xlarge`. |
| `environment` | Omitted: `noEnv`, so sandboxes get none of the account's secrets. Set a Boat environment name to attach one. |
| `lifecycle.lifetimeSeconds` | 900; 60 s to 30 days. Expiry archives the sandbox. |

## Behavior

- **Create** sends the Sandbar submission id as `Idempotency-Key` and waits for `ready`/`idle`/`running`.
- **Exec** supports argv and shell, `cwd`, `env`, finite stdin and deadlines up to 600 s. A small `sh` wrapper keeps arguments quoted and returns stdout/stderr as base64, so bytes survive Boat's UTF-8 text channel. Output is bounded to 1 MiB per stream.
- **Files** read and overwrite up to 5 MiB under `/home/user` or `/tmp`, as base64. No-clobber writes are unsupported.
- **Suspend/resume** maps to Boat stop (archive the disk) and resume (fresh machine). Memory and processes are not kept.
- **Renew** sets a new auto-stop window.
- **Destroy** permanently deletes with `X-Ascii-Confirm-Delete` and waits for the deletion operation to finish removing the machine. Named snapshots survive.
- Unsupported: snapshots, volumes, previews, interactive processes, directory operations, blocked egress, regions and labels.

Every mutation is sent once. Refusals Boat documents as effect-free become ordinary errors; lost responses and ambiguous 5xx become `OUTCOME_UNKNOWN` and are never replayed.

See the [provider page](https://sandbarsdk.dev/docs/providers/boat/) and the [research issue](https://github.com/pandemicsyn/sandbar/issues/40).
