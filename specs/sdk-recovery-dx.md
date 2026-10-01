# SDK results, errors and persisted resource identities

Accepted direction · September 30, 2026 · Focused implementation merged in PR #33 at `d186cea`

PR #33 shipped provider identity on snapshot/volume handles and ordinary typed partial outcomes while retaining existing compatibility formats and stage guards. The sketches below record design intent, not an exact API inventory; use [current usage](../apps/docs/src/content/docs/docs/guides/recovery.md) and public types for shipped signatures. In particular, existing version-1 references still accept compatibility history/receipt fields. Expanded persistence hooks, normalized facts envelopes and generic workflow machinery remain deferred.

Sandbar makes provider operations convenient and their outcomes understandable. Applications own persistence and recovery policy. Ordinary function calls return useful results or clear errors, with the identities needed to reopen known resources from another process. This direction supersedes the earlier requirements here for normalized recovery-facts envelopes, expanded persistence callbacks, shared durable checkpoint helpers and generic continuation advice.

The snapshot/volume foundation merged in PR #25. Preserve its native identity and scope validation, configured capture defaults, deletion safeguards, and protection against replaying uncertain mutations. Existing runtime recovery facilities are compatibility concerns, not a requirement to expand every SDK operation into a durable workflow.

## 1. Ordinary snapshot results

Keep `const captured = await sandbox.snapshot()` as the primary API. Its result contains the snapshot handle, actual capture preservation and the source state observed when the call finishes. The proposed public surface is:

```ts
type SnapshotResult = {
  snapshot: SnapshotHandle;
  capture: {
    preserve: "filesystem" | "filesystem+memory";
    // Keep existing meaningful capture guarantees where callers need them.
  };
  source: {
    state: SandboxState;
    // Include an observation timestamp when reporting historical state.
  };
};

interface SnapshotHandle {
  readonly provider: string;
  readonly id: string;
  readonly reference: SnapshotReference;
  // Existing inspect(), restore() and delete() signatures remain applicable.
}
```

This is an intended surface, not a claim that new fields already ship. Use the current public enum/signature conventions and retain useful existing capture fields; no unrelated snapshot-options redesign is required. The handle is bound to its provider connection. `provider` must be directly discoverable on the snapshot and present in its serialized reference, including when the snapshot appears in a partial error. The same identity principle applies to volume handles.

Daytona reports its filesystem capture and source lifecycle; E2B reports the configured native filesystem-plus-memory capture. Provider differences remain explicit in those actual results. No successful result needs operation history, persistence phases or continuation eligibility.

## 2. Minimal serializable resource references

A resource reference contains only information necessary to identify, locate and safely reopen the exact resource:

- Format version and resource kind.
- Provider identity.
- Stable native identity, including immutable generation/build identity for reusable locators.
- Native scope/routing information required for verification and reopening with current credentials.
- Any additional native identity or selector genuinely required for supported restore or deletion, with its purpose documented.

An ID alone must not silently resolve to a newer artifact after a mutable name/tag changes. E2B's immutable captured-build selector and separate containing-resource deletion identity remain necessary where its native mapping requires them. Preserve this correctness without growing the reference into a workflow journal. Current reference fields required for safe identity/deletion checks must be assessed before removal; compatibility work must not weaken authorization or incidental-cleanup safeguards.

References contain no credentials, callbacks, client instances, previous observations, operation stages, accumulated histories or dispatch instructions as part of the new ordinary resource contract. A reference is a locator, not an authorization token. Reopening verifies current credentials and matching native scope. A mismatched provider is rejected before native calls. A handle's display `id` does not replace the complete reference where native identity requires more than one field.

```ts
// First process: persistence is an ordinary application operation.
const captured = await sandbox.snapshot();
console.log(captured.snapshot.provider, captured.snapshot.id);
await database.save(captured.snapshot.reference);

// Later: configure the provider identified by the saved reference.
const snapshot = await freshClient.snapshots.get(savedReference);
const restored = await snapshot.restore();
```

These sketches describe the proposed workflow. The implementation must add compiled examples against public packages. Reopening a retained snapshot must work after source deletion where the provider supports that lifetime, without the original client or credential. Applications may save result metadata separately when they need it; historical observations must not be presented as fresh provider state.

There is no 16 KiB recovery-facts budget for the ordinary snapshot result or its resource identity. Validate individual fields according to real native constraints and validate reference versions/input. A generated summary size limit must not turn confirmed completion into `OUTCOME_UNKNOWN`, and no resource identity may be silently trimmed. Avoid duplicating data instead of adding larger completion envelopes to fit bookkeeping.

## 3. Clear errors preserve what is known

