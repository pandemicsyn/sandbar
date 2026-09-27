# Effect research: direct CREATE and an internal architecture

**Status:** bounded experiment on `codex/effect-research`, rebased onto merged PR #7 at `af06bb602d8c4c3e02bf333596a59fb1201b51e9` (`origin/main`). This document is a design recommendation, not approval for a production migration. Final review and PR CI evidence are recorded in the experimental PR.

## Decision

**No-go for a production migration yet.** The experiment demonstrates that Effect v3 can model the local orchestration of CREATE, including scoped client lifetime, interruption, read-only polling, and provider dependency injection while preserving a Promise-facing API. It does not demonstrate that Effect fixes the highest risk: ambiguous provider mutation outcomes. That depends on driver transport behavior, stable submission identity, correlation, and for the service, durable SQL state. The prototype also adds measurable import cost and more edge code for a single operation. A production decision should follow a second vertical slice that moves CREATE and EXEC through one Effect-native orchestrator in direct and service modes, with Modal and Daytona adapter contracts characterized first.

If Sandbar adopts Effect, use it as the internal model for orchestration, typed errors, dependencies, scopes, and concurrency. Do not keep a permanent Promise orchestration engine beside an Effect wrapper. The normal public TypeScript SDK should continue returning Promises; Rust and Python HTTP clients and wire contracts remain independent of the internal library.

## Reproduce

```sh
bun install --frozen-lockfile
bun run build:packages
bun run --cwd packages/effect-prototype build
bun test packages/effect-prototype/src/compare.test.ts packages/effect-prototype/src/clock.test.ts
bun packages/effect-prototype/packed-smoke.mjs
bun run package:smoke
node packages/effect-prototype/measure.mjs
bun run lint
bun run format:check
bun run check
bun run test
bun run build
```

