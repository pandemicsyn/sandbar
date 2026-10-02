# Implementation sequence

Updated October 2, 2026. SDK completeness and qualified provider integrations come first.

## Delivery rule

New features ship through the SDK and public adapter API.

SDK scope validation, recovery references, unknown-effect handling, and no-replay guarantees remain mandatory.

## Merged SDK foundation and current queue

The foundation and latest DX implementations are merged: snapshots/volumes (#25), provider acceptance (#32), ordinary partial results/resource identities (#33), cleanup configuration (#34), public types/errors (#35), docs reconciliation (#37), reopen/inspect (#38), read cancellation (#51), E2B text streaming (#52), output helpers (#53), bounded-exec timeout docs/fixtures (#54), and configured renewal (#55). The optional service and management UI were removed in #39. Use the [roadmap](../ROADMAP.md) for the authoritative queue and current package code/tests for shipped behavior.

The [acceptance tooling](../packages/sdk-qualification/provider-qualification/README.md) uses ordinary Bun suites and an offline generated support table. New reopening, renewal, streaming and cancellation behavior still needs its own authorized live evidence. Historical passes do not qualify new code; blocked access and failed probes remain visible.

The next implementation is no-argument suspend/resume with provider choices concentrated in adapter setup, as accepted in the [lifecycle spec](../specs/sandbox-lifecycle.md). Reopen/inspect and renewal prerequisites are merged. After this active slice, deliver [default creation and everyday files](../specs/sandbox-basics-dx.md): creation defaults and text helpers, then separately scoped directory primitives. Next deliver [preview access and useful process control](../specs/preview-and-process-control.md), resolving the brief's native access/identity decisions before coding. Preview, termination and subsequent stdin/output work should not become one large PR. Continue storage composition research, but schedule its implementation after these everyday workflow gaps.

[Recovery direction](../specs/sdk-recovery-dx.md) keeps ordinary calls and application-owned persistence central. Expanded persistence callbacks, normalized recovery-facts envelopes, application-backed dispatch barriers and generic continuation/workflow machinery are deferred. Shipped compatibility paths and no-replay/deletion safeguards remain supported.

## Later state extensions with concrete provider requirements

- Evolve volume metadata to separate backing from filesystem semantics and durability boundaries. Add capacity/placement only when needed by an actual provider/use case.
- Implement capability-driven share/replace/omit mounted restore with enforcement before restored execution, alongside an adapter that can prove it.
- Optional volume versions and native forks follow demonstrated need under the [state contract](../specs/provider-state-portability.md).

Keep these scoped separately from the merged recovery work. Current limitations remain explicit until implementations and appropriate qualification exist.

## Implemented: SDK tracing and diagnostics

The direct tracing/diagnostics and OpenTelemetry, Sentry, and Datadog recipes from the [observability spec](../specs/sdk-observability.md) merged in PR #24. Bounded metrics and structured diagnostic events remain later work after tracing is stable.

## Broaden the SDK and provider coverage

- The scheduled [preview/process brief](../specs/preview-and-process-control.md) extends the shipped [finite streaming contract](../specs/interactive-execution-and-access.md) through small independently reviewed slices. Other provider streams, terminals and tunnels remain separate later work.
- Close remaining SDK gaps in images, resource configuration, files, and networking as focused contracts with demonstrated use cases.
- Establish several usable, qualified provider integrations. Vercel and Tensorlake specs will be written when scheduled; provider distribution and ordering remain in [package conventions](../specs/package-conventions.md).

New providers remain behind the roadmap’s SDK usability gate. Universal native parity is not required; support claims still require evidence.

## Existing implementation and evidence

The SDK and public adapter API already exist. Use [architecture](../specs/design.md), [public documentation](../apps/docs/README.md), and [qualification](../packages/sdk-qualification/README.md) for current behavior and evidence. Completed and superseded plans are available in Git history.

Publication, deployment and paid provider calls require separate authorization. This sequence does not authorize them or introduce additional feature requirements from removed specs.
