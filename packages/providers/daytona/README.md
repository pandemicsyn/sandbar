# Daytona provider (fixture tested; live unverified)

`@sandbar/provider-daytona` implements the current Sandbar resource slice for existing Daytona snapshots. It uses Daytona's v0.218 REST and toolbox APIs through a single-attempt `fetch` transport. It has not made a live provider call or established native conformance. The published `@daytona/sdk@0.218.0` was inspected but is not in this package's runtime graph: its connection retry adapter may replay `DELETE` after a midflight failure, while Sandbar cannot treat an uncertain deletion as effect-free.

## Direct TypeScript

```ts
import { Sandbar, Image } from '@sandbar/sdk/direct';
import { daytonaProvider } from '@sandbar/provider-daytona';

const provider = await daytonaProvider({ apiKey: process.env.DAYTONA_API_KEY!, target: 'us' });
const sandbar = Sandbar.direct({ provider });
const sandbox = await sandbar.sandboxes.create({ environment: Image.prepared('existing-active-snapshot-id'), networkPolicy: 'blocked' });
try {
  const result = await sandbox.exec({ command: { kind: 'shell', script: 'printf ready' } });
  console.log(result.stdoutText());
} finally {
  await sandbox.destroy();
  await sandbar.close();
}
```

`daytonaProvider` performs a read-only `GET /api-keys/current` and binds the returned organization ID, configured target and canonical API endpoint to the direct scope. The credential stays in the caller. Direct mode has process-lifetime operation state; save recovery references before relying on them after a restart. A missing native create candidate is an unknown effect, not permission to create again.

The official Daytona API and toolbox endpoints are trusted by default. For a private Daytona deployment, pass its exact `{ apiUrl, toolboxOrigin }` pair in `trustedEndpoints` when constructing a direct provider. The service host can allow exact pairs with `SANDBAR_DAYTONA_TRUSTED_ENDPOINTS`, a JSON array of those objects. A connection request cannot send an API key to an arbitrary URL by supplying endpoint fields.

## Service connection

Configure `SANDBAR_DB_URL`, `SANDBAR_KEY_FILE` and `SANDBAR_SETUP_TOKEN_FILE`; fake transport variables are optional and only for explicit local tests. In the management UI, add a Daytona connection with its API key and target, then verify. The API accepts `POST /v1/projects/:projectId/provider-connections` with:

```json
{"provider":"daytona","name":"Daytona US","credentials":{"apiKey":"..."},"configuration":{"apiUrl":"https://app.daytona.io/api","toolboxOrigin":"https://proxy.app.daytona.io","target":"us","ttlMinutes":"60"}}
```

The service encrypts these fields before persistence. It rechecks native identity when resolving a connection and rejects a changed organization or API endpoint. To rotate credentials, add and verify a new connection; there is no in-place credential-rotation API. Provider leases only release local transport resources and never delete sandboxes. Daytona's raw `fetch` transport has no provider-owned client to close.

## Current capability boundary

| Area | Current behavior |
|---|---|
| Image | Existing active snapshot ID in the configured region, Linux VM or container. `prepare` is read-only. OCI sources are rejected before mutation because Daytona's `create({image})` implicitly builds a snapshot. |
| Network | `blocked` maps to native `networkBlockAll: true`; other policy names are rejected. The adapter checks this flag and native organization/target in returned sandboxes. |
| Create/recovery | Stable submission ID is used as sandbox name and label. An uncertain create is observed by name; absent evidence remains unknown and is never replayed. |
| Inventory | Paginated read-only results are limited to sandboxes bearing Sandbar submission labels in the verified organization and target with blocked egress. This is not a claim to enumerate every native sandbox in the account. |
| Exec | POSIX shell and argv commands use a quoted shell wrapper with `od` to encode exact stdout and stderr bytes, exit status, and truncation. Requires `sh`, `mktemp`, `mkfifo`, `cat`, `wc`, `head`, `od`, and `rm` in the selected snapshot. There is no durable native execution lookup; a lost response stays unknown. Timeout cancels execution according to Daytona's toolbox API, but Sandbar does not infer remote cancellation from a local abort. |
| Files | Byte download is native. Upload verifies the returned path and reads the bytes back. `overwrite:false` is rejected before upload because native upload has no atomic no-clobber guarantee. Lost uploads stay unknown. |
| Destroy | A single DELETE request is made. Completion requires a matching native ID, organization and `destroyed` state; other outcomes stay unknown. No snapshot or volume cleanup is implied. |

Daytona sandboxes use a 60-minute native TTL by default in this package (configurable to 1–1440 minutes). The live harness fixes it to 15 minutes and attempts explicit cleanup. It is opt-in only: set `SANDBAR_DAYTONA_LIVE=1`, `SANDBAR_DAYTONA_API_KEY`, `SANDBAR_DAYTONA_TARGET`, `SANDBAR_DAYTONA_SNAPSHOT_ID`, and `SANDBAR_DAYTONA_BUDGET_ACK=yes`. The acknowledgement is not an automatic USD spending cap; inspect account pricing and quota before opting in. Do not run this harness as part of ordinary CI.

Sources inspected September 26, 2026: [Daytona TypeScript SDK reference](https://www.daytona.io/docs/en/typescript-sdk/), [Process reference](https://www.daytona.io/docs/en/typescript-sdk/process/), [platform OpenAPI v0.218](https://www.daytona.io/docs/openapi.json), [toolbox OpenAPI v0.218](https://www.daytona.io/docs/toolbox-openapi.json), and published `@daytona/sdk@0.218.0` source. This is fixture-tested integration, not a claim of live correctness.