Use existing error conventions where practical. Errors distinguish definitive rejection, confirmed partial completion and provider uncertainty. Known resource identities and meaningful confirmed results remain directly accessible through typed fields; callers do not parse native tokens or reconstruct a result from several facts arrays. Final names should fit current public types, with one authoritative representation of each result.

For capture followed by a definitive source-restart failure, the intended information is:

```ts
// Illustrative error data, not a required new error class.
{
  code: "SOURCE_RESTART_FAILED",
  outcome: {
    status: "partial",
    snapshot: snapshotReference, // includes provider
    capture: { status: "completed", preserve: "filesystem" },
    restart: { status: "failed" }
  }
}
```

The snapshot is usable even though the composite call failed. A failed/uncertain restart must be distinguished; neither implies another capture should be submitted. Preserve every known retained resource needed for access or cleanup, including volumes that survive compute destruction. Confirmed completion remains confirmed even if optional descriptive metadata cannot be assembled.

A timeout or lost provider response after dispatch reports an unconfirmed effect, such as the existing `OUTCOME_UNKNOWN`, with any IDs, native operation handles and partial results already received. Do not retry creation automatically or invent success from missing evidence. Stopping a local wait does not cancel native compute.

Where supported, ordinary resource `list`, `get` and `inspect` methods let applications investigate. Native operation handles, idempotency keys or reliable correlation can be exposed when actually supported. Listing resources alone does not prove which one belongs to a failed request, and absence from a listing is not necessarily proof of no effect. Do not add a discovery API or provider emulation to this PR just to make uncertainty universally resolvable; document current supported discovery and its limitations.

## 4. Applications own persistence and recovery policy

The normal workflow is call, receive a result, save its reference, and reopen later. If the application's save fails after capture, that is an application storage failure; the caller already has the successful result. Sandbar does not need to intercept that save or convert it into an SDK persistence error.

There is a crash window between native creation and application persistence. Document it honestly. Native idempotency or discovery may help where available; a callback alone does not guarantee recovery or exactly-once execution. Applications choose whether to reconcile, retry, alert an operator, or use a durable orchestration system.

Defer new/expanded `onReference` hooks, dispatch barriers backed by application storage, persistence-phase error types, generic completion-facts descriptors and generic continuation/next-action machinery. These are not acceptance criteria for this PR or for a new provider adapter. They require a demonstrated advanced use case and native support before further design.

Preserve already-shipped APIs/formats as necessary, and keep existing recovery read-only and no-replay guarantees. Do not remove legacy checkpoints, stage guards or formats blindly during the scope reduction. Compatibility-only callback paths must still preserve confirmed results if their writes fail. State clearly what is retained for compatibility; the main public examples must teach ordinary calls and resource-reference persistence.

## Acceptance and delivery

This checklist records the merged PR #33 scope; it does not reopen that PR or mark later proposals implemented.

- Center results, errors and identities. Exclude generic persistence/continuation additions and tests/docs that exist only to qualify that expanded contract. Keep independently useful correctness fixes and typed native pending-operation results where justified.
- Make provider identity discoverable on snapshot/volume handles and their saved references. Preserve immutable artifact identity, scope verification and existing deletion safeguards.
- Prove successful snapshot capture, JSON persistence and reopening through a fresh connection; preserve supported source-independent lifetime and current-credential behavior.
- Prove partial capture/restart errors expose the retained snapshot directly, unknown responses remain unknown, and no mutation is automatically replayed. Metadata/serialization failures must not conceal known completion or discard an identity.
- Add focused deterministic tests, compiled public usage examples and accurate provider docs. Native listing/reconciliation limitations are documented rather than filled by a general recovery framework. No new paid/live calls are authorized by this spec.
- Review the revised scope and diff independently, then run relevant package/API, docs and required CI checks. The user owns final review and merge.

## Later: volume guarantees and mounted restore

Schedule these with a concrete provider implementation after this DX unit, rather than making them prerequisites for PR #25:

- Separate backing technology from observable visibility, rename, locking, concurrent-writer behavior, and durability boundaries. Unknown is valid, but shared schemas must allow verified stronger guarantees. Do not equate object-backed storage with one filesystem contract or reduce durability to an unexplained boolean.
- Add capacity/placement requirements only when a provider/use case demonstrates the need. Keep real provider defaults in typed adapter configuration; do not introduce a generic provider-options bag.
- Replace central mounted-restore rejection only when an adapter can implement and verify it. Capabilities describe supported share/replace/omit choices and compatibility constraints; each recorded mount needs an explicit disposition. Enforce choices before restored processes execute, particularly for memory snapshots. Unknown provenance cannot silently authorize omission or sharing.

Write the concrete request/result details and qualification cases when that provider work is scheduled. Until then, document the current limitations without advertising inactive extension points as implemented support.
