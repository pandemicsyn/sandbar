# Specifications

Keep this directory for focused implementation specs and a small set of current engineering contracts. Public usage belongs in [the docs site](../apps/docs/README.md), qualification belongs [with its harness](../packages/sdk-qualification/README.md), and sequencing belongs in [plans](../plans/implementation-plan.md).

New features target the direct SDK and public adapter API. Service expansion is deferred until the SDK is mature and several provider integrations are established; see the [delivery rule](../plans/implementation-plan.md#delivery-rule). Preserve existing service behavior and regression coverage, without requiring new feature parity.

## Active state design

- [Provider state portability](provider-state-portability.md) — direct SDK snapshots, core volumes and supported create-time mounts are implemented with provider-specific guarantees. Suspension, lifetime controls, optional volume versions and native forks remain proposed. Use the SDK and adapter source plus qualification evidence for current behavior; design sketches in the spec are not an API inventory.

## Planned observability

- [SDK observability and diagnostics](sdk-observability.md) — application-owned OpenTelemetry tracing, actionable SDK error/recovery correlation, and qualified Sentry/Datadog recipes. Implementation is in flight; service tracing is deferred. This is separate from accounting and does not expand the current state-portability unit.

## Later design work

- [Interactive execution and access](interactive-execution-and-access.md) — initial process, streaming, terminal, endpoint and tunnel contracts. Not an implementation commitment or a prerequisite for state portability.

Vercel and Tensorlake adapter specs will be written later. Accounting is deferred; management feature plans are not maintained here. Rust is not on the roadmap.

## Current engineering contracts

- [Architecture](design.md) — the implemented SDK, adapter and optional service boundaries.
- [Package conventions](package-conventions.md) — public names, dependencies and distribution rules.
- [Validation](validation-and-contracts.md) — executable schema ownership and boundary requirements.

For the current API, use the [SDK source](../packages/sdk/src/index.ts), [resource types](../packages/sdk/src/resource.ts), [adapter API](../packages/adapter/src/index.ts), and service [HTTP schemas](../apps/server/src/http-contracts.ts) / [OpenAPI](../apps/server/openapi.json). Do not duplicate their API inventory in a prose spec.

Superseded top-level plans have been removed; Git history preserves them. The pre-existing [historical archive](archive/README.md) is context only and does not establish requirements, provider support, or release gates. New superseded plans should normally be deleted rather than copied into that archive.
