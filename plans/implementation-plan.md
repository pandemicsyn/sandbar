# Implementation sequence

Updated September 30, 2026. SDK completeness and qualified provider integrations come first.

## Delivery rule

New features ship through the SDK and public adapter API.

SDK scope validation, recovery references, unknown-effect handling, and no-replay guarantees remain mandatory.

## Merged SDK foundation and current queue

Snapshot/volume support merged in PR #25; provider acceptance merged in PR #32; ordinary results, partial errors and provider-identifying snapshot/volume handles merged in PR #33. The [roadmap](../ROADMAP.md) records verification at `d186cea` and the current delegated tasks. Use current package code and tests for shipped behavior.

The merged [acceptance tooling](../packages/sdk-qualification/provider-qualification/README.md) uses ordinary Bun suites and an offline generated support table. Preserve actual historical revisions, blocked access and not-run evidence. A fixture pass is not live qualification. PR30's still-relevant documentation is being selectively reconciled against main, rather than cherry-picked wholesale.

Public types/errors merged in PR #35 and cleanup configuration in PR #34. Lifecycle slice 1 reopen/inspect is in progress, not merged. The streaming/cancellation brief merged in PR #36 as spec work only. Connection `cleanup.storage` and per-call `storage` are available. Later timeout mutation and suspend/resume retain product decisions and dependencies in the [lifecycle spec](../specs/sandbox-lifecycle.md).

[Recovery direction](../specs/sdk-recovery-dx.md) keeps ordinary calls and application-owned persistence central. Expanded persistence callbacks, normalized recovery-facts envelopes, application-backed dispatch barriers and generic continuation/workflow machinery are deferred. Shipped compatibility paths and no-replay/deletion safeguards remain supported.

## Later state extensions with concrete provider requirements

- Evolve volume metadata to separate backing from filesystem semantics and durability boundaries. Add capacity/placement only when needed by an actual provider/use case.
- Implement capability-driven share/replace/omit mounted restore with enforcement before restored execution, alongside an adapter that can prove it.
- Complete suspend/resume and lifetime controls, followed by optional volume versions and native forks where justified by the [state contract](../specs/provider-state-portability.md).

Keep these scoped separately from the recovery follow-up. Current limitations remain explicit until implementations and appropriate qualification exist.

## Implemented: SDK tracing and diagnostics

The direct tracing/diagnostics and OpenTelemetry, Sentry, and Datadog recipes from the [observability spec](../specs/sdk-observability.md) merged in PR #24. Bounded metrics and structured diagnostic events remain later work after tracing is stable.

## Broaden the SDK and provider coverage

- Develop [interactive execution and access](../specs/interactive-execution-and-access.md): processes, streams, terminals, endpoints, and tunnels.
- Close remaining SDK gaps in images, resource configuration, files, and networking as focused contracts with demonstrated use cases.
- Establish several usable, qualified provider integrations. Vercel and Tensorlake specs will be written when scheduled; provider distribution and ordering remain in [package conventions](../specs/package-conventions.md).

New providers remain behind the roadmap’s SDK usability gate. Universal native parity is not required; support claims still require evidence.

## Existing implementation and evidence

The SDK and public adapter API already exist. Use [architecture](../specs/design.md), [public documentation](../apps/docs/README.md), and [qualification](../packages/sdk-qualification/README.md) for current behavior and evidence. Completed and superseded plans are available in Git history.

Publication, deployment and paid provider calls require separate authorization. This sequence does not authorize them or introduce additional feature requirements from removed specs.
