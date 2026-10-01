# Specifications

Keep this directory for focused implementation specs and a small set of current engineering contracts. Public usage belongs in [the docs site](../apps/docs/README.md), qualification belongs [with its harness](../packages/sdk-qualification/README.md), and sequencing belongs in the [roadmap](../ROADMAP.md).

New features target the SDK and public adapter API; see the [delivery rule](../plans/implementation-plan.md#delivery-rule).

## Implemented contracts and remaining slices

- [Provider state portability](provider-state-portability.md) — snapshots/volumes merged in #25; cleanup configuration in #34. Richer mounted storage composition and volume guarantees remain later work.
- [SDK results, errors and persisted resource identities](sdk-recovery-dx.md) — ordinary results, direct partial outcomes and provider-identifying handles merged in #33. Expanded persistence callbacks and workflow machinery remain deferred.
- Provider acceptance merged in #32; use the [maintained Bun suites](../packages/sdk-qualification/provider-qualification/README.md) and generated evidence. Public direct resource types and caller input errors merged in #35.
- [Sandbox lifecycle](sandbox-lifecycle.md) — reopen/inspect merged in #38 and adapter-configured `renew()` in #55. No-argument suspend/resume is the next accepted implementation slice; it is not exported yet.
- [Streaming execution and read cancellation](interactive-execution-and-access.md) — bounded E2B text streaming merged in #52 and local read cancellation in #51. Live validation of these new behaviors remains pending. Remote process termination/reopening, binary streaming, other provider streams, terminals, endpoints and tunnels remain outside the shipped slice.
- [Output helpers and bounded-exec timeout clarity](output-and-timeouts.md) — full decoding/structured previews merged in #53; provider timeout documentation and offline fixtures in #54. Native enforcement changes and deployed termination qualification remain separate work.
- [SDK observability and diagnostics](sdk-observability.md) — SDK tracing/diagnostics and OpenTelemetry, Sentry, and Datadog recipes merged in #24. Metrics/events remain later work.

Use the [authoritative roadmap](../ROADMAP.md) for order and qualification gaps. Merged code is not live qualification; retain the actual tested revision/configuration. Vercel and Tensorlake adapters remain behind the SDK usability gate. Accounting is deferred; the service/management UI were removed in #39, and Rust is not planned.

## Current engineering contracts

- [Architecture](design.md) — the implemented SDK and adapter boundaries.
- [Package conventions](package-conventions.md) — public names, dependencies and distribution rules.
- [Validation](validation-and-contracts.md) — executable schema ownership and boundary requirements.

For the current API, use the [SDK source](../packages/sdk/src/index.ts), [resource types](../packages/sdk/src/resource.ts), [adapter API](../packages/adapter/src/index.ts). Do not duplicate their API inventory in a prose spec.

Superseded top-level plans have been removed; Git history preserves them. The pre-existing [historical archive](archive/README.md) is context only and does not establish requirements, provider support, or release gates. New superseded plans should normally be deleted rather than copied into that archive.
