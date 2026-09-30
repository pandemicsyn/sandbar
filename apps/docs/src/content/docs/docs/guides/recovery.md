---
title: Results, errors and saved resources
description: Save resource identities and choose application recovery policy.
---

Ordinary calls return useful results. Applications own persistence and decide what to do after failure.

```ts
const captured = await sandbox.snapshot();
console.log(captured.snapshot.provider, captured.snapshot.id);
await database.save(captured.snapshot.reference);

// Later, using current credentials and the matching provider/scope:
const snapshot = await freshClient.snapshots.get(savedReference);
const restored = await snapshot.restore({ networkPolicy: "blocked" });
```

Save the complete versioned reference, rather than just its display ID. It includes provider, scope and immutable native selectors. E2B captures select an exact build, while the containing template ID is also needed for deletion. A changed default tag cannot replace the captured build. Volume handles also expose `provider`, `id` and `reference`.

Daytona captures filesystem state and may stop and restart the source. E2B captures filesystem and memory, with native pause/resume behavior. The returned `capture` describes actual guarantees; `source` reports the state observed when the call finishes. An `observedAt` timestamp describes a historical observation, not fresh provider state. Snapshot restore mount support remains limited to the provider's supported contract.

A failure in `database.save` after the SDK returns is an application storage error: the caller still has the successful capture. There is a crash window between native creation and saving its reference. Applications choose storage and recovery policy; Sandbar does not promise exactly-once creation.

## Partial and unknown outcomes

If capture completes but a source restart definitively fails, `SandbarError.code` is `SOURCE_RESTART_FAILED`. Its typed `outcome` contains the snapshot reference (including provider), confirmed capture details and `restart.status: "failed"`. An uncertain restart stays `OUTCOME_UNKNOWN`, preserving the same useful result with `restart.status: "uncertain"`. Neither requires repeating capture.

A lost native response throws `OutcomeUnknownError`: an effect may have occurred. Any known IDs, native operation tokens or partial results are retained where available. If no snapshot identity was received, the SDK cannot manufacture one. Existing `snapshots.list`, `volumes.list`, `get` and `inspect` can help investigate where supported, but listing alone cannot associate an artifact with a failed request or prove no effect. Both built-in providers report snapshot inventory coverage as `provider-scope`. Inventory entries may lack provenance needed for restore or deletion; check the returned reference and inspect its supported guarantees.

Known volume references accompany uncertain compute cleanup in `outcome.retainedVolumes`. Compute removal and storage deletion are separate operations. Existing durable-storage checks and explicit deletion safeguards still apply.

The [compiled example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/recovery-outcomes.ts) demonstrates application persistence, fresh reopening and partial results.

## Existing asynchronous operations

The existing `submit*`, `recover`, `observe`, `wait` and explicit `continue` APIs remain available for native pending operations. `recover`, `observe` and `wait` do not replay mutations. An operation reference is useful only where the provider retains matching native identity or correlation; it cannot universally discover a missing ID. `null` observation means completion is not known.

`WaitAbortedError` stops local waiting and carries the operation reference. It does not cancel provider compute. `close()` stops client-owned waiting without destroying sandboxes. `NonzeroExitError` and `NoExitCodeError` preserve command output in `result`.

Legacy explicit adapter connection options still support `onReference` for callers already using checkpointed operation references. This compatibility API is not required by ordinary snapshot/reference persistence. Callback failure stops subsequent stage effects; `REFERENCE_SAVE_FAILED` preserves any known partial native result. Native stage guards and saved operation formats remain supported. See [Asynchronous adapter recovery](/docs/guides/adapter-recovery/) for adapter authoring details.

For E2B credential rotation, configure and verify `teamId` to establish a stable team scope. Daytona scope includes organization, target, endpoint and selected network policy. Reopening checks current credentials and matching scope; references grant no authorization.
