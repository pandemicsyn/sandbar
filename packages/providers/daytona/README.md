# Daytona provider (fixture tested; live unverified)

`@sandbar/provider-daytona` implements the current Sandbar resource slice for existing Daytona snapshots. It uses Daytona's v0.218 REST and toolbox APIs through a single-attempt `fetch` transport. It has not made a live provider call or established native conformance. The published `@daytona/sdk@0.218.0` was inspected but is not in this package's runtime graph: its connection retry adapter may replay `DELETE` after a midflight failure, while Sandbar cannot treat an uncertain deletion as effect-free.

## Direct TypeScript

```ts
import { Sandbar, Image } from 'sandbar-sdk/direct';
import { daytonaAdapter } from '@sandbar/provider-daytona';

const sandbar = await Sandbar.connect({
  adapter: daytonaAdapter,
  config: { target: 'us' },
  credentials: { apiKey: process.env.DAYTONA_API_KEY! },
});
const sandbox = await sandbar.sandboxes.create({ environment: Image.prepared('existing-active-snapshot-id'), networkPolicy: 'blocked' });
try {
  const result = await sandbox.exec({ command: { kind: 'shell', script: 'printf ready' } });
  console.log(result.stdoutText());
} finally {
  await sandbox.destroy();
  await sandbar.close();
}
```

`Sandbar.connect` performs read-only `GET /api-keys/current` and `GET /regions` calls. It requires the target to match exactly one available native region ID, then binds that ID, the verified organization ID and canonical API endpoint to the direct scope. A missing or explicitly foreign target is a configuration error; an unreadable or inconsistent region listing remains a provider verification failure. Before advertising or preparing `blocked` creation, the driver reads `GET /organizations/{verifiedOrganizationId}` and requires a matching ID and `sandboxLimitedNetworkEgress: false`. Missing, restricted, malformed or unreadable responses disable blocked creation; existing-resource cleanup remains available. This check is repeated in `prepare` before submission, so a prior capability result is not treated as lasting permission. The credential stays in the caller. Direct mode has process-lifetime operation state; save recovery references before relying on them after a restart. A missing native create candidate is an unknown effect, not permission to create again. The special `earth` GPU region is not returned by the region listing and is outside this adapter's supported target set.

The official Daytona API and toolbox endpoints are trusted by default. For a private Daytona deployment, pass its exact `{ apiUrl, toolboxOrigin }` pair in `trustedEndpoints` when constructing `createDaytonaAdapter`. The service host can allow exact pairs with `SANDBAR_DAYTONA_TRUSTED_ENDPOINTS`, a JSON array of those objects. A connection request cannot send an API key to an arbitrary URL by supplying endpoint fields.

## Service connection

Configure `SANDBAR_DB_URL`, `SANDBAR_KEY_FILE` and `SANDBAR_SETUP_TOKEN_FILE`; fake transport variables are optional and only for explicit local tests. In the management UI, add a Daytona connection with its API key and target, then verify. The API accepts `POST /v1/projects/:projectId/provider-connections` with:

```json
{"provider":"daytona","name":"Daytona US","credentials":{"apiKey":"..."},"configuration":{"apiUrl":"https://app.daytona.io/api","toolboxOrigin":"https://proxy.app.daytona.io","target":"us","ttlMinutes":60}}
```

The service encrypts these fields before persistence. It rechecks native identity when resolving a connection and rejects a changed organization or API endpoint. To rotate credentials, add and verify a new connection; there is no in-place credential-rotation API. Provider leases only release local transport resources and never delete sandboxes. Daytona's raw `fetch` transport has no provider-owned client to close.

A verified connection confirms native identity and target. The connection list does not report operation capabilities because eligibility can change; the service rechecks blocked egress support and snapshot suitability during preparation. Verification alone does not guarantee that every operation or policy is supported.
An upstream 401 or 403 from the current-key check is returned as a sanitized credential rejection. The provider's response body is not exposed to the caller.

