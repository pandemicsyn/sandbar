# Specifications

Keep this directory for focused implementation specs and a small set of current engineering contracts. Public usage belongs in [the docs site](../apps/docs/README.md), qualification belongs [with its harness](../packages/sdk-qualification/README.md), and sequencing belongs in the [roadmap](../ROADMAP.md).

New features target the direct SDK and public adapter API. Service expansion is deferred until the SDK is mature and several provider integrations are established; see the [delivery rule](../plans/implementation-plan.md#delivery-rule). Preserve existing service behavior and regression coverage, without requiring new feature parity.

## Merged foundation and current work

- [Provider state portability](provider-state-portability.md) — snapshot/volume support merged in PR #25. Later lifecycle and richer storage contracts remain proposals until implemented.
- [SDK results, errors and persisted resource identities](sdk-recovery-dx.md) — ordinary results, direct partial outcomes and provider-identifying snapshot/volume handles merged in PR #33. Expanded persistence callbacks and workflow machinery remain deferred.
- Provider acceptance merged in PR #32; use the [maintained Bun runner](../packages/sdk-qualification/provider-qualification/README.md) and generated evidence, not proposed qualification behavior.
- Cleanup configuration, public types/errors and [lifecycle slice 1 reopen/inspect](sandbox-lifecycle.md) are delegated implementation work, not merged. Streaming/cancellation is delegated scoping only. See the [authoritative roadmap](../ROADMAP.md) for task identities and order. Later lifecycle choices and mounted storage composition remain later work.

## Implemented observability contract

- [SDK observability and diagnostics](sdk-observability.md) — direct SDK tracing/diagnostics and OpenTelemetry, Sentry, and Datadog recipes merged in PR #24. Metrics/events remain later work; service tracing is deferred.

## Later design work

- [Interactive execution and access](interactive-execution-and-access.md) — initial process, streaming, terminal, endpoint and tunnel contracts. Not an implementation commitment or a prerequisite for state portability.

Vercel and Tensorlake adapter specs will be written later. Accounting is deferred; management feature plans are not maintained here. Rust is not on the roadmap.

## Current engineering contracts

- [Architecture](design.md) — the implemented SDK, adapter and optional service boundaries.
- [Package conventions](package-conventions.md) — public names, dependencies and distribution rules.
- [Validation](validation-and-contracts.md) — executable schema ownership and boundary requirements.

For the current API, use the [SDK source](../packages/sdk/src/index.ts), [resource types](../packages/sdk/src/resource.ts), [adapter API](../packages/adapter/src/index.ts), and service [HTTP schemas](../apps/server/src/http-contracts.ts) / [OpenAPI](../apps/server/openapi.json). Do not duplicate their API inventory in a prose spec.

Superseded top-level plans have been removed; Git history preserves them. The pre-existing [historical archive](archive/README.md) is context only and does not establish requirements, provider support, or release gates. New superseded plans should normally be deleted rather than copied into that archive.
