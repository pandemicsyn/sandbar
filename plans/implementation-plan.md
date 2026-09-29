# Implementation sequence

Updated September 29, 2026. SDK completeness and qualified provider integrations come first. The optional service is a distant milestone.

## Delivery rule

New features ship through the direct SDK and public adapter API. New HTTP routes, remote-client parity, durable service orchestration, persistence/migrations, service tracing, and management UI work are not feature acceptance or release requirements.

Preserve existing service behavior and keep existing regression checks passing. Make narrow compatibility fixes when shared contracts change; do not expand the service to mirror each new SDK feature. Document SDK-only support explicitly. This decision does not delete the service or remove existing tests, and does not weaken SDK scope validation, recovery references, unknown-effect handling, or no-replay guarantees.

## In progress: SDK state portability

The direct SDK and public adapter API now implement snapshot capture → inspect → restore → delete, application-persisted recovery references, native volume lifecycle, and create-time mounts where the provider supports them. Daytona and E2B have different snapshot guarantees; E2B does not support create-time mounts in its pinned integration. These implemented surfaces have deterministic native-boundary and packed-consumer coverage. Historical live snapshot runs do not certify every final-head behavior or the corrected filesystem-isolation probe; keep provider support claims tied to actual qualification evidence.

The [state portability spec](../specs/provider-state-portability.md) remains active for these next slices:

1. Exact-preservation suspend/resume and lifetime controls, with execution-generation handling.
2. Optional volume versions and native forks where justified.

Continue to document provider differences and unsupported operations explicitly. Paid live qualification requires separate authorization; do not infer it from fixture coverage.

## In flight: SDK observability and diagnostics

Implement the [observability spec](../specs/sdk-observability.md) alongside SDK state portability:

1. Direct SDK operation/phase tracing, safe error correlation, and application-owned OpenTelemetry setup.
2. Tested direct SDK Sentry, Datadog, and plain OpenTelemetry recipes with separate Node/Bun and local/vendor evidence.
3. Bounded metrics and structured diagnostic events after tracing is stable.

Service propagation, persisted trace context, and runner tracing are deferred with the service. They do not block the SDK integration story.

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
