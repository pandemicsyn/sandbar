# Self-hosted management UI

V1 requirement · Proposed scope and behavior, September 26, 2026

The management UI is a first-class part of Sandbar. Serve it with the API on the same origin. Use the same project-scoped management endpoints and authorization rules as SDK/CLI clients. It does not hold provider keys in browser storage or bypass durable operation handling.

## Implementation stack

Use React and Vite, Tailwind for styling, and TanStack Router for nested project/resource routes and validated URL search parameters. Resource details, operation links, settings and shareable fleet filters justify routing from the start. Bundle prebuilt assets with the Hono service; a production operator should not need a separate frontend build or host.

Use shared Zod 4 contract schemas for form input where applicable and validate server responses at the client boundary. Server validation and authorization remain authoritative. Keep only safe public schemas in the browser dependency graph, never provider SDKs, credential decoders or server configuration. Router state must not contain credentials or command output.

## Primary areas

| Area | Required v1 behavior |
|---|---|
| Setup/login | Single-operator setup or OIDC team login; recovery; project selection |
| Provider connections | Add, verify scope, rotate credentials, view health/capabilities, drain, and inspect dependent resources |
| Fleet | Filter/search/paginate by project, provider connection, state, labels; distinguish managed and discovered |
| Sandbox detail | Desired/observed state, freshness, resolved environment/resources/policy, operations, output availability, lifecycle actions |
| Images and environments | OCI/private-registry supply, context uploads, build/import progress, prepared artifacts, immutable revisions, channel updates |
| Volumes and checkpoints | Attachments, retained versions, capture effects, restore choices, dependencies, expiry and safe deletion |
| Usage and costs | Usage coverage, estimated/provider-reported/invoiced views, authorized attribution, exports; operator-only account imports |
| Secrets and policies | Write-only versioned secrets, precise delivery types, named network policy revisions, explicit project defaults |
| Operations | Pending/unknown/needs-attention views, evidence and reconciliation actions |
| Project settings | Memberships, API tokens, quotas, retention, lifecycle defaults, audit metadata |

Pools, desktop control, broad builder compatibility, and advanced analytics can follow their underlying driver releases. OCI supply and bounded remote image preparation are v1 scope, with Dockerfile support gated by verified builder semantics. A dashboard widget does not imply those capabilities are available.

## First-run path

1. Authenticate the operator through a single-use setup flow or configured OIDC.
2. Create/select a project.
3. Choose a provider and enter its adapter-specific credentials. Values are write-only; subsequent views show status and revision only.
4. Verify account/project scope without silently launching paid compute.
5. Choose Use provider starter. Resolve and record a prepared artifact, draft starter@1, and show pinning quality and sizing.
6. Explicitly select network preset: blocked, development internet, or custom. Save an immutable policy revision as the project default.
7. Publish the environment. Generate a scoped Sandbar API token, shown once, and complete TS/Rust/Python snippets including cleanup.
8. Start a sandbox through the ordinary API and navigate to its fleet detail.

Minimal snippets may inherit the displayed project network default; expanded reproducible snippets pin its revision. Neither snippet contains provider credentials.

## Connection management

Connection identity is stable across verified same-account key rotation. The UI shows native scope before enabling placement. Wrong-account credentials produce an actionable error and offer creation of a separate connection rather than silently replacing identity.

Draining stops new allocations and retains cleanup access. Removing a connection with managed resources presents those dependencies and requires cleanup or explicit detachment. Discovery alone never authorizes Sandbar to destroy existing provider resources.

## Fleet and lifecycle

List views display observation freshness and pending operations rather than claiming a globally current view. Resource detail distinguishes desired state from observed state. Show resolving, provisioning, running, cleanup pending, and unknown as meaningful states, not one generic spinner.

Only expose actions supported for that resource's current account/runtime/configuration. Unavailable actions include a reason and an appropriate fix, such as missing policy enforcement, disabled connection, or unsupported memory capture.

Do not treat a browser tab closing as a sandbox destroy request. Lifecycle defaults and explicit stop/destroy actions control cleanup. A stopped/destroyed resource can still have retained checkpoints or provider recovery windows; make those visible.

## Output and retention

Show output for completed commands under the bounded capture policy. Explain the configured byte cap, truncation, and possible early eviction. Keep exit status and operation history available after byte retention ends. Use Output not captured, Output truncated, and Output expired/evicted as separate states.

Live output reconnects by session/execution ID and cursor where supported. A gap is visible; reconnect never starts another command. Output authorization is distinct from metadata visibility because commands can print secrets.

## Unknown-effect recovery

Display known phase, possible effects, last provider observation, next reconciliation attempt, and retained evidence.

- Check again is read/observe/reconcile, not redispatch.
- Candidate linking requires privileged scope/identity verification and an audit event.
- Acknowledge unresolved archives attention without declaring failure or enabling replay.
- Run again creates a new invocation and explains possible duplicate effects.
- Cleanup after uncertain creation keeps searching for and removing the possible allocation; it never creates another sandbox.

## Security UX

Separate provider connections, workload secrets, API tokens, and access grants. Secret values are never returned after creation. Explain guest visibility for environment/file delivery. A principal who can execute arbitrary code with a guest-visible secret can obtain its value.

Normal network selection uses named policies. Policy detail explains exact matcher semantics; TLS server-name rules are not advertised as HTTP URL restrictions. Show unsupported combinations before creation where possible. Failed downloads do not trigger an automatic permission expansion.

Restore inherits captured state and source bindings under current authorization. Show known secret lineage and the fact that other sensitive content may exist. Rebinding is not described as sanitizing a checkpoint. Cleanup remains available after secret-use access is revoked.

## Image, storage, and accounting workflows

Image creation accepts OCI references or SDK-uploaded contexts without forcing catalog administration. Show native preparation progress, adaptation, pinning evidence, bounded policy, and cache outcomes. Registry credentials are write-only, scoped resources; preparation may share them with a configured provider builder, never implicitly with sandbox processes.

Volume detail shows mount sessions, consistency/durability capabilities, versions, and retained costs. Checkpoint flows show filesystem versus memory scope, source disruption, excluded mounts, effective expiry, credential lineage, and deletion dependencies. Read-only current-state mounts are not labeled reproducible; pinned versions are explicit. Delete defaults to restrict rather than cascade.

Cost views require a chosen basis and separate currencies. Estimated and provider-reported totals are not presented as invoiced or paid. Show incomplete coverage and unallocated shared costs to authorized operators. Project users cannot see full-account invoices merely because their provider key can read billing.

## Verification

Exercise the full first-run path and normal/error flows through the same API as SDKs. Verify keyboard access, loading/empty/error states, write-only credential handling, session/CSRF boundaries, same-scope rotation, unsupported-action explanations, stale fleet state, output expiry, and uncertain-operation recovery. Visual design and component choices are a later implementation step; these flows are the product contract.
