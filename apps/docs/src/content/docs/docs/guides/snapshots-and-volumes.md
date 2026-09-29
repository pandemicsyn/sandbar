---
title: Snapshots and volumes
description: Capture independent sandbox state and attach retained storage through direct SDK connections.
---

Direct SDK connections expose scoped snapshot and volume handles. The service client has no state resource endpoints. Capture profiles describe exact preservation, interruption, source state, connection loss, consistency and mounts; always check the actual source first. Current implementations have deterministic fixture coverage; snapshot and volume workflows are **not yet live-qualified**.

## Capture and restore

```ts
const check = await source.checkSnapshot();
if (check.status !== "supported") throw new Error(check.reason);
const captured = await source.snapshot();
const saved = structuredClone(captured.snapshot.reference);
console.log(captured.capture, captured.source); // Actual source state and connection outcome
const metadata = await captured.snapshot.inspect();
const restored = await captured.snapshot.restore({
  networkPolicy: "blocked",
  requireIndependentLifecycle: true,
});
await restored.destroy();
await source.destroy();
await captured.snapshot.delete(); // Separate retained artifact cleanup
```

The same `source.snapshot()` call accepts each adapter's configured native default. Daytona stops a running container, captures its private filesystem, and starts the source again. The former processes end; restore creates fresh process execution. An already-stopped source stays stopped. Set `daytona({ ..., snapshots: { restartAfterCapture: false } })` to leave a running source stopped. E2B captures filesystem and RAM, briefly pauses the running source, resumes it, and drops connections; restore resumes captured processes in a new sandbox. Restores require an explicit network policy.

Optional requirements validate this default; they never select another profile:

```ts
const captured = await source.snapshot({
  requirements: { preserve: "filesystem+memory", maxInterruption: "pause" },
}); // Supported by E2B; Daytona rejects before stopping compute.
```

Consistency remains unknown unless established by native evidence or a caller attestation. After quiescing writers, pass `consistency: "caller-quiesced"`; this attests application preparation. `captured.capture` reports actual preservation, interruption and restored execution, while `captured.source` reports the resulting source lifecycle. Inspected snapshot metadata retains `restoreExecution` across reconnects.

`client.snapshots.get(saved)` verifies and opens a saved scoped reference. `inspect()` rechecks native identity, readiness and generation. A completed capture reference retains authenticated adapter evidence of acknowledged ownership and mount-free source provenance, so it can reopen after source deletion on the same credential and connection scope. The bounded `receipt` is sensitive custody material, contains no API key, and grants no provider authorization. Credential rotation can invalidate its verification, even when native scope is otherwise unchanged; keep the original private credential available for reconciliation. A changed E2B native build/tag fails with `CONFLICT`.

Imported and listed resources have unknown ownership. Their mount provenance can remain unknown, which blocks restore. A string name or caller-edited ownership label cannot authorize deletion. Native path exclusions and artifact expiration can remain unknown in inspected metadata. Current mappings reject restore resource overrides, external mount captures and mount sharing/replacement. Daytona VM hot/cold preservation is not mapped because the pinned native snapshot metadata lacks exact provenance.

## Retained volumes and mounts

```ts
const volume = await client.volumes.create({ name: "workspace-data" });
const info = await volume.inspect();
if (info.state !== "ready") throw new Error("Volume is not ready");
const mount = volume.at("/mnt/workspace"); // Pure descriptor; no attachment yet
const producer = await client.sandboxes.create({
  environment: Image.prepared("your-native-image-id"),
  networkPolicy: "blocked",
  mounts: [mount],
});
await producer.writeFile("/mnt/workspace/example.bin", new Uint8Array([0, 255]), {
  overwrite: true,
});
// Close finite writers first. Native shutdown durability is not established.
const cleanup = await producer.destroy({ storage: "allow-unconfirmed" });
console.log(cleanup.mountDurability);
const consumer = await client.sandboxes.create({
  environment: Image.prepared("your-native-image-id"),
  networkPolicy: "blocked",
  mounts: [volume.at("/mnt/workspace")],
});
await consumer.readFile("/mnt/workspace/example.bin");
await consumer.destroy({ storage: "allow-unconfirmed" });
await volume.delete();
```

Mounts attach only during create. `volume.at()` validates absolute, normalized paths without changing native state. Overlapping or reserved paths are rejected. Daytona supports writable subpaths; E2B's private beta supports writable whole-volume mounts. Neither mapping advertises read-only enforcement or volume versions. Mount readiness is verified for ordinary creation and recovered creation. Account access, class and native readiness can block a check before allocation.

Both mappings expose object-backed storage with unknown shutdown durability, locking and atomic rename guarantees. The default destroy request refuses writable mounts where durability is unverified. `storage: "allow-unconfirmed"` explicitly permits compute cleanup and reports each mount as unconfirmed; it does not turn termination into a durability guarantee. Compute cleanup retains volumes, and `client.close()` releases only the local connection. Delete run-owned storage separately after dependent compute is confirmed gone. Never delete borrowed volumes.

## Inventory and uncertain operations

`client.snapshots.list({ limit: 20 })` and `client.volumes.list({ limit: 20 })` return a bounded page, optional cursor and explicit coverage. Provider-scope inventory is not an account-wide ownership proof. Adapter authors declare `snapshotListCoverage` as `provider-scope` or `sandbar-managed`; undeclared coverage stays unknown in capabilities. Native volume APIs without pagination reject an inventory exceeding the requested bound rather than silently truncating it.

Capture, restore, volume create and artifact delete each have a `submit…` form. Persist the awaited `onReference` callback before dispatch and save updated operation references after waits, including `OutcomeUnknownError` and `WaitAbortedError`. Reconnect to the same scope and call `client.recover(reference)` to observe. For Daytona, a definitive capture failure permits one bounded restart attempt when configured. An uncertain stop or capture blocks later lifecycle steps. If capture succeeds but restart fails, the operation reference retains snapshot metadata and separate restart failure evidence in its recovery token. Capture cancellation can wait up to 85 seconds for bounded submission/finalization evidence; the original abort still reaches native capture reads and prevents unsafe dispatch. Persist that reference; the captured owned snapshot can be opened and inspected independently. Recovery observes source state and capture readiness without replaying stop, capture or start. Daytona artifact deletion also rechecks native warm-pool dependencies; unreadable or nonempty dependencies block deletion because native deletion can cascade to warm pools and unclaimed compute.

Recovery keeps the accepted capture preservation and source lifecycle expectations, and never repeats a capture, create or delete. E2B capture recovery stays unknown if the original native build generation was not observed; a later tag lookup cannot establish the captured generation. A lost native creation acknowledgement can retain billable storage without a safely owned artifact identity. A failed or lost delete acknowledgement stays unknown even if later inventory is empty. Preserve private custody and reconcile; compute TTL does not expire retained storage.

The manual [qualification workflow](https://github.com/pandemicsyn/sandbar/blob/main/packages/sdk-qualification/provider-qualification/README.md) separates filesystem/RAM assertions, volume remount bytes and independent storage teardown. Prepared-image creation alone qualifies neither feature.
