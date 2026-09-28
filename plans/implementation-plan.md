# Implementation sequence

Updated September 28, 2026. This tracks selected work, not every idea previously discussed.

## Next: provider state portability

Implement the [state portability spec](../specs/provider-state-portability.md): capability evaluation and scoped resource references, snapshot/restore/cleanup, native volumes and mounts, then lifecycle control and optional versions/forks. Follow its detailed sequencing and acceptance cases. Use the existing direct/service operation machinery and preserve no-replay recovery.

Daytona and E2B are the current built-ins. Vercel and Tensorlake inform the abstraction; their adapter specs and implementations are later work.

## Planned: SDK observability and diagnostics

Follow the [observability spec](../specs/sdk-observability.md) as a separately scheduled workstream after the state-portability foundations settle. It does not expand that task or replace the next snapshot feature slice.

1. Direct SDK operation/phase tracing, safe error correlation, and application-owned OpenTelemetry setup.
2. Service propagation and linked recovery/runner episodes, preserving no-replay semantics.
3. Tested Sentry, Datadog, and plain OpenTelemetry recipes with separate Node/Bun and local/vendor evidence.
4. Bounded metrics and structured diagnostic events after tracing is stable.

The first unit delivers useful direct traces and diagnostics; the complete integration story requires the service and vendor qualification units. Accounting remains separate and deferred.

## Later

- Develop the [interactive execution/access draft](../specs/interactive-execution-and-access.md) after the state contracts settle.
- Specify Vercel and Tensorlake adapters separately when they become implementation work.
- Accounting is deferred. There is no active management-feature spec, and Rust is not on the roadmap.
- Effect remains parked and is not an implementation or release gate.

## Existing implementation and evidence

The SDK, public adapter API, optional service and management UI already exist. Use [architecture](../specs/design.md), [public documentation](../apps/docs/README.md), and [qualification](../packages/sdk-qualification/README.md) for current behavior and evidence. Completed and superseded plans are available in Git history.

Publication, deployment and paid provider calls require separate authorization. This sequence does not authorize them or introduce additional feature requirements from removed specs.
