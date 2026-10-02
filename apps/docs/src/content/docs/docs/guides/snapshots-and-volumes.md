---
title: Snapshots and volumes
description: Capture and restore a sandbox, mount retained storage, save references, and clean up resources.
---

Snapshots retain captured sandbox state independently of the source. Volumes retain storage independently of compute. These APIs are available on SDK connections. Snapshot preservation, volume management and mounting are separate provider capabilities; support for one does not imply support for the others.

Use `DirectSandbarClient` and `DirectSandboxHandle` from `sandbar-sdk` when annotating direct clients and sandboxes. `SandbarClient` and `SandboxHandle` are aliases for the same complete SDK surfaces.

Malformed caller inputs in these APIs reject with `SandbarError` (`INVALID_ARGUMENT`, effect `none`) before mutation. Unsupported restore preflight throws `UnsupportedFeatureError`; its `unmetRequirements` lists each unmet network, sizing, independent lifecycle or mount requirement. Independent lifecycle is required unless explicitly set to `false`.

`RestoreRequest.mounts` retains share, replace and omit choices for schema compatibility, but all nonempty choices currently reject. Restores require confirmed `mountHandling: "none"` and no recorded mounts; unknown provenance also rejects. Leave `mounts` absent or empty. A provider's mount metadata does not enable mounted restore in the SDK.

## Capture and restore

Start with an [E2B connection](/docs/providers/e2b/) named `sandbar` and `Image` imported from `sandbar-sdk`. The following uses `base` and requests the native `blocked` setting on create and restore. This is not verified egress isolation: the maintained probe at `431cdaa` still connected to `1.1.1.1:443` despite requested blocking. See the [failed network evidence](/docs/providers/support/); captured processes may retain outbound access after restore. On Daytona, use the configured prepared image and `daytona-default` on both create and restore when the connection uses that policy.

```ts
const source = await sandbar.sandboxes.create({
  environment: Image.prepared("base"),
  networkPolicy: "blocked",
});
const check = await source.checkSnapshot();
if (check.status !== "supported") {
  await source.destroy(); // No capture was submitted.
  throw new Error(check.reason);
}
// If capture throws, leave the source intact for reconciliation.
const captured = await source.snapshot();
console.log(captured.capture, captured.source);
```

The caller now owns `captured` before attempting application persistence. Keep this result in the owning scope, as in the tested `captureSnapshot`/`saveSnapshot` [examples](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/recovery-outcomes.ts). A rejected save leaves `captured.snapshot.reference` and the handle available for another save or deliberate artifact cleanup; do not discard the result when handling that storage error.

```ts
try {
  await saveResource(JSON.stringify(captured.snapshot.reference));
  const restored = await captured.snapshot.restore({
    networkPolicy: "blocked",
    requireIndependentLifecycle: true,
  });
  try {
    console.log(await restored.inspect());
  } finally {
    await restored.destroy();
  }
  await captured.snapshot.delete();
  await removeSavedResource(captured.snapshot.reference);
} finally {
  // Capture returned successfully before this persistence/restore block began.
  await source.destroy();
}
```

`saveResource` and `removeSavedResource` are your application's durable persistence functions. Remove or tombstone the saved record only after artifact deletion is confirmed. If that bookkeeping fails, reconcile the record as deleted rather than reopening it or repeating the native delete.

Snapshot deletion is separate from source and restored-compute destruction. If saving, restore, or cleanup fails, retain the snapshot reference for reconciliation; do not delete a potentially dependent artifact.

Close the connection in an outer `finally`, as in [Getting started](/docs/direct-quickstart/). If capture throws, execution never reaches the persistence/restore cleanup block, leaving the source intact. Preserve the error’s operation reference and any known partial snapshot identity using [Errors and recovery](/docs/guides/recovery/); resolve the capture/restart outcome before destroying the source. A local cancellation does not establish that the provider stopped working.

Restore requires a supported **explicit network policy**. Before creating a source for a round trip, check `(await sandbar.capabilities()).snapshots.restore`. Capture and restore support are independent; a successful capture check is not a reservation or a promise that restore is supported.

### What capture preserves

`source.snapshot()` accepts the adapter's configured native default. Optional requirements validate that default; they do not select another capture mode.

| Provider          | Captured state                            | Source interruption                                 | Restored execution                               |
| ----------------- | ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| Daytona container | Private filesystem                        | Stop, capture, restart a previously running source  | Fresh processes; RAM is not retained             |
| E2B               | Private filesystem, RAM and process state | Pause and resume a running source; connections drop | Resume captured processes in independent compute |

