---
title: Results, errors and saved resources
description: Save resource references and handle partial or uncertain results without repeating work.
---

Save a resource's reference when you need to use it from a later connection. Sandbar returns the reference; your application chooses where to store it and how to handle failures.

```ts
const captured = await sandbox.snapshot();
console.log(captured.snapshot.provider, captured.snapshot.id);
await database.save(captured.snapshot.reference);

// Later, using current credentials and the matching provider/scope:
const snapshot = await freshClient.snapshots.get(savedReference);
const restored = await snapshot.restore(); // Uses this connection's network policy.
```

Here, `database.save` represents your application's storage. Save the complete versioned reference, not just the display ID. The reference contains the provider, connection scope and native selectors needed to reopen the resource. For example, an E2B snapshot reference selects the exact captured build and keeps the containing template ID needed for deletion. A later change to the default build cannot silently replace that saved build. Volume handles also expose `provider`, `id` and `reference`.

Snapshot behavior depends on the adapter:

- Daytona captures filesystem state and may stop and restart the source sandbox.
- E2B captures filesystem and memory, using native pause/resume behavior.

Read the returned `capture` for the confirmed guarantees and `source` for the source state observed when the call finishes. An `observedAt` timestamp records a past observation; it does not promise the provider is still in that state.

E2B and Daytona reject captures with external mounts and reject resource-size overrides during restore. Daytona can restore known filesystem snapshots that start fresh processes with selected volume mounts under `internet` or `daytona-default` networking. Restoring memory together with mounts remains unsupported. Omit mounts or pass an empty array for private filesystem state. The SDK temporarily also accepts the legacy empty-object alias. See [snapshots and volumes](/docs/guides/snapshots-and-volumes/) for the full options and limits.

If `database.save` fails after capture returns, the capture still succeeded and you still have its handle and reference. There is also a crash window between native creation and saving that reference. Sandbar does not guarantee that a create-and-save workflow happens exactly once; your application must choose how to manage that window.

## Partial and unknown outcomes

A failed call can still have a useful result. For snapshot capture:

- If capture succeeds but restarting the source definitely fails, the error has `code: "SOURCE_RESTART_FAILED"` and `effect: "partial"`.
- If capture succeeds but restart cannot be confirmed, the error is `OUTCOME_UNKNOWN`.

In both cases, the typed `outcome` preserves the snapshot reference and confirmed capture details. `restart.status` is `"failed"` or `"uncertain"`, respectively. Keep that result; you do not need to capture again.

`OutcomeUnknownError` means a remote effect may have occurred but its outcome cannot be confirmed, such as after a lost response. Save the error's operation reference and any known resource IDs or partial results. If no snapshot identity was received, the SDK cannot invent one.

Where supported, `sandboxes.list`, `snapshots.list`, `volumes.list`, `get` and `inspect` can help you investigate. A list alone cannot link an artifact to the failed request or prove the request had no effect. E2B and Daytona report snapshot list coverage as `provider-scope`: their inventory is not limited to resources created through Sandbar. A listed entry can still lack details needed to restore or delete it. Check its reference and inspect its supported guarantees.

An uncertain restore has outcome kind `snapshot_restore`. It preserves selected mount descriptors in `outcome.mounts` and, when known, the acknowledged sandbox identity in `outcome.sandbox`. Save these with the operation reference. They identify what is known about the original attempt; recovery does not create a replacement or repeat the restore.

If compute cleanup is uncertain, `outcome.retainedVolumes` keeps known volume references. Removing compute and deleting storage are separate operations. Keep those references and follow the [volume deletion safeguards](/docs/guides/snapshots-and-volumes/#save-and-reopen-references) before deleting storage.

The [compiled recovery example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/recovery-outcomes.ts) shows how to save references, reopen resources and use partial capture results.

## Reopen compute and recover lifecycle changes

Save `sandbox.reference` and pass it to `client.sandboxes.get(reference)` to reopen the same compute. Reopening checks identity and current access. It does not resume the sandbox, extend its lifetime or prove that a previous mutation succeeded. A reference can be `null` if the adapter could not verify identity; do not construct one from the display ID. When a reference was not saved, [`sandboxes.list()`](/docs/guides/resources/#list-sandboxes) can supply one for a listed sandbox, but a listing alone does not show which request created it.

Renewal, suspension and resumption have separate **operation references** for investigating their original requests. Pass one to `client.recover()` to get an operation handle, then observe or wait for the original result. These steps do not retry the lifecycle request.

An acknowledged renewal returns `acknowledged: true` even if a later detail read fails, in which case `observation` is `null`. After a lost acknowledgement, seeing a similar deadline does not prove that this renewal request was accepted. Likewise, observing a suspended sandbox does not prove that a requested memory-preservation guarantee was met. See [sandbox lifecycle](/docs/guides/resources/#reopen-and-manage-lifetime).

## Existing asynchronous operations

Use `submit*` methods when you need an operation handle before a native operation finishes. Save the handle's operation reference to recover it later:

- `recover(reference)` reopens an operation handle for the original request.
- `observe()` checks for its result; `null` means completion is not yet known.
- `wait()` keeps waiting for its result.

These methods do not repeat mutations. Recovery requires a native identity or correlation that the provider can still verify. It cannot always discover a missing resource ID.

`continue()` has a different purpose: it explicitly allows supported remaining stages that are proven not to have been submitted. For example, a recovered Daytona capture may need a separate continuation to restart the source. It does not authorize repeating a stage whose outcome is unknown. Your application must serialize continuation across processes; a saved operation reference is not a distributed lock. See [Asynchronous adapter recovery](/docs/guides/adapter-recovery/) for the stage rules.

`WaitAbortedError` stops local waiting and carries the operation reference. It does not cancel provider compute. Closing the client with `close()` stops its waiting without destroying sandboxes. For checked command execution, `NonzeroExitError` and `NoExitCodeError` keep the available command output in `result`.

The legacy `onReference` connection option remains available for applications that save operation checkpoints. Ordinary snapshot and resource-reference persistence does not require it. If the callback fails, Sandbar stops subsequent stage effects and reports `REFERENCE_SAVE_FAILED`. The error preserves any known partial native result and the latest operation `reference`, including the checkpoint that could not be saved. Save that reference again or pass it to `recover()` before deciding whether to continue. Existing native stage guards and saved operation formats remain supported.

References do not grant access. A fresh connection must use authorized current credentials and the same verified scope. For E2B credential rotation, configure `teamId`; Sandbar verifies it to establish a stable team scope. Daytona's scope includes its organization, target, endpoint and selected network policy.
