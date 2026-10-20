---
title: Snapshots and volumes
description: Save sandbox state, keep data between sandboxes, and reopen saved resources.
---

Use a **snapshot** to save sandbox state and restore it into another sandbox. Use a **volume** to keep data after a sandbox is destroyed. Both need separate deletion when you no longer need them.

Support varies by adapter. Capturing a snapshot, restoring it, managing volumes and mounting volumes are separate features. See [current combinations](#current-combinations) and [tested provider support](/docs/providers/support/) before choosing a workflow.

For TypeScript annotations, import `SandbarClient`, `SandboxHandle`, `SnapshotHandle` and `VolumeHandle` from `sandbar-sdk`. See the [TypeScript reference](/docs/reference/typescript/#consumer-vocabulary-and-compatibility) for compatibility types.

## Capture and restore

Start with a connection named `sandbar`, configured with a default environment and network policy as shown in [Getting started](/docs/direct-quickstart/). The adapter must support snapshot capture and restore. E2B and Daytona support different kinds of captured state, described [below](#what-capture-preserves).

```ts
const source = await sandbar.sandboxes.create();
const check = await source.checkSnapshot();
if (check.status !== "supported") {
  await source.destroy(); // No capture was submitted.
  throw new Error(check.reason);
}
// Keep the source if capture fails: it may need recovery.
const captured = await source.snapshot();
console.log(captured.capture, captured.source);
```

`checkSnapshot()` checks whether this source can be captured. It does not reserve a capture or promise that restore will be supported. Before creating a source for a round trip, check `(await sandbar.capabilities()).snapshots.restore` too.

Keep `captured` available while saving its reference. If your save fails, you still have the handle and reference to save again or clean up deliberately.

```ts
try {
  await saveResource(JSON.stringify(captured.snapshot.reference));
  const restored = await captured.snapshot.restore();
  try {
    console.log(await restored.inspect());
  } finally {
    await restored.destroy();
  }
  await captured.snapshot.delete();
  await removeSavedResource(captured.snapshot.reference);
} finally {
  // Capture succeeded before entering this block.
  await source.destroy();
}
```

`saveResource` and `removeSavedResource` represent your application's storage functions. Save references in durable, trusted storage. Remove the saved record only after deletion is confirmed. If removing the record fails, mark it as deleted during recovery instead of repeating the provider delete.

Restore uses the connection's configured network policy when you omit `network`. An explicit override must be supported by that connection. By default, restore also requires the new sandbox to have a lifecycle independent of the source and snapshot. Unsupported restore requirements reject before allocation with `UnsupportedFeatureError`; `unmetRequirements` explains why.

Snapshot deletion is separate from destroying the source or restored sandbox. If restore or sandbox cleanup fails, keep the snapshot reference until you have resolved the failure. Do not delete a snapshot that may still be needed by compute.

Close the connection in an outer `finally`, as in [Getting started](/docs/direct-quickstart/). If capture throws, the second code block is never reached: keep the source, the error's operation reference and any known snapshot reference. Use [Results, errors and saved resources](/docs/guides/recovery/) to resolve capture and restart before destroying the source. Cancelling a local wait does not prove that the provider stopped working.

### What capture preserves

`source.snapshot()` uses the adapter's configured capture behavior. Optional requirements check that behavior; they do not switch capture modes.

| Provider          | Captured state                            | Effect on a running source                | Restored execution                               |
| ----------------- | ----------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| Daytona container | Private filesystem                        | Stop, capture, then restart               | Fresh processes; RAM is not retained             |
| E2B               | Private filesystem, RAM and process state | Pause and resume; active connections drop | Resume captured processes in independent compute |
| boxd              | Private disk, RAM and process state       | Brief pause; keeps running                | Resume captured processes in a new machine       |

Daytona leaves an already-stopped source stopped. Configure `snapshots: { restartAfterCapture: false }` on the adapter to also leave a running source stopped after capture. VM capture is unsupported. E2B requires a running source with envd `v0.5.0` or newer and has no filesystem-only capture option.

```ts
const captured = await source.snapshot({
  requirements: { preserve: "filesystem+memory", maxInterruption: "pause" },
}); // E2B can satisfy this; Daytona rejects before stopping compute.
```

Pause application writers before capture if you need consistent data. Passing `consistency: "caller-quiesced"` records that you did so; Sandbar does not pause writers for you. Otherwise, consistency remains unknown unless the provider supplies evidence. `captured.capture` describes what was saved, and `captured.source` describes the source after capture.

A restored snapshot does not strengthen the provider's network guarantees. In the maintained E2B test, requested `blocked` networking still allowed direct outbound IPv4 TCP; restored processes may retain outbound access. See [E2B networking](/docs/providers/e2b/#network-and-previews) and the [test evidence](/docs/providers/support/).

## Create and mount a volume

A volume stores data separately from compute. `volume.at(path)` describes where to mount it; calling `at()` does not attach storage or change the provider. Pass the descriptor in `mounts` when creating a sandbox.

The following example uses Daytona. Configure the prepared image and network policy once on the connection:

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { daytona } from "@sandbar-sdk/daytona";

const sandbar = await Sandbar.connect(
  daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    target: "us",
    environment: Image.prepared("daytona-small"),
    network: "daytona-default",
  }),
  { cleanup: { storage: "allow-unconfirmed" } },
);
```

The default cleanup policy, `require-durable`, prevents destruction of mounted compute when writable-storage durability cannot be confirmed. Daytona cannot currently confirm that guarantee. `allow-unconfirmed` permits destruction while accepting that writes may not be fully durable. Finish application writes first; a completed write alone does not prove shutdown durability.

Set the policy once with `cleanup.storage`, as above, or override it on `destroy({ storage: ... })` or `submitDestroy({ storage: ... })`. A call's explicit policy wins over the connection default.

Close this connection in an outer `finally` after handling its resources, as in [Getting started](/docs/direct-quickstart/).

```ts
const volume = await sandbar.volumes.create({ name: "workspace-data" });
await saveResource(JSON.stringify(volume.reference));
const info = await volume.inspect();
if (info.state !== "ready") throw new Error("Volume is not ready");

const box = await sandbar.sandboxes.create({
  mounts: [volume.at("/mnt/workspace")],
});
try {
  await box.writeFile("/mnt/workspace/example.bin", new Uint8Array([0, 255]), {
    overwrite: true,
  });
} finally {
  const cleanup = await box.destroy();
  console.log(cleanup.mountDurability); // May still be unconfirmed.
}
// Delete storage only after compute cleanup is confirmed and you no longer need the data.
await volume.delete();
await removeSavedResource(volume.reference);
```

To keep the data, omit the final deletion and record removal. Mount the same volume when creating the next sandbox to use its current data. Creating a new volume gives you separate empty storage; it does not copy an existing volume. A sandbox snapshot does not freeze external volume contents.

Volumes survive sandbox destruction, connection close and the sandbox's compute lifetime. If creation, saving or cleanup fails, retain any known references and resolve the compute outcome before deleting storage. Automatic cleanup does not adopt borrowed volumes.

Mount paths must be absolute, normalized, nonoverlapping and outside reserved paths. Daytona supports writable subpaths. Its volumes use object storage and do not promise normal filesystem locking or atomic rename behavior. Mounted `writeFile` requires `overwrite: true`; atomic no-clobber writes are unsupported. See [Daytona storage details](/docs/providers/daytona/#snapshots-and-volumes) and [boxd storage limits](/docs/providers/boxd/#storage-and-recovery).

### Restore private state with selected data

Daytona can combine a filesystem snapshot with volumes you choose at restore time. Capture private code and configuration from a source with no mounts. Save the full snapshot and volume references. A new connection with matching scope can reopen them even after the source has been destroyed:

```ts
const snapshot = await sandbar.snapshots.get(saved.snapshot);
const data = await sandbar.volumes.get(saved.data);
const restored = await snapshot.restore({
  mounts: [data.at("/data")],
});
```

This example uses the Daytona connection configured with `daytona-default` above. Mounted restore with `blocked` is unsupported because enforcement before the first workload runs has not been verified.

The selected volume supplies its current data. To use separate empty data, create a new volume and pass its descriptor. Omit `mounts`, or pass `[]`, to restore only private snapshot state. A mount hides any private snapshot files at that path without erasing them. Restore does not copy volumes, create them implicitly or replace them by name.

Daytona requires a ready snapshot known to have no recorded mounts, with filesystem preservation and fresh execution. Unknown mount history blocks restore. It checks volume scope, readiness, writable access, mount paths and exact provider IDs. Read-only restore mounts are unsupported. These checks do not detect guest-created FUSE or network mounts.

If restore fails with an uncertain outcome, save the operation reference and the known sandbox and volume references from `error.outcome` with kind `snapshot_restore`. Inspect those resources instead of submitting another restore. Destroying the restored sandbox retains application volumes and still follows the configured storage cleanup policy.

The [compiled storage example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/storage-composition.ts) covers shared data, separate empty data, private-only restore and reopening full references. See [provider support](/docs/providers/support/) for what has been tested live.

### Current combinations

| Workflow                               | Current support                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Capture and restore private state      | Daytona filesystem capture; E2B and boxd filesystem and memory capture. Vercel snapshots are unsupported.            |
| Capture a sandbox with external mounts | Unsupported by the Daytona, E2B and boxd adapters.                                                                   |
| Restore with selected volumes          | Daytona only: known mount-free filesystem snapshot, fresh execution and `internet` or `daytona-default` networking.  |
| Override restore resource sizes        | Unsupported by Daytona, E2B and boxd; empty overrides are treated as omitted.                                        |
| Create a sandbox with volumes          | Daytona writable mounts with optional subpaths; boxd whole-disk read-only or writable mounts.                        |
| Manage E2B volumes                     | Private-beta API mapping; live creation was blocked by account HTTP 403. Sandbar create-time mounts are unsupported. |
| Manage Vercel volumes                  | Unsupported.                                                                                                         |
| Copy or version a volume               | Unsupported by Daytona, E2B and boxd.                                                                                |

boxd volumes and mounts have deterministic test coverage but no recorded live storage pass. Vercel has no recorded live acceptance. See [tested provider support](/docs/providers/support/) for evidence per workflow.

Use descriptor arrays such as `[volume.at("/data")]` for mounts. Legacy nonempty share/replace/omit maps reject with `INVALID_ARGUMENT` and migration guidance; empty `{}` remains a deprecated runtime compatibility alias. Older custom adapters need `snapshotRestore.mountInput: "specs"` to accept nonempty descriptor arrays.

## Save and reopen references

Resource references are versioned JSON that your application stores. They include the provider, account scope, provider identity and ownership evidence, without API keys. Save the full returned reference: trimming fields can lose the captured generation or history needed to reopen safely.

Use current credentials for the same scope when reopening:

```ts
import { validateResourceReference } from "sandbar-sdk";

const reference = validateResourceReference(JSON.parse(savedJson));
const snapshot = await sandbar.snapshots.get(reference);
console.log(await snapshot.inspect());
// For a saved volume reference, use await sandbar.volumes.get(reference).
```

Validation checks the reference's shape; it does not prove that the resource still exists. `get()` checks scope and reads the provider before returning a handle. `inspect()` refreshes the resource's state. Saved history is not current provider state.

Daytona organization scope supports key rotation. For E2B, configure an authenticated, verified `teamId` if references must survive key rotation; its default scope is tied to the API key.

`snapshots.list({ limit: 20 })` and `volumes.list({ limit: 20 })` return bounded pages with optional cursors and coverage information. Finding a resource in a list does not prove your application created it or owns it. Listed or imported snapshots may lack the history needed for restore.

## Failures and provider limits

A successful `snapshot()` returns the snapshot handle, capture details and observed source state. A failed call may still have created a snapshot. For example, if capture succeeds but restarting the source definitively fails, `SOURCE_RESTART_FAILED` includes the saved snapshot in a partial outcome:

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
    // Save any known reference using your application's failure policy before rethrowing.
  }
  throw error;
}
// A rejected save leaves captured and retainedSnapshot available in this scope.
await saveResource(JSON.stringify(retainedSnapshot));
```

An uncertain restart reports `OUTCOME_UNKNOWN` and keeps known capture details. Neither case is a reason to submit another capture. A failure in your save function is separate from capture: keep the returned handle and reference. The [tested recovery examples](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/recovery-outcomes.ts) show this separation.

Capture, restore, volume creation and deletion also have `submit…` methods. Save operation references when a result becomes uncertain or a wait is cancelled, then use `sandbar.recover(reference)` to observe the original operation without repeating it. Some staged operations support explicit `continue()`; see [Results, errors and saved resources](/docs/guides/recovery/) before using it.

A process can crash after provider creation but before saving the identity. If no identity was received, a list or matching name does not prove which resource belongs to that request. Keep unresolved resources under investigation rather than retrying creation or deleting by name.

E2B restore selects the captured template build, never a newer `default` build. E2B snapshot deletion removes its containing template and blocks known shared use; Daytona checks warm-pool dependencies because deletion can affect dependent resources. A dependency check cannot make a provider delete transactional. See [E2B snapshot limits](/docs/providers/e2b/#lifetime-pause-and-snapshots) and [Daytona cleanup limits](/docs/providers/daytona/#snapshots-and-volumes).

Automatic cleanup requires evidence that the application created the resource. Explicit deletion still checks scope, identity and dependencies. An unresolved volume name in a cleanup report is not a verified volume ID or permission to delete it. Very large mount histories can exceed saved-reference limits and reject before provider changes. Unknown expiry, excluded paths and storage guarantees remain unknown.

## Evidence

[Provider support](/docs/providers/support/) shows what has been tested live and links to the recorded runs. A pass applies to its recorded configuration, not every image, account or current revision.

Daytona's complete mounted-restore workflow passed at `5911ccc` with the pinned image, `us` region and `daytona-default`, including selected data, fresh-client reopening and confirmed cleanup. The earlier partial storage test remains in the evidence history. E2B volume creation was blocked by account HTTP 403, so maintained E2B acceptance skips volume cases before setup; that does not prove the provider lacks volumes.
