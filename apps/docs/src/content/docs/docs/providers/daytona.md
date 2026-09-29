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

| Option                          | Default   | Purpose                                           |
| ------------------------------- | --------- | ------------------------------------------------- |
| `apiKey`                        | Required  | Daytona API key.                                  |
| `target`                        | Required  | Available native region ID, such as `us`.         |
| `ttlMinutes`                    | `60`      | Native sandbox lifetime, from 1 to 1,440 minutes. |
| `snapshots.restartAfterCapture` | `true`    | Restart only a previously running capture source. |
| `networkPolicy`                 | `blocked` | `blocked` or explicit `daytona-default`.          |

`Sandbar.connect` verifies native organization and region with authenticated reads. Scope includes the organization, target, endpoint, and selected network policy. Use the same scope to recover a prior operation.

## Choose the policy deliberately

`daytona-default` preserves Daytona's organization-managed restrictions, including essential-service access. Select it on **both** the connection and create request. It does not promise unrestricted internet or strict blocked egress.

Omitting the policy selects `blocked`. This requires successful organization eligibility verification and native block-all support; a restricted or unreadable eligibility response disables creation. Tier 1/2 essential-service exceptions do not meet Sandbar's strict blocked contract. There is no automatic fallback, and the adapter does not expose an unrestricted `internet` mode.

## Image requirements

Commands support argv and POSIX shell. Binary output capture requires `/bin/sh`, `mktemp`, `mkfifo`, `cat`, `wc`, `head`, `od`, and `rm`. File staging and receipts also need `mkdir`, `rmdir`, `mv`, and compatible copy/link utilities. Atomic no-clobber requires `ln -T` and hard-link support.

The live baseline uses the prepared `daytona-small` workflow in `us`; it does not qualify arbitrary snapshots. Explicit OCI builds are implemented but need separate live evidence and cleanup for retained snapshots. See [Images and networking](/docs/guides/images-and-networking/).

## Runtime snapshots

`box.snapshot()` stops a running container, captures its private filesystem, and starts the source again. An already-stopped source stays stopped. Stopping ends the former processes; restart and restore use fresh process execution. Memory and external volumes are not captured. This orchestration has fixture coverage and is **not yet live-qualified**.

Configure `snapshots: { restartAfterCapture: false }` on `daytona(...)` to leave a running source stopped. The default is `true`, restarting only a previously running source. Optional snapshot requirements validate the configured behavior without selecting another mode. Consistency defaults to unknown; `consistency: "caller-quiesced"` attests that the application quiesced writers.

A definitive capture failure permits one bounded restart attempt. A successful capture followed by a failed restart retains the snapshot metadata in the operation recovery token. Uncertain stop/capture/start outcomes are observed without repeating lifecycle calls. Native capture is experimental; VM filesystem/memory capture is not mapped. See [Daytona snapshot requirements](https://www.daytona.io/docs/en/snapshots/#create-snapshot-from-sandbox).

## Cleanup and recovery

Deletion can be asynchronous. `destroy()` waits for confirmed termination; if the response becomes uncertain, save its reference and observe instead of issuing another delete. `close()` does not stop compute. Borrowed snapshots remain untouched, and built snapshots need separate owned-artifact cleanup.

See [Tested provider support](/docs/providers/support/) for measured coverage and [Errors and recovery](/docs/guides/recovery/) for handling lost responses.

## Snapshots and retained volumes

Scoped capture receipts support independent restore after source deletion; borrowed image selectors do not become owned snapshot artifacts. Snapshot deletion rechecks organization warm pools, blocking when dependencies are present or unreadable because native deletion cascades to warm pools and unclaimed compute. Writable object-backed volumes attach at create with optional subpaths. Native readiness is checked; read-only, volume versions and verified shutdown durability are unavailable. These workflows have fixture coverage and are not yet live-qualified. See [Snapshots and volumes](/docs/guides/snapshots-and-volumes/).

Native mapping evidence: [Daytona snapshots](https://www.daytona.io/docs/snapshots/) and [volumes](https://www.daytona.io/docs/en/volumes/), checked against REST 0.218.0 DTOs.

Mounted volumes are object-backed rather than POSIX filesystems. `writeFile(..., { overwrite: true })` stages bytes privately on the sandbox filesystem before writing and verifying the mounted destination. Atomic no-clobber `writeFile` on mounted paths is unsupported and rejects before effects; ordinary root-filesystem no-clobber writes remain supported. The private staging location must remain outside mounted storage. A completed file write does not certify a shutdown durability barrier.
