# Implementation sequence

Updated September 29, 2026. SDK completeness and qualified provider integrations come first. The optional service is a distant milestone.

## Delivery rule

New features ship through the direct SDK and public adapter API. New HTTP routes, remote-client parity, durable service orchestration, persistence/migrations, service tracing, and management UI work are not feature acceptance or release requirements.

Preserve existing service behavior and keep existing regression checks passing. Make narrow compatibility fixes when shared contracts change; do not expand the service to mirror each new SDK feature. Document SDK-only support explicitly. This decision does not delete the service or remove existing tests, and does not weaken SDK scope validation, recovery references, unknown-effect handling, or no-replay guarantees.

## Current: complete the snapshot and volume PR

[PR #25](https://github.com/pandemicsyn/sandbar/pull/25) implements snapshot capture/inspect/restore/delete, retained volumes, and supported create-time mounts under the [state portability spec](../specs/provider-state-portability.md). It is in review, not merged behavior.

Finish the [current PR acceptance fixes](../specs/provider-state-portability.md#9-current-pr-completion-and-follow-up-boundary): prevent stale observation from overwriting continuation checkpoints; persist retained-volume custody before compute destruction; prove two-way filesystem write isolation; and correct release/evidence claims. Check the latest revision rather than assuming every reviewed finding is still open. Add focused regressions and final independent review/required gates. Missing live evidence stays explicitly unverified; paid runs need separate authorization.

### Completion status and remaining gates

The implementation and focused regressions now address stale observation checkpoints, retained-volume custody, native artifact identity, immutable recovery references, two-way filesystem isolation checks, explicit deletion safeguards, and checkpoint persistence. Subsequent review also requires Daytona destruction to preserve known pre-dispatch rejection and recover confirmed absence after an uncertain DELETE without replay. Keep this work in the current PR until current-head independent review and required GitHub checks pass; do not treat an earlier green revision as completion.

Live validation remains a separate evidence gap. Historical E2B and Daytona snapshot round trips passed, but the new two-way isolation assertions and latest recovery fixes have only deterministic fixture coverage. The authorized live-run budgets are exhausted. Daytona's private diagnostic capture wait is ten minutes; a longer wait is not evidence that a workflow passed. Additional paid qualification needs renewed authorization, and current support claims must retain these limits.

After the current PR passes its gates, update the completion status and retain the contracts in `specs/`. Do not archive the state portability spec while its lifecycle and richer storage work remain planned; completed implementation-plan entries can move into historical context without marking those follow-ups complete.

Do not expand this PR into richer volume metadata, mounted restore, or a new public partial-outcome API. Existing correctness and resource-custody guarantees are required now.

## Next: SDK recovery outcomes and adapter support

Implement [the focused follow-up spec](../specs/sdk-recovery-dx.md):

1. Stable typed partial outcomes on errors, operation handles, and recovered operations, including retained resources, completed work, observed source state, unresolved steps, and continuation eligibility. Application code must not decode provider tokens.
2. Small shared checkpoint/dispatch helpers and reusable recovery conformance tests. Keep native evidence and transitions in adapters; preserve application-owned persistence and explicit continuation without replay.

This is the next bounded unit after the current PR, not a prerequisite for fixing its correctness findings. No general workflow engine or service persistence is included.

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
