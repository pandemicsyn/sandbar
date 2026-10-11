# @sandbar-sdk/vercel

Official Vercel Sandbox adapter for Sandbar, installed separately as `@sandbar-sdk/vercel`. Implements disposable session creation, inspect, inventory, bounded execution, binary files and confirmed compute stop. Live provider behavior is unverified; deterministic fixtures and packed consumer checks are separate from live qualification. This source does not establish npm publication.

Install `sandbar-sdk` and `@sandbar-sdk/vercel` when available from your package source:

```ts
import { Sandbar } from "sandbar-sdk";
import { vercel } from "@sandbar-sdk/vercel";

const client = await Sandbar.connect({
  adapter: vercel,
  config: {
    teamId: process.env.SANDBAR_VERCEL_TEAM_ID!,
    projectId: process.env.SANDBAR_VERCEL_PROJECT_ID!,
    region: "iad1",
    timeoutSeconds: 300,
    networkPolicy: "vercel-deny-all",
  },
  credentials: { token: process.env.VERCEL_TOKEN! },
});
try {
  const box = await client.sandboxes.create();
  try {
    await box.writeFile("/tmp/example.bin", new Uint8Array([0, 255, 129]), { overwrite: true });
    console.log(await box.readFile("/tmp/example.bin"));
    console.log((await box.exec(["node", "-e", "console.log('ready')"])).stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

`Sandbar.connect` verifies the team and project ownership with authenticated reads and checks project sandbox access. Scope includes the verified team ID, project ID and region. Tokens stay in credentials. Importing the adapter and constructing a connection definition perform no provider IO. The transport uses source-derived Vercel API routes audited from published SDK 3.6.1, with single-attempt requests (see [native boundary provenance](NATIVE.md)); `createVercelAdapter` accepts host-owned transport injection for deterministic fixtures.

| Configuration | Requirement/default |
| --- | --- |
| `teamId`, `projectId` | Required existing team and project IDs; matching ownership is verified. |
| `region` | `iad1` only, also the default. |
| `timeoutSeconds` | 60–300 seconds; defaults to 300. |
| `networkPolicy` | `vercel-deny-all` by default; `vercel-allow-all` is the alternative. |
| `credentials.token` | Required Vercel bearer token with team/project sandbox access. |

Calling `client.sandboxes.create()` uses the managed prepared environment `vercel/sandbox/node:24` and the connection's configured named network policy. Explicit creation inputs may select that same environment and policy; other image or policy values reject before allocation. Policies map to native `deny-all` or `allow-all`; acknowledgement is checked against the requested policy. Measured egress isolation has not been live-qualified. Generic `blocked`/`internet`, arbitrary images, OCI builds, regions other than `iad1`, resource requirements and mounts reject before creation. Sandboxes use two vCPUs, no exposed ports and `persistent:false`.

Each handle binds the exact native session ID, rather than a reusable sandbox name or its latest session. Destroy stops and polls that original session until native `stopped` or `aborted` confirms compute termination. It reports `vercel-named-sandbox-metadata` as retained resources. The adapter does not delete that metadata or claim full resource deletion. Inventory includes nonpersistent sessions in the configured region; it is not a discovery mechanism for an unacknowledged create. The native timeout is fallback, not a cleanup receipt. Closing a client releases owned transport resources and local waits; destroy each sandbox explicitly.

Commands preserve argv as JSON data; shell scripts run through `/bin/sh -c`. Working directory, environment, exit status and bounded binary stdout/stderr are supported. A Node capture helper stores a private base64 receipt, avoiding native text-log conversion of guest output. Combined output is capped at 1 MiB and reports truncation. Command deadlines kill the helper's child process group; aborting a local request does not prove remote termination. No stdin, streaming process handles, interactive execution or PTYs are exposed. Temporary capture receipts remain in the disposable session until compute cleanup.

Files use absolute file paths without trailing slashes or `.`/`..` segments and a 1 MiB read/write limit. Reads consume binary API bodies; writes upload binary gzip/tar archives. Writes require `overwrite:true`; atomic no-clobber is unsupported and rejects before mutation. There is no text conversion of file contents.

Create acknowledgements checkpoint the immutable session ID for read-only recovery. A lost response before that ID is available cannot be reconciled through inventory or tags; preserve the saved attempt and treat its outcome as unknown. Acknowledged commands checkpoint their original command/session IDs and can recover the saved receipt through read-only observation without replay. A lost launch acknowledgement has no command ID to recover. Writes have no reconciliation token and cannot be safely replayed after uncertainty. Destroy observation checks the same session without issuing another stop. Absence does not prove compute termination. Fresh connections require current credentials and matching team/project/region scope; session membership is verified through project session reads before accessing a reopened session.

Save the ordinary sandbox reference in trusted application storage, then reopen the same session on a fresh connection with current credentials:

```ts
const box = await client.sandboxes.create();
if (!box.reference) throw new Error("Verified sandbox reference is unavailable");
await save(box.reference); // Application-owned persistence.
// After opening freshClient with the original team/project/region:
const reopened = await freshClient.sandboxes.get(await load());
console.log((await reopened.inspect()).state);
```

`save` and `load` represent your application's trusted reference store. `get` reads the original identity without creating, resuming or renewing compute. Reopened membership lookup is bounded to 100 pages of 100 sessions; an identity outside that window fails closed. Saved operation references remain useful for uncertain submitted operations and read-only reconciliation; they are separate from the sandbox's resource reference.

Snapshot capture/restore, memory preservation, persistent sandboxes, volumes, mounts, suspension, resumption and lifetime renewal are unsupported. No capture scope, source lifecycle or restored execution guarantee applies; unsupported requirements reject before effects. No storage cleanup or metadata deletion is emulated.

The external qualification profile is `packages/sdk-qualification/provider-qualification/vercel-profile.ts`. It pins the REST boundary to v3 creation/v2 sessions, saves only nonsecret routing, and caps native lifetime at 300 seconds, exercise at 120 seconds and cleanup at 60 seconds. Ordinary baseline tests allocate at most one compute instance per fixture; snapshot/volume suites skip declared unsupported workflows. The existing paired network suite is E2B-specific and does not qualify these named policies. Loading a profile performs no IO. Live calls require separate authorization, a concrete allocation budget and the normal persistent cleanup ledger; no live calls were used to create these docs.

Declared support and the empty live record are rendered in [qualification/support.md](qualification/support.md) and [qualification/live-qualification.md](qualification/live-qualification.md). Regenerate from the repository root without provider IO:

```sh
bun packages/sdk-qualification/provider-qualification/render.ts \
  --profile packages/sdk-qualification/provider-qualification/vercel-profile.ts \
  --results packages/providers/vercel/qualification/results \
  --output packages/providers/vercel/qualification
```

Append `--check` to verify drift. The empty results file intentionally supplies no fabricated fixture or live observations.
