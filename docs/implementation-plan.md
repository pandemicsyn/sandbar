# Sandbar strategy and implementation plan

Draft 0.3 · September 26, 2026 · Strategy documented; implementation and live conformance remain pending

## Scope and sequencing

V1 is self-hosted and includes a management UI. TypeScript, Rust, and Python are first-class SDKs. The selected stack is Bun/Hono, Drizzle beta, SQLite by default with MySQL as a tested option, and Vite/React/TanStack Router/Tailwind. Zod 4 owns executable IO schemas. See [architecture](design.md) and [validation](validation-and-contracts.md). No service has been scaffolded yet.

The iterative specialist review of security, storage, snapshots, images and observability preceded this architecture selection. Its findings are captured in:

- [Security, environments, operations, and SDK recommendations](contract-recommendations.md)
- [Storage, checkpoints, and image strategy](storage-and-images.md)
- [Observability, usage, and accounting strategy](observability-and-accounting.md)
- [Management UI workflows](management-ui.md)

Recommendations and numeric defaults remain proposals. Provider documentation informs the model; live tests establish supported guarantees.

## Phase 0: scaffold the selected stack and qualify persistence

- Review the proposed resource boundaries and three-language golden flows together.
- Freeze the initial environment/image union, secret delivery/network profiles, volume/mount/checkpoint contracts, operation results, and accounting cost bases.
- Scaffold Bun workspaces for server, web, contracts, core, store, providers and SDKs. Ship a Vite/React UI with TanStack Router and Tailwind, served on the API origin.
- Pin Drizzle ORM and Kit to verified beta `1.0.0-beta.22` and commit the lockfile; verify installed APIs rather than copying later RC examples. Pin compatible Zod 4 and framework dependencies during scaffolding.
- Create separate SQLite/MySQL schemas and migration histories, with shared domain transaction tests and explicit dialect-specific locking. SQLite is the default install; both dialects must pass conformance before support is advertised.
- Qualify mounted-key custody, durable acceptance, due-work scanning, streaming, consistent backup, exclusive startup/migrations and interruption recovery.
- Implement request/response/provider/webhook/job/configuration/stream validation, redacted error mapping and versioned persisted JSON schemas.
- Convert the initial protocol into executable OpenAPI and streaming schemas; select generators for internal transport code without defining public SDK ergonomics through generated names.

Exit criteria: a buildable scaffold, checked-in protocol schemas, and a small persistence/recovery qualification on both database targets. No paid provider work or production deployment is implied by this design phase.

## Phase 1: identity, management UI, and durable control slice

- Implement single-operator setup and the selected team-login path, project authorization, API tokens, and audit metadata.
- Build provider-connection add/verify/rotate/drain with same-native-scope validation, and versioned write-only secret/registry credential storage.
- Add immutable policy/environment catalogs and explicit project network/preparation/placement defaults.
- Implement admission, invocation-key validation, operation IDs, execution IDs, resource conflicts, quota reservations, durable work, unknown outcomes, and recovery scheduling.
- Capture usage evidence with relevant state changes from the start. Keep telemetry exporters independent of critical persistence.
- Implement a fake provider with delayed/lost/duplicate/out-of-order results.
- Build create/inspect/list/exec/files/destroy in all three SDKs and the fleet UI. Add submit forms and bounded output capture with explicit expiry/truncation.

Exit criteria: retries resolve the same operation across interruption; ordinary fast commands retain usable output; setup and first sandbox work through the UI; no credential values leak in responses/traces; a lost provider response never triggers automatic duplicate creation or execution.

## Phase 2: image supply and contrasting real providers

- Start with Daytona and Tensorlake as proposed contrasting adapters, then E2B and Modal; actual order depends on available accounts/API access.
- Implement mandatory core operations, scope-aware inventory, error/effect mapping, and required network/credential profiles.
- Support direct OCI sources and provider-native artifacts without forcing users to create a logical environment first.
- Implement remote preparation/import operations, prepared-image references, registry credential scope, provenance, pinning evidence, and project-bounded preparation across fallback attempts.
- Add context uploads and Dockerfile support only where the builder semantics are verified. Isolate external builders; never execute untrusted build instructions in the API process.
- Build UI progress, cache/retention controls, actionable capability failures, and preparation usage attribution.

Exit criteria: a user can supply an OCI image with an honest provider materialization path; private pulls do not expose credentials to guests; mutable sources are not falsely cached as immutable; deterministic incompatibilities fail before paid preparation where possible; owned/borrowed artifact cleanup is correct.

## Phase 3: storage, checkpoint, and lifecycle guarantees

