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

## Capture and restore

Insert this capture/restore fragment inside the sandbox’s inner `try` block above, before cleanup. It uses the same connection policy. Follow the [complete example](/docs/guides/snapshots-and-volumes/#capture-and-restore) to persist the reference and clean up restored compute and the retained snapshot:

```ts
const captured = await box.snapshot();
const restored = await captured.snapshot.restore({
  networkPolicy: "daytona-default",
  requireIndependentLifecycle: true,
});
```

Capture stops a running source, saves its private filesystem and restarts it. Stopping ends the former processes; restart and restore execute fresh processes. RAM and external volumes are not captured. An already-stopped source stays stopped. Set `snapshots: { restartAfterCapture: false }` on `daytona(...)` to leave a running source stopped. Requirements validate that configured default; they do not choose another mode. VM hot/cold capture is not mapped.

Persist the snapshot reference, destroy restored/source compute and delete the snapshot separately. A capture can succeed while source restart fails; preserve the operation reference for [recovery](/docs/guides/recovery/). Snapshot deletion checks warm-pool dependencies because native deletion can cascade; unreadable or nonempty dependencies block it. See [Snapshots and volumes](/docs/guides/snapshots-and-volumes/) for cleanup-safe examples, consistency and saved references.

## Retained storage

Writable object-backed volumes attach at create, with optional subpaths. `volume.at(path)` is only a descriptor. Close finite writers before `destroy({ storage: "allow-unconfirmed" })`; this permits compute cleanup without a flush/durability guarantee. Volumes survive destruction and need explicit deletion after dependent compute is gone.

Mounted `writeFile` supports `overwrite: true` using private staging outside the mount. Mounted atomic no-clobber is unsupported. Read-only enforcement, volume versions and verified shutdown durability are unavailable. Capture with external mounts and mounted restore are unsupported.

## Cleanup and evidence

`destroy()` waits for confirmed termination; `close()` releases the connection only. Preserve uncertain cleanup references and observe rather than repeating delete. Borrowed prepared images are never automatic cleanup targets; OCI builds retain artifacts needing separate accounting.

Both providers' snapshot workflows and Daytona mounted persistence passed live on premerge `5db0558`, including write isolation, saved references and exact cleanup. Later fixes merged with PR #25 at `a9d59b0`; the earlier runs do not certify that final head. Consult [Tested provider support](/docs/providers/support/) and [Live test evidence](/docs/providers/live-qualification/) for the current qualification mapping.
