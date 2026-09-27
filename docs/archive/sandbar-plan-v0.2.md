# Sandbar implementation plan

Draft 0.2 · All phases below are planned, not completed

## Delivery approach

Build a thin end-to-end service slice first, with durable operation semantics and three client languages. Add provider breadth and optional features incrementally. Validate Cloudflare and celld early so portability does not become a late rewrite.

Use one repository. Suggested package layout, subject to tooling selection:

```text
apps/api/                  Worker entrypoints and Durable Object classes
packages/contracts/        OpenAPI, event/frame schemas, shared fixtures
packages/core/             Routing, capability planning, policy, operation rules
packages/provider-kit/     Adapter helpers and conformance harness
packages/providers/        Daytona, E2B, Modal, Tensorlake integrations
sdks/typescript/           Hand-written public API + generated internals
sdks/rust/                 Hand-written public API + generated internals
sdks/python/               Hand-written public API + generated internals
tests/integration/         Runtime and opt-in live-provider tests
docs/                      Architecture, specifications, decisions
```

Avoid imposing a Node server dependency on core/provider packages. Freeze generated-code boundaries and review regeneration diffs before publishing SDKs.

## Phase 0: contracts and runtime spike

- Define initial OpenAPI schemas for projects, sandbox creation/detail/list/destruction, bounded exec, files, plans, and operations.
- Specify error/effect enums, cancellation-of-wait behavior, idempotency retention, and binary output transport.
- Choose the authentication integration and provider secret-resolution backend.
- Create minimal Worker and SQLite-backed SandboxDO/ProjectDO classes with schema migrations.
- Verify fetch, durable alarms, DO calls, binary streams, and WebSockets on Cloudflare and a pinned celld release.
- Verify provider HTTP/SDK dependency compatibility without provisioning paid resources.

Exit criteria: the same test app persists and recovers state on both runtimes; streaming behavior and unsupported dependencies are documented; the initial protocol is executable as a mock.

## Phase 1: durable vertical slice

- Implement project-scoped creation idempotency and durable sandbox-ID allocation.
- Implement SandboxDO operation admission, submission phase tracking, observation, unknown outcomes, and recovery alarms.
- Add transactional outboxes and revisioned project-index updates, including deletion tombstones.
- Implement authorization, redacted traces, basic lifecycle deadlines, and resource ownership checks.
- Build a deterministic fake provider capable of delayed success, lost responses, duplicate events, and partial failure.
- Implement the minimal create/inspect/exec/files/destroy path in the TypeScript, Rust, and Python SDKs.

Exit criteria: retries after a lost response produce the same logical operation; index delivery survives interruption; concurrent conflicting requests are rejected or ordered explicitly; SDK waiting cancellation never falsely reports remote termination.

## Phase 2: real-provider core

- Use Daytona as a proposed first implementation target, followed by Tensorlake, E2B, and Modal. Ordering can change based on API access and test accounts.
- Implement and verify all mandatory adapter methods and error/effect mapping.
- Add account-scoped inventory and managed-versus-discovered ownership classification.
- Implement network/credential capabilities needed by the initial workloads, rejecting unsupported guarantees.
- Test one environment per provider on both service runtimes.

Exit criteria: each provider passes the shared core suite and an explicitly enabled live smoke suite; auth/capacity/ambiguous failures are distinguishable; every created test resource is tracked for cleanup. No provider is declared supported solely because its SDK imports successfully.

## Phase 3: streaming and fleet operation

- Add attachable process output, terminals, endpoints, and private tunnels where supported.
- Implement local forwarding in all three SDKs and explicit reconnect/gap behavior.
- Add webhook verification and normalization, durable ingestion, periodic reconciliation, and lifecycle cleanup.
- Add project listing filters, pagination, freshness metadata, and observability for operation and outbox backlogs.
- Introduce queues only if bulk ingestion/scanning needs them; use optional object storage for retained output with defined limits.

Exit criteria: bounded memory under slow consumers, no claim of transparent TCP continuation, no secret/signed-URL leakage, and eventual state recovery after missed/out-of-order events and runtime restart.

## Phase 4: checkpoints and lifecycle extensions

- Implement filesystem and memory checkpoint modes only where verified.
- Add suspend/resume, restore, native fork, and validated composed fork.
- Specify state effects of stop/start/archive/recover/resize independently.
- Validate mounted-storage boundaries and credential retention/rebinding.

Exit criteria: preservation claims are tested through actual state, not method return codes; unsupported guarantees fail before effects where possible; uncertain restores do not trigger unsafe artifact cleanup.

## Phase 5: images, pools, and independent storage

- Implement ImageDriver and immutable environment resolution.
- Implement native warm-pool configuration/acquisition and preferred-versus-required semantics.
- Split basic StorageDriver from WorkspaceVersionDriver; implement mount-pair validation.
- Verify workspace durability barriers, historical reads/forks, and concurrent-writer semantics.

Exit criteria: pool configuration constraints remain visible, required warmth is enforceable, dirty sandbox reuse is absent unless explicitly designed, and cross-provider mounts are advertised only after the specific pairing passes tests.

## Later extensions

Desktop, interpreter, hosted repository, advanced telemetry, cost-aware placement, large-project index sharding, and cross-project reporting are optional follow-on work. D1 or another query store is considered only for measured needs; it is not a v1 prerequisite.

## Verification strategy

| Layer | Meaningful checks |
|---|---|
| Contract | Wire-schema validation, cross-language serialization, generated-code drift |
| Core | Literal argv, binary data, bounded output, nonzero exit, deadlines, repeated destroy |
| Durable state | Crash/restart at submission boundaries, duplicate create dispatch, outbox retries, stale event rejection |
| Authorization | Project/resource scope, provider scope, grant expiry/revocation, redaction |
| Runtime | Cloudflare/celld persistence, alarms, stream limits, reconnect and deployment interruption |
| Optional capabilities | Actual checkpoint preservation, fork independence, mount durability, policy enforcement |
| Live providers | Opt-in budgeted smoke tests with labels, TTLs, and verified cleanup |

Use deterministic tests for failure paths and a small live matrix for guarantees that only providers can prove. Record the tested versions/accounts/regions and do not broaden tests without a concrete unresolved risk. Schema/version migration tests must cover durable state surviving deployments.

## Not in this transfer

This commit-ready document set does not scaffold the application, install dependencies, create provider accounts, provision infrastructure, run paid sandboxes, or deploy anything. Implementation begins with Phase 0.