- Implement Volume, Mount, VolumeVersion, and Checkpoint as separate resources.
- Add managed/borrowed volume registration, verified native mounts, and one tested versioned-volume adapter.
- Implement session flush/refresh/checkpoint with explicit barrier scope and exact retained version identity.
- Implement filesystem/memory checkpoints, restore, native suspend/resume, and native or verified composed fork.
- Record source disruption, excluded mounts, native expiry, credential lineage, resource dependencies, and per-mount restore choices.
- Add dependency-aware restricted deletion, safe detach behavior, retained-resource visibility, and recovery after uncertain capture/restore.

Exit criteria: filesystem-only never silently captures memory; requested minimum retention is enforced; read-only current-state mounts are distinguished from pinned inputs; memory operations with captured mount sessions fail unless verified; unknown operations pin artifacts; deletion does not cascade unexpectedly or claim immediate end of billing.

## Phase 4: streaming, fleet operation, and observability

- Add optional background process attachment, PTYs, endpoint grants, and private tunnel forwarding in all SDKs.
- Verify bounded buffers, backpressure, output replay/gaps, reconnection, and explicit remote cancellation.
- Integrate signed provider events, durable ingestion, reconciliation scans, and cleanup.
- Provide operation timelines, recent resource readings, system backlog/health, and optional OTLP export.
- Require explicit operator action before changing provider-global export configuration.

Exit criteria: browser/client disconnects never imply cleanup or rerun; forged guest telemetry cannot change project ownership; sink outages remain bounded and do not disable cleanup; capabilities and stale observations are visible in the UI.

## Phase 5: usage reporting and billing exports

- Add versioned UsageRecord, RateCard, AccountingAssignment, and CostRecord models using existing durable evidence.
- Expose estimated costs with coverage and precise units; never replace missing data with zero.
- Implement operator-owned BillingAccountLink and read-only AccountingDriver imports where providers actually support them.
- Deduplicate at verified native billing scope, use canonical source buckets/revisions, and preserve correction history.
- Add effective-dated attribution, currency-separated totals, explicit estimated/provider_reported/invoiced views, and authorized exports/events.
- Add retention/archive controls and minimum provenance for retained charges.

Exit criteria: repeated or revised reports cannot double-count; two project connections sharing one provider account cannot duplicate charges or expose each other's reports; late credits and coarse data remain honest; downstream consumers receive stable event IDs and explicit cursor expiry.

## Deferred features

Universal cross-provider mounts and transfers, arbitrary image builders, atomic root-plus-volume snapshots, distributed writer freezing, customer invoice/payment generation, custom workload-meter ingestion, cost-optimizing placement, and multi-node availability are separate features. Desktop and interpreter drivers can follow verified demand.

MySQL is an explicit v1 storage target alongside SQLite, with separate migrations and conformance. Additional service runtimes and multiple active nodes remain deferred; an ORM or database connection does not establish those guarantees.

## Shared conformance fixtures

| Area | Required failure/semantic cases |
|---|---|
| Invocation safety | Lost acceptance, old UUIDv7 after GC, changed channel/default under same key, mismatched caller intent |
| Execution/output | Immediate completion before subscription, nonzero exit, 17 simultaneous default captures, partial output, quota failure before effects |
| Credentials | Wrong-account rotation, revoked use with cleanup still permitted, placeholder versus exact-header guarantees |
| Image preparation | Private multi-registry inputs, traversal/symlink context escape, abandoned upload expiry, mutable tag cache, source versus runtime digest |
| Storage | Two writers, dirty detach, session-scoped durability, exact version identity, read-only mutable inputs |
| Checkpoints | Exact preservation, allowed disruption, native expiry, minimum retention conflict, unsafe memory/mount rebinding |
| Ownership | Borrowed artifact GC, shared role references, parent-delete dependencies, unknown operation pins |
| Accounting | Duplicate native scopes, overlapping report windows, stale revisions, late credits, unit/currency mismatch, historical attribution |
| Runtime/store | SQLite and MySQL admission races, restart/submission ambiguity, durable wake-up, exclusive startup/migrations, output load, backup/key recovery, cleanup during telemetry failure |
| Validation | OpenAPI/schema drift, strict requests, additive response compatibility, malformed driver results after effects, persisted payload upgrades, secret-safe diagnostics |

Use deterministic fixtures for uncertainty and small opt-in live suites for provider guarantees, with spending budgets, labels, TTLs, and verified cleanup. Document tested versions/scopes/regions. No adapter is supported solely because its API imports or its method names match.
