# Specifications

Keep this directory for focused implementation specs and a small set of current engineering contracts. Public usage belongs in [the docs site](../apps/docs/README.md), qualification belongs [with its harness](../packages/sdk-qualification/README.md), and sequencing belongs in the [roadmap](../ROADMAP.md).

New features target the SDK and public adapter API; see the [delivery rule](../plans/implementation-plan.md#delivery-rule).

## Implemented contracts and remaining slices

- [Provider state portability](provider-state-portability.md) — snapshots/volumes merged in #25; cleanup configuration in #34. The [storage composition brief](storage-composition.md) specifies consistent create/restore mounts, a settled API migration and a bounded Daytona cold-restore slice with startup acceptance; mounted capture and richer guarantees remain deferred.
- [SDK results, errors and persisted resource identities](sdk-recovery-dx.md) — ordinary results, direct partial outcomes and provider-identifying handles merged in #33. Expanded persistence callbacks and workflow machinery remain deferred.
- Provider acceptance merged in #32; use the [maintained Bun suites](../packages/sdk-qualification/provider-qualification/README.md) and generated evidence. Public direct resource types and caller input errors merged in #35.
- [Sandbox lifecycle](sandbox-lifecycle.md) — reopen/inspect merged in #38 and adapter-configured `renew()` in #55. Native suspend/resume merged in #57; eligible Daytona containers retain files with fresh execution, while E2B private-state memory pause resumes under the same ID with execution identity unknown. Live passes remain scoped to `6796b30` and `26f516d`; mounts and external-storage guarantees are excluded.
- [Streaming execution and read cancellation](interactive-execution-and-access.md) — bounded E2B text streaming merged in #52 and local read cancellation in #51. Signal-bearing file reads and E2B finite streaming passed at `3188e33` in #68. Process reopening, binary streaming, other provider streams, terminals and tunnels remain outside the shipped slice.
- [Output helpers and bounded-exec timeout clarity](output-and-timeouts.md) — full decoding/structured previews merged in #53; provider timeout documentation and offline fixtures in #54. Native enforcement changes and deployed termination qualification remain separate work.
- [Default creation and everyday files](sandbox-basics-dx.md) — creation defaults merged in #58, UTF-8 helpers in #61 and directory APIs in #59. Exported directory methods do not imply native support: Daytona supports none; E2B listing is unsupported and mkdir/remove require `recursive: true`. E2B directory cases passed at `3188e33` in #68; configured creation remains not-run; local text encoding needs no separate live qualification.
- [Preview access and useful process control](preview-and-process-control.md) — preview merged in #60: Daytona protected headers and E2B explicit public access. E2B default creation/restore is private, while protected preview remains unavailable. Supported preview modes passed at `3188e33` in #68; private-default ingress denial remains unqualified; E2B local-handle termination merged in #66 and passed its bounded live case at `131a8c6`: one cached native SIGKILL PID request, explicit reuse races, no descendant guarantee and independently observed exit. Daytona termination remains unsupported; finite stdin for ordinary `exec` is implemented with deterministic and packed coverage, while live qualification is not run. Incremental process input and sustained output remain future work.
- [SDK observability and diagnostics](sdk-observability.md) — SDK tracing/diagnostics and OpenTelemetry, Sentry, and Datadog recipes merged in #24. Metrics/events remain later work.

Use the [authoritative roadmap](../ROADMAP.md) for order and qualification gaps. Merged code is not live qualification; retain the actual tested revision/configuration. Vercel and Tensorlake adapters remain behind the SDK usability gate. Accounting is deferred; the service/management UI were removed in #39, and Rust is not planned.

## Accepted upcoming DX work

Finite input to ordinary `box.exec` is implemented across Daytona, E2B and experimental Modal under the [finite stdin contract](process-stdin.md); deterministic and packed tests do not qualify live provider behavior. Incremental input to `processes.start` and sustained output remain separate future slices under the [process contract](preview-and-process-control.md), and do not change today's finite-streaming limits. Selected-volume Daytona cold restore from the [storage composition contract](storage-composition.md) merged in #69 and passed its complete live workflow at `5911ccc`; mounted capture, memory composition and blocked-network mounted restore remain unsupported.

The lifecycle case's fresh-process inactive reopening and E2B RAM continuity do not qualify the separate full reopen, renewal, streaming or signal-bearing read scenarios. Keep actual tested revisions/configurations and prior failures visible. Provider-specific choices belong in setup, while ordinary application calls stay short; confirmed outcomes and persisted resource identities remain available without requiring recovery machinery for normal calls.

## Current engineering contracts

- [Architecture](design.md) — the implemented SDK and adapter boundaries.
- [Package conventions](package-conventions.md) — public names, dependencies and distribution rules.
- [Validation](validation-and-contracts.md) — executable schema ownership and boundary requirements.

For the current API, use the [SDK source](../packages/sdk/src/index.ts), [resource types](../packages/sdk/src/resource.ts), [adapter API](../packages/adapter/src/index.ts). Do not duplicate their API inventory in a prose spec.

Superseded top-level plans have been removed; Git history preserves them. The pre-existing [historical archive](archive/README.md) is context only and does not establish requirements, provider support, or release gates. New superseded plans should normally be deleted rather than copied into that archive.
