# Implementation sequence

Updated September 29, 2026. SDK completeness and qualified provider integrations come first. The optional service is a distant milestone.

## Delivery rule

New features ship through the direct SDK and public adapter API. New HTTP routes, remote-client parity, durable service orchestration, persistence/migrations, service tracing, and management UI work are not feature acceptance or release requirements.

Preserve existing service behavior and keep existing regression checks passing. Make narrow compatibility fixes when shared contracts change; do not expand the service to mirror each new SDK feature. Document SDK-only support explicitly. This decision does not delete the service or remove existing tests, and does not weaken SDK scope validation, recovery references, unknown-effect handling, or no-replay guarantees.

## Current: complete the snapshot and volume PR

[PR #25](https://github.com/pandemicsyn/sandbar/pull/25) implements snapshot capture/inspect/restore/delete, retained volumes, and supported create-time mounts under the [state portability spec](../specs/provider-state-portability.md). It is in review, not merged behavior.

Finish the [current PR acceptance fixes](../specs/provider-state-portability.md#9-current-pr-completion-and-follow-up-boundary): prevent stale observation from overwriting continuation checkpoints; persist retained-volume custody before compute destruction; prove two-way filesystem write isolation; and correct release/evidence claims. Check the latest revision rather than assuming every reviewed finding is still open. Add focused regressions and final independent review/required gates. Missing live evidence stays explicitly unverified; paid runs need separate authorization.

### Completion status and remaining gates

The implementation and focused regressions now address stale observation checkpoints, retained-volume custody, native artifact identity, immutable recovery references, two-way filesystem isolation checks, explicit deletion safeguards, and checkpoint persistence. Daytona destruction now preserves known pre-dispatch rejection and recovers confirmed absence after an uncertain DELETE without replay; capture/deletion distinguish definitive native rejection from ambiguous failures. Compact artifact checkpoints and bounded capture names cover valid large inputs. Both providers reject oversized compute-cleanup custody before destruction without truncating retained identities. Keep this work in the current PR until current-head independent review and required GitHub checks pass; do not treat an earlier green revision as completion.

Renewed live authorization validated both providers' snapshot round trips at `5db0558`, including two-way write isolation and serialized references reopened through a fresh connection after source deletion. Daytona volume persistence and exact cleanup also passed. E2B volume creation returned HTTP 403 in a focused follow-up; the adapter now durably records definitive native rejection and recovers it without replay. The earlier E2B volume attempt lacks a captured native status and remains uncertain despite complete inventory finding no matching volume. Do not claim E2B volume acceptance or erase that unresolved custody record. These are unmerged diagnostic results, not published support-matrix certification. Daytona's private diagnostic capture wait is ten minutes.

After the current PR passes its gates, update the completion status and retain the contracts in `specs/`. Do not archive the state portability spec while its lifecycle and richer storage work remain planned; completed implementation-plan entries can move into historical context without marking those follow-ups complete.

A bounded consolidation review covers the failure classes already found: size and native identifier bounds, kind/scope binding, cancellation, uncertain dispatch, stale observation, retained custody, destructive target checks, and observation without replay. The confirmed size-limit defects have focused regressions. Feature scope is frozen; optional improvements belong in the follow-up. Oversized cleanup custody must fail clearly before native destruction, without truncating retained identities.

Do not expand this PR into richer volume metadata, mounted restore, or a new public partial-outcome API. Existing correctness and resource-custody guarantees are required now.

## After PR #25: simplify provider acceptance

Follow [the provider acceptance plan](provider-acceptance.md): retain meaningful live SDK workflows, consolidate branch and release testing into one maintained runner, and generate a small support matrix with explicit provider limitations and validation status. Schedule this cleanup before onboarding more adapters; it does not block or expand PR #25.

## Current SDK DX: results, errors and resource identities

Follow the September 30 direction in [the focused spec](../specs/sdk-recovery-dx.md) when revising PR #33:

1. Ordinary calls return clear confirmations or errors and preserve known partial results directly.
2. Snapshot and volume handles identify their provider; minimal serializable references reopen the exact native artifact with current credentials in a fresh process.
3. Ambiguous native responses remain unconfirmed, without automatic replay. Applications own persistence and recovery policy and can use supported native discovery/inspection.

Expanded persistence callbacks, generic completion-facts envelopes, application-backed dispatch barriers and generic continuation advice are deferred. Preserve necessary shipped compatibility and safety guards; do not expand legacy operation recovery into a prerequisite for usable resource APIs. The root [roadmap](../ROADMAP.md) controls sequencing and status.

## Later state extensions with concrete provider requirements

- Evolve volume metadata to separate backing from filesystem semantics and durability boundaries. Add capacity/placement only when needed by an actual provider/use case.
- Implement capability-driven share/replace/omit mounted restore with enforcement before restored execution, alongside an adapter that can prove it.
- Complete suspend/resume and lifetime controls, followed by optional volume versions and native forks where justified by the [state contract](../specs/provider-state-portability.md).

Keep these scoped separately from the recovery follow-up. Current limitations remain explicit until implementations and appropriate qualification exist.

## Implemented: SDK tracing and diagnostics

The direct tracing/diagnostics and OpenTelemetry, Sentry, and Datadog recipes from the [observability spec](../specs/sdk-observability.md) merged in PR #24. Bounded metrics and structured diagnostic events remain later work after tracing is stable. Service propagation, persisted trace context, and runner tracing remain deferred with the service.

## Broaden the SDK and provider coverage

- Develop [interactive execution and access](../specs/interactive-execution-and-access.md): processes, streams, terminals, endpoints, and tunnels.
- Close remaining SDK gaps in images, resource configuration, files, and networking as focused contracts with demonstrated use cases.
- Establish several usable, qualified provider integrations. Vercel and Tensorlake specs will be written when scheduled; provider distribution and ordering remain in [package conventions](../specs/package-conventions.md).

Provider integrations can proceed alongside SDK features where contracts are ready. Do not wait for universal native feature parity or claim support without evidence.

## Distant milestone: optional service

Revisit service expansion only after the SDK feature set is mature, several provider integrations have useful qualification, and a concrete service use case justifies the work. Existing Daytona/E2B baseline support alone does not trigger this milestone.

Then scope HTTP/remote-client coverage, durable background orchestration and recovery, persistence and authorization, service observability, and any management workflows against actual needs. Feature parity must be selected deliberately at that time; it is not an automatic backlog attached to every SDK change.

Accounting remains separate and deferred. Rust is not on the roadmap. Effect remains parked and is not an implementation or release gate.

## Existing implementation and evidence

The SDK, public adapter API, optional service and management UI already exist. Use [architecture](../specs/design.md), [public documentation](../apps/docs/README.md), and [qualification](../packages/sdk-qualification/README.md) for current behavior and evidence. Completed and superseded plans are available in Git history.

Publication, deployment and paid provider calls require separate authorization. This sequence does not authorize them or introduce additional feature requirements from removed specs.