Daytona's `snapshots: { restartAfterCapture: false }` leaves a running source stopped; an already-stopped source stays stopped. VM hot/cold capture is not mapped. E2B requires a running source with envd `v0.5.0` or newer and has no filesystem-only capture option.

```ts
const captured = await source.snapshot({
  requirements: { preserve: "filesystem+memory", maxInterruption: "pause" },
}); // E2B can satisfy this; Daytona rejects before stopping compute.
```

Consistency is unknown unless native evidence or caller preparation establishes it. After quiescing application writers, pass `consistency: "caller-quiesced"`. This records your attestation. `captured.capture` and `captured.source` report the actual preservation and resulting source lifecycle; snapshot inspection retains the restore-execution facts across reconnects.

## Create and mount a volume

Use a [Daytona connection](/docs/providers/daytona/) named `sandbar` configured with `networkPolicy: "daytona-default"`. Mounts attach during sandbox creation. `volume.at(path)` only creates a descriptor; it does not attach storage or mutate the provider. Reusing the same volume in another supported sandbox creation selects its current shared data. Creating a different volume starts with independent empty storage; it does not copy the first volume. A sandbox snapshot must not be assumed to freeze external volume contents.

The default `require-durable` policy blocks compute destruction when writable-volume durability cannot be confirmed. Choose `allow-unconfirmed` only when your application accepts cleanup without a confirmed write barrier. It does not establish account eligibility or promise flushed or durable writes. Finish finite writers before destroying compute.

Configure the policy once on a direct connection, or override it on `destroy` or `submitDestroy`: the call option wins, then `cleanup.storage`, then `require-durable`. Configuration is validated and copied before the provider connects. For the Daytona connection used below:

```ts
import { Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

const sandbar = await Sandbar.connect(
  daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    target: "us",
    networkPolicy: "daytona-default",
  }),
  { cleanup: { storage: "allow-unconfirmed" } },
);
```

Close this connection in an outer `finally` after handling owned resources, as in [Getting started](/docs/direct-quickstart/).

```ts
const volume = await sandbar.volumes.create({ name: "workspace-data" });
await saveResource(JSON.stringify(volume.reference));
const info = await volume.inspect();
if (info.state !== "ready") throw new Error("Volume is not ready");

const box = await sandbar.sandboxes.create({
  environment: Image.prepared("daytona-small"),
  networkPolicy: "daytona-default",
  mounts: [volume.at("/mnt/workspace")],
});
try {
  await box.writeFile("/mnt/workspace/example.bin", new Uint8Array([0, 255]), {
    overwrite: true,
  });
} finally {
  const cleanup = await box.destroy(); // Uses the configured cleanup policy.
  console.log(cleanup.mountDurability); // Durability can still be unconfirmed.
  // Per-call override: await box.destroy({ storage: "require-durable" });
}
// Only after compute cleanup is confirmed and the data is no longer needed:
await volume.delete();
await removeSavedResource(volume.reference);
```

A different connection default does not change an existing recovered operation or authorize mutation replay.

To keep the data, omit the final deletion and saved-record removal, then attach `volume.at("/mnt/workspace")` when creating the next sandbox. Volumes survive `destroy()` and `close()`, and compute TTL does not expire them. If create or destroy becomes uncertain, keep the volume reference and reconcile compute before deleting storage. A failed readiness check or write must not trigger unsafe artifact deletion. Delete only the resources your application intends to remove; automatic cleanup never adopts borrowed volumes.

Mount paths must be absolute, normalized, nonoverlapping and outside reserved paths. Daytona supports writable subpaths. Its volumes are object-backed; mounted `writeFile` needs `overwrite: true`, and atomic no-clobber on mounted paths is unsupported. A verified write does not establish shutdown durability, POSIX semantics, locking or atomic rename guarantees.

### Current combinations

| Workflow                                  | Current boundary                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Capture a sandbox with external mounts    | Unsupported on both adapters                                                                                              |
| Restore with mounts or resource overrides | Unsupported; empty override maps are equivalent to omission                                                               |
| Daytona writable create-time mounts       | Implemented; readiness and immutable volume identity checked                                                              |
| E2B volume CRUD                           | Mapped to private-beta native APIs; live validation blocked by account HTTP 403                                           |
| E2B create-time mounts                    | Unsupported separately: inspected native requests/observations select names without proving exact mounted volume identity |
| Read-only mounts or volume versions       | Not implemented on either adapter                                                                                         |

