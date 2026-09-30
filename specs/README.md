# Specifications

Keep this directory for focused implementation specs and a small set of current engineering contracts. Public usage belongs in [the docs site](../apps/docs/README.md), qualification belongs [with its harness](../packages/sdk-qualification/README.md), and sequencing follows [the roadmap](../ROADMAP.md), with completion recorded in [plans](../plans/implementation-plan.md).

New features target the direct SDK and public adapter API. Service expansion is deferred until the SDK is mature and several provider integrations are established; see the [delivery rule](../plans/implementation-plan.md#delivery-rule). Preserve existing service behavior and regression coverage, without requiring new feature parity.

## State portability and active recovery follow-up

- [Provider state portability](provider-state-portability.md) — the snapshot/volume slice merged in [PR #25](https://github.com/pandemicsyn/sandbar/pull/25) at `a9d59b0`. Remaining lifecycle features, richer volume guarantees and mounted restore are later work.
- [SDK recovery outcomes and adapter support](sdk-recovery-dx.md) — active follow-up: typed partial outcomes/recovery, bound-connection reference persistence and shared recovery helpers/conformance. Richer volume semantics and mounted restore wait for concrete provider work.

## Implemented observability contract

- [SDK observability and diagnostics](sdk-observability.md) — direct SDK tracing/diagnostics and OpenTelemetry, Sentry, and Datadog recipes merged in PR #24. Metrics/events remain later work; service tracing is deferred.

## Later design work

- [Interactive execution and access](interactive-execution-and-access.md) — initial process, streaming, terminal, endpoint and tunnel contracts. Not an implementation commitment or a prerequisite for state portability.

Vercel and Tensorlake adapter specs wait for the [SDK usability milestone](../ROADMAP.md#gate-before-new-adapters). Cleanup configuration and sandbox lifecycle are the next usability work; exact implementation signatures remain to be specified. Accounting is deferred; management feature plans are not maintained here. Rust is not on the roadmap.

## Current engineering contracts

- [Architecture](design.md) — the implemented SDK, adapter and optional service boundaries.
- [Package conventions](package-conventions.md) — public names, dependencies and distribution rules.
- [Validation](validation-and-contracts.md) — executable schema ownership and boundary requirements.

For the current API, use the [SDK source](../packages/sdk/src/index.ts), [resource types](../packages/sdk/src/resource.ts), [adapter API](../packages/adapter/src/index.ts), and service [HTTP schemas](../apps/server/src/http-contracts.ts) / [OpenAPI](../apps/server/openapi.json). Do not duplicate their API inventory in a prose spec.

Superseded top-level plans have been removed; Git history preserves them. The pre-existing [historical archive](archive/README.md) is context only and does not establish requirements, provider support, or release gates. New superseded plans should normally be deleted rather than copied into that archive.
