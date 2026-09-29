# SDK recovery outcomes and adapter support

Accepted follow-up direction · September 29, 2026 · Planned, not implemented

After the current snapshot/volume slice, make partially completed operations understandable without decoding provider tokens, and reduce repeated recovery sequencing work for adapter authors. Keep the existing public snapshot, restore, volume, and explicit continuation methods. This specifies the next bounded SDK/public-adapter unit, not a redesign of the successful call flow.

## Boundary with the current PR

The [state portability completion criteria](provider-state-portability.md#9-current-pr-completion-and-follow-up-boundary) remain in PR #25: stale observation/continuation ordering, retained-volume custody before destruction, valid isolation assertions, and accurate release/evidence claims. Those bugs must not be deferred to this follow-up. This unit builds on their fixes.

Keep the [credential-independent reference and continuation contract](provider-state-portability.md#application-owned-persistence-and-credential-independent-references): application-owned JSON persistence, current provider authorization, read-only observation, and explicit continuation of proven unsubmitted stages. No SDK database, provider-key HMAC, implicit replay, or service dependency. Applications still serialize continuation across processes.

## 1. Stable typed partial outcomes

A caller must be able to answer “did capture finish, where is the retained snapshot, what happened to the source, and can this operation continue?” using public types. Today those facts can require parsing provider-specific recovery tokens. Keep those tokens opaque to application code.

Expose the same normalized facts through operation handles, recovered operations, and errors that end a convenience wait. Fit the result into existing operation/error types where possible; a new exception class is not itself a requirement. Resolve final field names and additive signatures during implementation, with compiled examples proving consistent access across these surfaces.

The public model must express:

- The operation recovery reference and every known retained resource reference, even when the overall operation did not complete.
- Confirmed completed work and its guarantees, such as captured preservation and restored execution semantics. Unknown effects must remain distinct from confirmed completion or definitive failure.
- Last observed source lifecycle state, with observation freshness/provenance explicit. Historical state must not be presented as a guarantee that the source is still running now.
- The failed, pending, or uncertain logical step, independently of other completed steps. Capture and source-restart failures must remain separately representable.
- Whether explicit continuation is supported and currently eligible, unavailable, or unknown, with an actionable reason. Eligibility is advisory: continuation revalidates native state and dispatch authority before effects.

For example, successful capture followed by failed restart exposes the snapshot reference and confirmed capture facts alongside the restart failure. A cancelled wait during an uncertain capture exposes the operation reference and any known resources without inventing a completed snapshot. Compute destruction after observed mounts still exposes retained volumes independently of compute termination.

The normalized facts must be bounded, serializable, and retained through the existing persistence lifecycle. They must survive JSON roundtrips, a fresh SDK connection, credential rotation, and source deletion where the resource itself survives. Do not depend on an in-memory result cache or require a provider-specific JSON parser. Persisted formats need explicit version handling; an older reference missing facts reports unknown instead of fabricating them.

Application examples must show both convenience error handling and explicit submission/recovery. They must obtain and reopen a retained snapshot without inspecting a token, and distinguish a currently eligible continuation from an uncertain request that must only be observed.

## 2. Small shared recovery helpers and conformance

The shared runtime owns ordering of operation state installation and persistence. An older observation must not replace a newer dispatch checkpoint; this correctness fix lands in the current PR. The follow-up adds reusable support around the repeated provider sequence:

1. Prepare a bounded stage checkpoint containing known resource and correlation facts.
2. Await its durable dispatch barrier.
3. Recheck cancellation before dispatch.
4. Dispatch once and retain the acknowledgement/new native identities.
5. Persist new facts and reconcile unresolved effects through reads.

Extract helpers only for repetition demonstrated by the Daytona/E2B implementations. Providers still define native stages, identity evidence, safe transitions, and terminal-state meaning. Helpers must not infer provider guarantees, auto-retry an uncertain mutation, or become a general workflow engine. Keep the distinction between explicit caller-selected resource deletion and correlated incidental cleanup.

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