## Save and reopen references

Resource references are versioned JSON owned by your application. They contain provider, verified scope, native identity and ownership evidence, with no API key or required signature. Existing compatibility history/receipt fields may also be present; save the full returned reference rather than constructing or trimming one. Historical observations are not fresh provider state. Persist them outside the SDK, then reopen using current valid credentials for the same verified scope:

```ts
import { validateResourceReference } from "sandbar-sdk";

const reference = validateResourceReference(JSON.parse(savedJson));
const snapshot = await sandbar.snapshots.get(reference);
console.log(await snapshot.inspect());
// For a saved volume reference, use await sandbar.volumes.get(reference).
```

`get()` validates scope and performs native inspection/identity checks before returning a handle. `inspect()` refreshes those facts, including readiness and generation. Validation alone does not prove that an artifact still exists or is unexpired. Daytona organization scope survives key rotation. E2B key rotation requires an authenticated, verified `teamId`; its default API-key scope changes with the key.

`snapshots.list({ limit: 20 })` and `volumes.list({ limit: 20 })` return bounded pages with optional cursors and explicit coverage. Inventory is not an account-wide ownership proof. Imported/listed artifacts have unknown ownership, and missing mount provenance can block restore.

## Failures and provider limits

Ordinary `snapshot()` returns the snapshot handle, capture guarantees and observed source state. If capture succeeds but source restart definitively fails, `SandbarError` with code `SOURCE_RESTART_FAILED` exposes a typed partial outcome. Separate capture from persistence so the successful result stays in scope through a save failure:

```ts
import { SandbarError } from "sandbar-sdk";

let captured;
let retainedSnapshot;
try {
  captured = await source.snapshot();
  retainedSnapshot = captured.snapshot.reference;
} catch (error) {
  if (error instanceof SandbarError && error.outcome?.kind === "snapshot_capture") {
    const outcome = error.outcome;
    retainedSnapshot = outcome.snapshot;
    console.error(outcome.capture, outcome.restart, retainedSnapshot);
    // Save a known reference under your application’s failure policy before rethrowing.
  }
  throw error; // The composite call failed; keep its known artifact identity.
}
// If this application save rejects, captured and retainedSnapshot remain available.
await saveResource(JSON.stringify(retainedSnapshot));
```

An uncertain restart remains `OUTCOME_UNKNOWN` and preserves known capture details. Neither outcome calls for another capture. A failure in your save function after successful capture is an application storage failure; keep the returned reference. The [compiled examples](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/recovery-outcomes.ts) and their deterministic tests separate capture/create from saving, including rejected saves. There is a crash window between native creation and saving identity. If no identity was received, listing alone cannot associate an artifact with the request or prove no effect.

Capture, restore, volume creation and deletion also have `submit…` forms. Save operation references from uncertain errors or cancelled waits, then use same-scope `recover(reference)` to observe without replay. Existing explicit `continue()` and checkpoint callbacks are advanced compatibility paths; see [Results, errors and saved resources](/docs/guides/recovery/). Applications own persistence and reconciliation policy.

E2B restores the saved `templateId:buildUUID`, never a moving `default` build. Missing/unaddressable generations fail. Snapshot deletion targets its dedicated containing template and rejects known shared expansion; native deletion has no transactional generation precondition. Daytona deletion rechecks warm-pool dependencies, and unreadable or nonempty dependencies block deletion because the native delete can cascade. Automatic cleanup requires correlated creation evidence; explicit deletion still checks scope, identity and dependencies.

Lost acknowledgements can leave billable artifacts without a safely owned identity. Preserve custody and reconcile rather than retrying by name. Unknown native path exclusions, expiry and storage guarantees remain unknown. Aggregate mounted history/path size can exceed the recovery-reference limit and reject before effects. Provider-specific cleanup may report unresolved volume names instead of verified native IDs; those names grant no deletion authority.

## Evidence

The [generated support table](/docs/providers/support/) and [live evidence](/docs/providers/live-qualification/) preserve exact tested revisions/configuration, historical passes, blocked access and not-run cases. The merged Bun acceptance tooling generates these claims; this documentation change adds no live evidence. E2B volume creation is blocked by account HTTP 403, and the maintained built-in profile skips volume cases before setup. This does not prove that E2B lacks native volumes.
