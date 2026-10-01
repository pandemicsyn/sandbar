# Specifications

Keep this directory for focused implementation specs and a small set of current engineering contracts. Public usage belongs in [the docs site](../apps/docs/README.md), qualification belongs [with its harness](../packages/sdk-qualification/README.md), and sequencing belongs in the [roadmap](../ROADMAP.md).

New features target the SDK and public adapter API; see the [delivery rule](../plans/implementation-plan.md#delivery-rule).

## Merged foundation and current work

- [Provider state portability](provider-state-portability.md) — snapshot/volume support merged in PR #25. Later lifecycle and richer storage contracts remain proposals until implemented.
- [SDK results, errors and persisted resource identities](sdk-recovery-dx.md) — ordinary results, direct partial outcomes and provider-identifying snapshot/volume handles merged in PR #33. Expanded persistence callbacks and workflow machinery remain deferred.
- Provider acceptance merged in PR #32; use the [maintained Bun runner](../packages/sdk-qualification/provider-qualification/README.md) and generated evidence, not proposed qualification behavior.
- Public direct resource types and caller input errors merged in PR #35.
- Cleanup configuration merged in PR #34. [Lifecycle slice 1 reopen/inspect](sandbox-lifecycle.md) is delegated implementation work, not merged. The streaming/cancellation brief merged in PR #36; runtime implementation remains unshipped. See the [authoritative roadmap](../ROADMAP.md) for task identities and order. Later lifecycle choices and mounted storage composition remain later work.
- [Output helpers and bounded-exec timeout clarity](output-and-timeouts.md) — focused slice 3 implementation brief: full decoding, structured previews and pinned native timeout evidence. Runtime changes remain unshipped.

## Implemented observability contract

- [SDK observability and diagnostics](sdk-observability.md) — direct SDK tracing/diagnostics and OpenTelemetry, Sentry, and Datadog recipes merged in PR #24. Metrics/events remain later work.

## Later design work

- [First streaming execution slice](interactive-execution-and-access.md) — E2B text-streaming implementation brief merged in PR #36. No streaming runtime is implemented; terminals, endpoints and tunnels remain later work.

Vercel and Tensorlake adapter specs will be written later. Accounting is deferred. Rust is not on the roadmap.

## Current engineering contracts

- [Architecture](design.md) — the implemented SDK and adapter boundaries.
- [Package conventions](package-conventions.md) — public names, dependencies and distribution rules.
- [Validation](validation-and-contracts.md) — executable schema ownership and boundary requirements.

For the current API, use the [SDK source](../packages/sdk/src/index.ts), [resource types](../packages/sdk/src/resource.ts), [adapter API](../packages/adapter/src/index.ts). Do not duplicate their API inventory in a prose spec.

Superseded top-level plans have been removed; Git history preserves them. The pre-existing [historical archive](archive/README.md) is context only and does not establish requirements, provider support, or release gates. New superseded plans should normally be deleted rather than copied into that archive.
