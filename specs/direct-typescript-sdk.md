# Direct and service-backed TypeScript SDK

Accepted design · Core direct/remote implementation and qualification merged in PRs #5–#7; provider support is qualified separately

## Product contract

The accepted TypeScript SDK design makes the Sandbar service optional for TypeScript callers. It calls providers from the caller's process or uses the service over HTTP with the same ergonomic sandbox resource operations. Use `direct` rather than `local`: compute still runs at the provider. Construction names `Sandbar.direct(...)` and `Sandbar.connect(...)` are the intended DX; package export details must preserve dependency isolation.

Direct mode requires no database, Hono server, subprocess bridge, implicit background daemon or synthetic project setup. It targets server-side Node.js and Bun; qualify concrete supported runtime versions. Provider packages are explicitly installed/configured, credentials stay with the caller, and direct entry points do not pull Hono, Drizzle, SQL drivers or service configuration into their runtime dependency graph. Browser access to real provider administrator credentials is not a supported mode.

Shared operations initially cover create, inspect, exec, binary files and destroy. Both constructors produce the same resource-handle interface for those operations, with common error/effect semantics, bounded output and safe retries. Normal create/exec wait; explicit submission methods can return handles, whose durability is honestly described. Do not expose all management namespaces in direct mode merely to throw unsupported errors. Service administration remains a separate management surface.

Direct SDK support does not imply embedded Rust/Python support. Those remain first-class remote SDK targets. No requirement to duplicate provider implementations in three languages or embed a TypeScript runtime in Rust/Python.

## Shared logic and service responsibilities

The portable `packages/core` now provides validated request normalization, provider-result and scope/submission correlation, effect disposition, and bounded output handling. Provider drivers depend on the portable contracts/SPI, not the service store. The direct SDK reuses these helpers and evaluates capabilities before provider mutations.

`DurableRunner`, encryption and key custody now live in the service-owned `packages/service-runtime`, which depends explicitly on `@sandbar/store`. `packages/core` no longer imports `ControlStore` or SQL row types, and the service runner uses the portable helpers. Keep direct and service paths on the same validation/effect semantics without an artificial generic store interface or an in-memory database in direct mode.

The service continues to own authentication, projects, centrally stored provider connections, atomic admission/quotas, durable operations, scheduling, reconciliation, fleet indexes and accounting persistence. This refactor must preserve the reviewed service/API behavior, security checks, transaction boundaries and recovery tests.

## Resource identity and query semantics

Public direct calls should not require project IDs, stored connection rows or catalog administration. Internally generated correlation IDs are implementation details. Provider/account scope and native identity must still be validated; never accept a native reference as authority to use a different account.

An OCI or verified native/prepared image plus configured provider is sufficient for the normal path. Named environments, policies and secret references can later be supplied by optional explicit resolvers; do not silently treat a service-owned ID as a portable native ID. Unimplemented resolution modes fail before effects. The initial fake-backed implementation supports only the shared, verified image/capability subset; it does not establish real OCI import compatibility.

Do not collapse caller-known resources, provider inventory and managed fleet into one misleading list contract. Expose only well-defined queries; direct discovery uses verified native scope, while a service fleet includes managed state and observation freshness. Cross-mode resource handles are not automatically interchangeable. Attaching a direct/native resource to service management is a separate adoption capability.

## Operations, retries and recovery

Both modes allocate stable invocation/submission identities before provider mutation, validate normalized responses, distinguish nonzero process exit from transport failure, and never repeat an ambiguous create/exec or fall back to a second provider after uncertain effects. Portable result disposition requires the caller to identify whether a result came from the original submission or later observation; an observed rejection never certifies no effect. AbortSignal cancels waiting unless remote cancellation is separately supported and requested; it does not prove the sandbox stopped.

Direct mode keeps invocation state in memory while the caller runs and can observe/reconcile where the provider supports it. A direct operation is not a durably accepted service operation. Distinguish process-lifetime versus service-persisted recovery guarantees in documented types/metadata without adding a mode flag to every resource method. Closing a client stops its own resources/timers; it does not silently destroy provider sandboxes. Native TTL support and explicit destroy remain important.

Provide a versioned, serializable recovery reference where practical: native provider/connection scope, stable invocation/submission identity and necessary resource locators, with no credentials, command payload, environment secrets or file contents. Validate imported references and resolve credentials separately. A reference enables read-only recovery when the provider retains evidence; it neither grants authorization nor schedules future work. Missing native evidence remains unknown, not safe to retry.

Document the crash window: an in-memory client can die before it returns a reference to its caller. If exposing a before-submit handoff so the caller can persist identity, await the handoff before effects and keep persistence opt-in. Do not promise restart recovery for callers who never persisted sufficient evidence, and do not introduce mandatory SQLite. Explicitly test providers without native idempotency/discovery.

Direct mode may emit telemetry hooks but cannot enforce organization-wide quotas, access control or complete accounting across applications. Provider-enforced network/security capabilities retain their exact guarantees; caller-local checks do not become central policy enforcement.

## SDK and package shape

Keep one handwritten resource API over interchangeable direct and HTTP backends. Public wire schemas/OpenAPI remain independent of TypeScript live handles and backend-specific storage. HTTP plumbing can use generated models/transport internally; the SDK is not defined by Hono RPC inference.

Separate remote-only and direct entry points or packages where needed so installing/using a remote client does not load provider SDKs, and direct use cannot load the service/SQL graph. Publish/build ESM and declarations with explicit package exports; verify consumption from outside the monorepo instead of relying on workspace TypeScript source aliases. Package archives are local validation artifacts in this wave, not authorization to publish to npm.

No broad provider support is implied by an ergonomic example. The initial provider is the deterministic fake through the same SPI. Real Daytona, Tensorlake, E2B and Modal drivers follow the existing roadmap and must work in both runtimes when advertised.

## Implementation status

The portable core, TypeScript direct/HTTP SDK and Node/Bun qualification work are merged in PRs #5–#7. The completed task sequence is preserved in the [archived wave-2 plan](archive/direct-typescript-sdk-wave-2.md). See [runtime qualification](sdk-runtime-qualification.md) for measured runtimes, packed direct flows, remote imports/types, and validation limits. The [SDK README](../packages/sdk/README.md) documents the implemented public API.

The constraints below remain acceptance criteria, not a claim that every proposed extension is implemented. Real-provider conformance, publication and production deployment require their own evidence and authorization.

## Acceptance checks

- A separate Node/Bun process imports the packed direct SDK and provider package, creates/executes/reads/writes/destroys via the independent fake service, and never starts or imports Sandbar's API/store runtime.
- The same resource-flow tests run via HTTP against the existing service; backend construction is the ordinary-flow difference.
- Lost responses after applied effects never cause duplicate create/exec/file-write, including fake profiles without native idempotency. Only verified definitive rejection permits configured fallback.
- A saved recovery reference survives constructing a new direct client with the same verified scope; observe only, with no replay or hidden sensitive payload. Unsupported recovery is explicit.
- Binary output/files, nonzero exits, response validation, operation correlation, resource scope checks and abort/wait semantics agree across backends where guarantees are shared.
- Existing service SQLite/MySQL, auth, browser E2E and recovery behavior remain passing; skipped environments are reported, never counted as qualified.
- Direct dependency graph contains no Hono/Drizzle/SQL drivers. Package import smoke tests prove actual Node/Bun support. Fake's own test service persistence does not count as SDK-local storage or establish real-provider conformance.