## Current capability boundary

| Area | Current behavior |
|---|---|
| Image | Existing active snapshot ID in the configured region, Linux VM or container. `prepare` is read-only. OCI sources are rejected before mutation because Daytona's `create({image})` implicitly builds a snapshot. |
| Network | `blocked` maps to native `networkBlockAll: true` only when the verified organization allows strict sandbox egress overrides; other policy names are rejected. Daytona's lower-tier essential-service exceptions do not satisfy Sandbar's blocked policy. The adapter checks the native flag, private preview setting and organization/target in returned sandboxes. The organization flag is an eligibility signal, not a live proof of packet filtering. |
| Create/recovery | Sandbar prepares the snapshot before recording submission and passes its effective ID to one native create POST. Stable submission and operation IDs are used for native labels. An uncertain create is observed by name and matching labels; absent evidence remains unknown and is never replayed. A verified sandbox later found stopped, paused or archived is recorded with its native ID and unknown readiness, rather than reported as running. |
| Inventory | Paginated read-only results are limited to sandboxes bearing Sandbar submission labels in the verified organization and target with blocked egress. This is not a claim to enumerate every native sandbox in the account. |
| Exec | A preflight native detail read must report `started` before toolbox execution. POSIX shell and argv commands use a quoted shell wrapper with `od` to encode exact stdout and stderr bytes, exit status, and truncation. The wrapper uses a fixed utility path; requested environment values, including `PATH`, apply only to the user command. Requires `/bin/sh`, `mktemp`, `mkfifo`, `cat`, `wc`, `head`, `od`, and `rm` in the selected snapshot. There is no durable native execution lookup; a lost response stays unknown. Timeout cancels execution according to Daytona's toolbox API, but Sandbar does not infer remote cancellation from a local abort. |
| Files | Byte download is native. A preflight native detail read must report `started` before upload. Upload verifies the returned path and reads the bytes back. `overwrite:false` is rejected before upload because native upload has no atomic no-clobber guarantee. Lost uploads stay unknown. |
| Destroy | A single DELETE request is made. Completion requires a matching native ID, organization and `destroyed` state. An asynchronous acknowledgement or lost response has no durable Daytona submission identity for reconciliation and stays unknown; a later 404 alone does not prove which deletion caused absence. The adapter does not replay DELETE. No snapshot or volume cleanup is implied. |

Daytona sandboxes use a 60-minute native TTL by default in this package (configurable to 1–1440 minutes). The live harness fixes it to 15 minutes and attempts explicit cleanup. It is opt-in only: set `SANDBAR_DAYTONA_LIVE=1`, `SANDBAR_DAYTONA_API_KEY`, `SANDBAR_DAYTONA_TARGET`, `SANDBAR_DAYTONA_SNAPSHOT_ID`, and `SANDBAR_DAYTONA_BUDGET_ACK=yes`. The acknowledgement is not an automatic USD spending cap; inspect account pricing and quota before opting in. Do not run this harness as part of ordinary CI.

Sources inspected September 26–27, 2026: [Daytona TypeScript SDK reference](https://www.daytona.io/docs/en/typescript-sdk/), [Process reference](https://www.daytona.io/docs/en/typescript-sdk/process/), [network tier restrictions](https://www.daytona.io/docs/en/network-limits/), [platform OpenAPI v0.218](https://www.daytona.io/docs/openapi.json), [toolbox OpenAPI v0.218](https://www.daytona.io/docs/toolbox-openapi.json), published `@daytona/sdk@0.218.0` source, and [public server v0.190.0 organization override enforcement](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/api/src/sandbox/controllers/sandbox.controller.ts#L1110). The historical server code links the organization flag to override eligibility; applying that signal to v0.218 is an inference from the current OpenAPI field and current network tier documentation. This is fixture-tested integration, not a claim of live correctness or observed network isolation.