The prototype lives in private `@sandbar/effect-prototype`. It is absent from `@sandbar/sdk` exports and the root package build. `effect@3.22.2` is pinned exactly, with only v3 APIs used. [Effect's v4 installation guide](https://effect.website/docs/v4/getting-started/installation) identifies v4 as a release candidate under the `rc` tag and v3 as the untagged stable release; [npm's version list](https://www.npmjs.com/package/effect?activeTab=versions) identifies 3.22.2 as `latest`. An RC may be a reasonable separate evaluation; mixing APIs would make this result uninterpretable.

## What was actually built

`EffectCreateClient` implements public Promise `create`, `submitCreate`, `recover`, and `close` for **direct CREATE only**. A provider `Context.Tag` and per-client scoped `Layer` back a `ManagedRuntime`. Validation, capability check, preparation, dispatch, and observation are separate effects. The polling loop uses `Effect.sleep` and only calls the read-only `observe`; `TestClock` verifies internal timing independently of real transport tests. The legacy Promise SPI is adapted at individual calls, with interruption stopping the fiber's wait while the uncancellable Promise is allowed to settle. Scope finalization aborts local waiters; it never invokes sandbox destruction.

The dispatch edge exposes a sealed stable recovery reference before invoking `driver.create`. The reference is retained on a synchronous transport throw, rejected Promise, close, or abort after that edge. A conservative unknown result is correct even if the transport never sent bytes. JS run-to-completion narrows an in-process gap, but cannot make provider IO atomic with process death. The merged core's `resultDisposition(result, source)` prevents an observed rejection from being treated as proof of no effect; only the original submission response can certify that classification.

This is deliberately **not** an all-in migration implementation. CREATE uses the existing Promise `ProviderDriver`, validation/normalization/correlation, and public error classes. Non-CREATE methods on a returned sandbox handle lazily resolve the existing `DirectClient` handle. A client-scoped adapter supplies the already correlated CREATE completion to that decoder, so a successful handle needs no provider rediscovery even when the provider cannot discover by submission ID. The adapter releases its cached result after use, when an unused handle is collected, or when the client closes. This shortcut does not affect measured CREATE. The prototype does not implement service workers, SQL leases, EXEC orchestration, native Effect driver transport, telemetry, or streaming.

## Paired behavior and transport results

The same localhost fake-provider fixtures run once with the corrected direct SDK and once with the experimental client. They use the real HTTP fake server, not a mocked Effect scheduler. **40 paired fixture executions plus one virtual-clock test pass** on merged PR #7:

| Fixture | Baseline | Effect prototype | Invariant |
|---|---|---|---|
| Pre-aborted signal | pass | pass | No CREATE invocation |
| Abort during preparation | pass | pass | No later CREATE |
| Applied CREATE, lost response | pass | pass | New client recovers read-only; one invocation |
| Close during pending submission | pass | pass | Prompt recoverable error; remote compute remains |
| Hanging observation | pass | pass | Prompt abort; no replay |
| Malformed completion | pass | pass | Outcome unknown, never certified no effect |
| Close after success | pass | pass | Remote compute remains; new client recovers |
| Undiscoverable applied effect | pass | pass | Unknown; one invocation |
| Synchronous adapter throw at dispatch | pass | pass | Observe only; one invocation |
| Submission versus observation rejection | pass | pass | Only original response certifies no effect |
| Provider preflight read error | pass | pass | SDK error mapping; no dispatch |
| Scope and recovery reference snapshots | pass | pass | Immutable after client construction |
| Successful CREATE without submission discovery | pass | pass | Returned handle supports inspect, exec, binary files, and destroy without rediscovery |
| Invalid/pre-aborted wait, then valid wait | pass | pass | Initial completion remains available |
| Invalid/pre-aborted wait, then certified rejection | pass | pass | Original `effect: none` evidence remains available |
| Concurrent observe and wait on completed CREATE | pass | pass | Share the original result with no provider rediscovery |
| Abort a hanging read, then observe again | pass | pass | A fresh read-only request recovers without CREATE replay |
| Transient lazy-handle preflight failure | pass | pass | Completed CREATE remains usable on the next operation |
| Concurrent waits after pending CREATE | pass | pass | Both settle without replay; the prototype shares its active read |
| Abort one of two concurrent waits | pass | pass | The other waiter can finish on the read-only result |
| Observe and wait complete after pending CREATE | pass | pass | Both returned handles stay usable without rediscovery |

The fixture timeout clears its timer; gated Promise work is released; fake servers are stopped after each test. `TestClock` confirms the read-only loop stops after success without another scheduled poll. The process exits cleanly, though this is not a heap-level proof that arbitrary third-party SDKs release sockets or streams. A Promise SPI without `AbortSignal` cannot cancel its underlying HTTP request merely because the Effect fiber was interrupted. A future native transport adapter needs its own cancellation and leak tests, with the same uncertainty semantics.

The existing `bun run package:smoke` also passes for Node and Bun direct/remote packed consumers. The experimental `packed-smoke.mjs` packs six workspace packages, installs them into a fresh external directory, typechecks public declarations, and runs a real fake-server CREATE under Node and Bun. It passed with Node v26.4.0 and Bun 1.3.14. The SDK's direct dependency graph remains free of Hono, Drizzle, store, service runtime, MySQL, and Bun-only modules. The extra Effect dependency is confined to the experimental package.

On merged PR #7, `bun run lint`, `format:check`, `check`, and `build` pass. The complete `bun run test` suite passes **197 tests with five MySQL tests skipped**. This includes the existing SDK, SQLite finalization, durable runner, process-kill, fake transport, and UI/server tests. No production SDK, store, or service-runtime source was changed by this experiment. The existing three SDK scope deferrals (imported remote reference's original smaller EXEC cap, exported raw/request helpers, and nonconforming fake inspect 2xx errors) remain outside this research task.

## Cost and complexity

Measured on macOS 25.6.0, Apple M3 arm64, Node v26.4.0 and Bun 1.3.14. `measure.mjs` runs 12 fresh child processes per import variant and six batches of 300 sequential in-memory CREATEs after a 50-operation warmup. Figures below are medians from one run; min/max are emitted by the script. These are directional only: child-process startup, filesystem cache, runtime JIT, and the in-memory driver all differ from a real provider.

| Measure | Current direct | Effect prototype |
|---|---:|---:|
| Node module import | 31.2 ms | 157.0 ms |
| Node child startup including import | 65.1 ms | 188.5 ms |
| Bun module import | 19.7 ms | 94.7 ms |
| Bun child startup including import | 34.0 ms | 108.5 ms |
| In-memory CREATE, Node | 0.294 ms | 0.311 ms |
| Read-only observations per successful measured CREATE | 0 | 0 |

The baseline SDK tarball was 14,173 bytes; the additional prototype tarball was 6,596 bytes. The installed Effect package resolves to roughly 33 MiB on disk on this machine and adds `@standard-schema/spec`, `fast-check`, and `pure-rand` to the lockfile. Tarball size is not total transitive installed size or a browser bundle measurement. No statistically reliable operation-speed advantage is established; the import overhead is a regression for this prototype.

For this narrow path, Effect replaces bespoke `raceAbort`/`waitDelay` polling and listener cleanup with `ManagedRuntime`, `Effect.sleep`, fiber interruption, and scoped finalization. It also requires explicit `FiberFailure`/typed-error conversion at the Promise boundary and a careful dispatch barrier. File line counts do not show a simplification: the prototype covers CREATE while the baseline direct module covers all operations. The likely benefit emerges only if the same runtime and semantics are shared across CREATE, EXEC, destroy, file writes, service due-work, and provider sessions. The present prototype adds complexity because it intentionally coexists with baseline code.

## Conditional all-in architecture

```text
Promise SDK / Hono HTTP boundary
           ↓
single Effect-native mutation orchestrator
  validation → plan → stable identity → dispatch barrier → correlate → observe
           ↓
typed ProviderRegistry + scoped connection session
  native Effect driver  |  Promise-driver leaf adapter
           ↓
provider transport with explicit cancellation capability
```

- **Core/error semantics.** Own a tagged internal error union for invalid input, unsupported preparation, certified rejection, ambiguous submission, observation mismatch, and interruption phase. Preserve `effect`, `retry`, correlation identity, and recovery reference. Map it once at the public Promise/HTTP boundaries to existing `SandbarError`, `OutcomeUnknownError`, `WaitAbortedError`, and wire errors. Defects and malformed provider responses must never be promoted to `effect: none`.
- **One orchestrator.** Direct and service modes share the mutation state machine, identity, correlation, and observe-only policy. Direct supplies process-local intent/reference handling. Service supplies durable submission/lease policy without pretending an in-memory journal is SQL. No second Promise orchestration engine remains. An optional future Effect-native public API can expose the same program without changing the normal Promise SDK.
- **Provider registration.** Resolve a provider session by verified provider, connection, account, region, and credential revision through a scoped Layer. Reject duplicate registrations and missing services. Native Effect SPI returns typed effects and states whether a transport honors cancellation. Promise drivers enter only through a leaf adapter, never a separate flow. The dispatch permit is marked immediately before starting transport in a non-yielding segment. An Effect value is lazy; constructing it alone is not dispatch. No adapter may infer `effect: none` from abort or transport rejection.
- **Client and connection lifetime.** Each long-lived `Sandbar.direct` client owns a managed runtime/scope. `close()` interrupts local waiters, poll fibers, queues, and streams promptly, retaining recovery refs. It does not call remote `destroy`. Credential/connection Layers are bound per verified connection and never put in a mutable provider-name-only global registry. Service scopes are per worker/request/connection as appropriate, with explicit isolation tests.
- **Durable service.** Continue committing accepted intent, stable provider token, `beginSubmission`, lease generation, and attempt marker in SQL before provider IO. A process crash between marker and actual transport is conservatively observe-only. A lease expiry starts read-only observation; neither `Schedule` nor fiber restart authorizes another CREATE/EXEC. Use Drizzle transactions for database invariants. A Schedule can wake due work and pace observation, but SQL remains the authority. Retry mutation only on a provider-certified same-invocation protocol, with explicit capability evidence; Modal's hidden upstream SDK mutation retries cannot be made safe by Effect wrapping.
- **Concurrency and telemetry.** Use bounded `Queue` for in-process work pressure, `Stream` for bounded logs/events with truncation/backpressure, and `Schedule` for read-only polling and due-work cadence. Scoped finalizers close local sockets, readers, listeners, and fibers. They never delete remote compute. Effect spans and optional OpenTelemetry exporters show timing and trace context; they are not a substitute for durable resource events, reservations, usage accounting, or encrypted request/result records.
- **Boundary libraries.** Keep Zod 4 and generated OpenAPI as the current canonical wire schema source. Effect Schema may be evaluated as a wholesale replacement later, with generated contract parity and no dual handwritten schema. Effect HTTP need not replace Hono to obtain Effect orchestration. Effect SQL need not replace Drizzle or its SQLite/MySQL transaction code; any later change needs transaction/lease parity and migration evidence. These are independent decisions, not prerequisites for an all-in runtime model.

## Migration sequence and gates

1. Characterize the in-progress Daytona and Modal dispatch, recovery, credential scope, transport abort, and hidden retry behavior against the now merged PR #7 public/SPI baseline. Keep their existing tasks independent of this experiment.
2. Define the Effect-native internal error algebra, provider session Layer, Promise SPI adapter, and explicit dispatch permit. Run the paired behavior suite against native and adapter paths; add real transport interruption and late-response tests.
3. Move direct CREATE and EXEC to the single orchestrator, then destroy and file write. Keep the Promise facade and packed Node/Bun qualification. Remove replaced `raceAbort`/listener orchestration rather than keeping two engines.
4. Move the durable runner onto the same state machine with SQL marker/lease implementations. Prove crash/restart, lease takeover, observe-only recovery, SQLite/MySQL parity, encrypted credentials/output, and bounded concurrency. Keep HTTP routes and wire contracts stable.
5. Add scoped telemetry and streams with explicit byte/task limits. Benchmark packed imports and real provider latency again. Only then consider whether optional native Effect API, Schema, HTTP, or SQL changes have independent value.

Go only if these gates show correct non-replay behavior with real drivers, prompt local cancellation without lost recovery refs, no resource leaks, external package compatibility, and a maintainable single implementation. The current paired prototype is encouraging but insufficient to authorize a production-wide migration.

## Source-backed findings

- [Effect v3 creating effects](https://effect.website/docs/v3/getting-started/creating-effects) describes async interruption and cancellation hooks; [Scope](https://effect.website/docs/v3/resource-management/scope) provides local finalization; [TestClock](https://effect.website/docs/v3/testing/testclock) supports virtual scheduling; [tracing](https://effect.website/docs/v3/observability/tracing) documents spans and OpenTelemetry integration.
- [Alchemy's Provider.ts](https://github.com/alchemy-run/alchemy/blob/main/packages/alchemy/src/Provider.ts) demonstrates Context/Layer-backed provider registration and read/diff/reconcile/delete for desired-state resources. [Platform.ts](https://github.com/alchemy-run/alchemy/blob/main/packages/alchemy/src/Platform.ts) shows substantial scope/runtime composition; [a reported context regression](https://github.com/alchemy-run/alchemy/issues/577) illustrates the need to test Layer lifetime and credential resolution. Its reconciliation model does not transfer automatically to non-idempotent sandbox CREATE or EXEC.
- The independent architecture discussion challenged lazy Effect dispatch, Promise transport cancellation, SQL lease authority, credential scoping, and duplicate schema/tooling. It led to the explicit dispatch-permit design, scoped session registry, and recommendation to retain existing boundary libraries pending separate evidence.

**Not run:** live Daytona/Modal or other paid provider calls, live credentials, MySQL in this prototype, production deployment, Rust/Python client tests, full service migration, or publication.
