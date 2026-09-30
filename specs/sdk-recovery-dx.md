# SDK recovery outcomes and adapter support

SDK and public-adapter implementation contract · September 29, 2026

This bounded SDK/public-adapter unit makes partially completed operations understandable without decoding provider tokens and reduces repeated recovery sequencing work for adapter authors. It preserves existing successful sandbox, snapshot, restore and volume call shapes, native defaults and explicit continuation methods.

## Boundary with the completed portability slice

The [state portability completion criteria](provider-state-portability.md#9-current-pr-completion-and-follow-up-boundary) landed in merged PR #25: stale observation/continuation ordering, retained-volume custody before destruction, valid isolation assertions, and accurate release/evidence claims. This unit builds on their fixes.

Keep the [credential-independent reference and continuation contract](provider-state-portability.md#application-owned-persistence-and-credential-independent-references): application-owned JSON persistence, current provider authorization, read-only observation, and explicit continuation of proven unsubmitted stages. No SDK database, provider-key HMAC, implicit replay, or service dependency. Applications still serialize continuation across processes.

## 1. Stable typed partial outcomes

A caller must be able to answer “did capture finish, where is the retained snapshot, what happened to the source, and can this operation continue?” using public types. The normalized outcome removes the need to parse provider-specific recovery tokens. Keep those tokens opaque to application code.

Direct `AdapterOperation.outcome` and optional `SandbarError.outcome` expose `RecoveryOutcome`: the direct operation `reference` plus `RecoveryFacts`. `OutcomeUnknownError` and `WaitAbortedError` attach these facts for direct recovery references; service errors and failures before recovery evidence exists may omit them. `recoveryOutcome(reference)` provides the same normalization for a saved direct reference. Provider tokens remain opaque. Compiled examples prove consistent access across these surfaces.

`RecoveryFacts` version `1` uses these fields:

- `retainedResources: ResourceReference[]` for known surviving artifacts.
- `completed[]` entries with a logical `step`, optional `capture` guarantees and optional `restoreExecution` facts.
- Optional `source: { state, observedAt, provenance }`, where the time is ISO and provenance is `provider-read` or `acknowledgement`.
- `steps[]` entries with `step`, `status: "pending" | "uncertain" | "failed" | "completed"` and an optional reason.
- `continuation: { supported, status, reason }`, separating support (`true | false | "unknown"`) from eligibility (`"eligible" | "unavailable" | "unknown"`).

The facts schema validates a maximum of 16 KiB serialized UTF-8 JSON, 32 retained resources, 16 completed entries and 16 steps. Step names are bounded to 128 characters and reasons to 1,024. The existing 16 KiB budget still applies to the base reference; the complete reference including facts is capped at 48 KiB. The public outcome combines saved facts with up to 32 envelope mount references, exposing at most 64 known resource references without persisting duplicate histories. References and outcomes are sealed copies; public edits cannot change internal dispatch authority. `AdapterRecoveryReference.facts` is optional for compatible older references, which normalize to unknown completion and continuation evidence instead of success. An unsupported facts version is rejected.

The public model must express:

- The operation recovery reference and every known retained resource reference, even when the overall operation did not complete.
- Confirmed completed work and its guarantees, such as captured preservation and restored execution semantics. Unknown effects must remain distinct from confirmed completion or definitive failure.
- Last observed source lifecycle state, with observation freshness/provenance explicit. Historical state must not be presented as a guarantee that the source is still running now.
- The failed, pending, or uncertain logical step, independently of other completed steps. Capture and source-restart failures must remain separately representable.
- Whether explicit continuation is supported and currently eligible, unavailable, or unknown, with an actionable reason. Eligibility is advisory: continuation revalidates native state and dispatch authority before effects.

For example, successful capture followed by failed restart exposes the snapshot reference and confirmed capture facts alongside the restart failure. A cancelled wait during an uncertain capture exposes the operation reference and any known resources without inventing a completed snapshot. Compute destruction after observed mounts still exposes retained volumes independently of compute termination.

The normalized facts must be bounded, serializable, and retained through the existing persistence lifecycle. They must survive JSON roundtrips, a fresh SDK connection, credential rotation, and source deletion where the resource itself survives. Do not depend on an in-memory result cache or require a provider-specific JSON parser. Persisted formats need explicit version handling; an older reference missing facts reports unknown instead of fabricating them.

The [compiled public example](../apps/docs/examples/recovery-outcomes.ts) shows convenience error handling and explicit submission/recovery, reopens retained snapshots without inspecting tokens, and distinguishes currently eligible continuation from uncertain work that must only be observed. The [recovery guide](../apps/docs/src/content/docs/docs/guides/recovery.md) explains the application contract.

`Sandbar.connect(daytona(config), { onReference })` and the equivalent E2B bound-adapter form accept the awaited application persistence hook alongside observability. Empty `config`/`credentials` boilerplate is unnecessary. `DirectConnectOptions` names these connection options. Successful calls retain their existing shapes and defaults.

Direct `recover(reference)` returns a `RecoveredOperation` union, narrowed by `operation.kind`: snapshot capture produces `SnapshotResult`, volume creation a volume handle, create/restore a sandbox handle, and the other kinds their existing safe results. There are no unchecked caller-supplied result generics. Exported `DirectClient` and `DirectSandboxHandle` make direct snapshots and volumes discoverable without adding them to the service `SandbarClient` contract.

## 2. Small shared recovery helpers and conformance

The shared runtime owns ordering of operation state installation and persistence. An older observation must not replace a newer dispatch checkpoint; this correctness fix landed in PR #25. The follow-up adds reusable support around the repeated provider sequence:

1. Prepare a bounded stage checkpoint containing known resource and correlation facts.
2. Await its durable dispatch barrier.
3. Recheck cancellation before dispatch.
4. Dispatch once and retain the acknowledgement/new native identities.
5. Persist new facts and reconcile unresolved effects through reads.

The shared `checkpointBeforeDispatch(ctx, token)` helper awaits `ctx.checkpoint(token)` and returns whether cancellation still permits dispatch. Providers return pending when it returns false. A pure `Mutation.recovery.facts(token)` mapper derives normalized public evidence, validated by the runtime and persisted through the existing SDK checkpoint path. Extract helpers only for repetition demonstrated by the Daytona/E2B implementations. Providers still define native stages, identity evidence, safe transitions, and terminal-state meaning. Helpers must not infer provider guarantees, auto-retry an uncertain mutation, or become a general workflow engine. Keep the distinction between explicit caller-selected resource deletion and correlated incidental cleanup.

Add shared conformance scenarios for failure before/after checkpoint persistence, lost acknowledgements, cancellation while checkpointing, stale observations racing continuation, delayed capture, retained resources after partial failure, and recovery with a fresh connection. Include adversarial fixtures that would duplicate effects if ordering regressed. Reuse the SDK's actual persistence path rather than testing a separate model of it.

A helper without a persistence hook must not claim crash durability. Document application responsibilities for durable writes and cross-process serialization; do not silently add a store or lock service.

## Acceptance and delivery

- Deliver typed outcomes, public usage examples, and adapter conformance as one bounded follow-up. Demonstrate both Daytona cold-capture/source-restart outcomes and E2B native memory capture, while preserving their differences.
- Application examples compile against packed public packages and never inspect provider tokens. Resource references reopen using fresh valid credentials in the same native scope.
- Confirmed partial facts survive failed waits and recovery. Unknown or failed effects cannot be promoted to success by normalization. Public fields cannot mutate internal dispatch authority.
- Existing recovery formats have explicit compatibility behavior, and errors remain useful when no partial evidence exists. Preserve current happy-path ergonomics and no-replay guarantees.
- Use deterministic tests for fault boundaries, package/typing checks for public API changes, and update the public recovery/provider docs. No new live feature guarantee is implied by this refactor; any needed paid validation requires separate authorization.
- Preserve existing service regression coverage without implementing new service outcomes or orchestration. Do not bundle volume capability expansion, new providers, or other SDK feature work into this unit.

## Later: volume guarantees and mounted restore

Schedule these with a concrete provider implementation after the recovery unit, rather than making them prerequisites for PR #25:

- Separate backing technology from observable visibility, rename, locking, concurrent-writer behavior, and durability boundaries. Unknown is valid, but shared schemas must allow verified stronger guarantees. Do not equate object-backed storage with one filesystem contract or reduce durability to an unexplained boolean.
- Add capacity/placement requirements only when a provider/use case demonstrates the need. Keep real provider defaults in typed adapter configuration; do not introduce a generic provider-options bag.
- Replace central mounted-restore rejection only when an adapter can implement and verify it. Capabilities describe supported share/replace/omit choices and compatibility constraints; each recorded mount needs an explicit disposition. Enforce choices before restored processes execute, particularly for memory snapshots. Unknown provenance cannot silently authorize omission or sharing.

Write the concrete request/result details and qualification cases when that provider work is scheduled. Until then, document the current limitations without advertising inactive extension points as implemented support.
