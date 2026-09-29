---
title: Daytona
description: Connect to Daytona with explicit region, prepared image, and network policy settings.
---

Import `daytona` from `sandbar-sdk/daytona`. Start with an active Linux snapshot in your target region and explicitly select Daytona's default networking.

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

const sandbar = await Sandbar.connect(
  daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    target: "us",
    ttlMinutes: 15,
    networkPolicy: "daytona-default",
  }),
);
try {
  const box = await sandbar.sandboxes.create({
    environment: Image.prepared("daytona-small"),
    networkPolicy: "daytona-default",
  });
  try {
    console.log((await box.exec(["printf", "hello"])).stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await sandbar.close();
}
```

Set `DAYTONA_API_KEY` before running this on the server. The snapshot must be active, Linux-compatible, and available to the verified organization in the selected region. Public/general snapshots can be borrowed; they are never owned cleanup targets.

## Connection options

| Option          | Default   | Purpose                                           |
| --------------- | --------- | ------------------------------------------------- |
| `apiKey`        | Required  | Daytona API key.                                  |
| `target`        | Required  | Available native region ID, such as `us`.         |
| `ttlMinutes`    | `60`      | Native sandbox lifetime, from 1 to 1,440 minutes. |
| `networkPolicy` | `blocked` | `blocked` or explicit `daytona-default`.          |

`Sandbar.connect` verifies native organization and region with authenticated reads. Scope includes the organization, target, endpoint, and selected network policy. Use the same scope to recover a prior operation.

## Choose the policy deliberately

`daytona-default` preserves Daytona's organization-managed restrictions, including essential-service access. Select it on **both** the connection and create request. It does not promise unrestricted internet or strict blocked egress.

Omitting the policy selects `blocked`. This requires successful organization eligibility verification and native block-all support; a restricted or unreadable eligibility response disables creation. Tier 1/2 essential-service exceptions do not meet Sandbar's strict blocked contract. There is no automatic fallback, and the adapter does not expose an unrestricted `internet` mode.

## Image requirements

Commands support argv and POSIX shell. Binary output capture requires `/bin/sh`, `mktemp`, `mkfifo`, `cat`, `wc`, `head`, `od`, and `rm`. File staging and receipts also need `mkdir`, `rmdir`, `mv`, and compatible copy/link utilities. Atomic no-clobber requires `ln -T` and hard-link support.

The live baseline uses the prepared `daytona-small` workflow in `us`; it does not qualify arbitrary snapshots. Explicit OCI builds are implemented but need separate live evidence and cleanup for retained snapshots. See [Images and networking](/docs/guides/images-and-networking/).

## Planned runtime snapshot defaults

Runtime capture through `box.snapshot()` is planned, not an available or live-qualified operation in this documented release. Existing prepared-image snapshots above are a separate workflow.

For Daytona **containers**, the planned default is to stop a running source, capture its private filesystem, then start the source again. An already-stopped source stays stopped. Memory is not captured: stopping ends the original processes, and starting the sandbox does not recover them. Restoring the snapshot creates a new sandbox with fresh process execution. External volumes are not included.

The proposed adapter option is `daytona({ ..., snapshots: { restartAfterCapture: false } })` to leave the source stopped. It defaults to `true`, meaning restart only if previously running. There is no separate permission setting for the required stop. Daytona's native capture requires the container to be stopped; Sandbar would provide the stop/capture/start orchestration. The native method is experimental. VM filesystem/memory capture requires separate adapter support and qualification. See [Daytona's native snapshot requirements](https://www.daytona.io/docs/en/snapshots/#create-snapshot-from-sandbox).

If capture definitively fails after stopping, the default workflow attempts to start the source again. If capture succeeds but restart fails, the error must retain the snapshot reference and report source state. An uncertain capture must be reconciled before a safe restart; read-only recovery never replays capture or starts compute. These defaults and failure cases must be covered by the implementation and live qualification before this page claims support.

## Cleanup and recovery

Deletion can be asynchronous. `destroy()` waits for confirmed termination; if the response becomes uncertain, save its reference and observe instead of issuing another delete. `close()` does not stop compute. Borrowed snapshots remain untouched, and built snapshots need separate owned-artifact cleanup.

See [Tested provider support](/docs/providers/support/) for measured coverage and [Errors and recovery](/docs/guides/recovery/) for handling lost responses.

## Snapshots and retained volumes

The direct SDK maps cold container filesystem capture with explicit stop permission and caller-quiesced writers. The source ends stopped. VM captures, memory capture and external mount capture remain unsupported. Scoped capture receipts support independent restore after source deletion; borrowed image selectors do not become owned snapshot artifacts. Writable object-backed volumes attach at create with optional subpaths. Native readiness is checked; read-only, volume versions and verified shutdown durability are unavailable. These workflows are not yet live-qualified. See [Snapshots and volumes](/docs/guides/snapshots-and-volumes/).

Native mapping evidence: [Daytona snapshots](https://www.daytona.io/docs/snapshots/) and [volumes](https://www.daytona.io/docs/en/volumes/), checked against REST 0.218.0 DTOs.
