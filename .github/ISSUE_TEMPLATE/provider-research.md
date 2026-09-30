---
name: Provider candidate
about: Research a sandbox provider and prepare an evidence-backed adapter implementation brief.
title: "[provider-candidate]: <Official product name>"
labels: "provider-candidate, target:unknown"
---

<!-- Use $provider-research to complete this brief. Follow .github/provider-research-conventions.md for exact title, labels and statuses. Replace the title placeholder. Keep unknowns explicit; an issue is not certification or permission to run paid tests. -->

## Provider and research scope

- Provider name and product (distinguish sandbox product from other services):
- Stable provider key (reuse the adapter name if one exists):
- Homepage / official documentation / API reference:
- Official TypeScript SDK: package, repository, version, reference; or no SDK found:
- Research date and Sandbar commit used for mapping:
- Provider API version / SDK release or source commit examined:
- Target configuration: region, account tier, runtime/image class, hosted or self-hosted:
- Requested adapter scope:
- Distribution target (`builtin` / `external` / `unknown`, matching the target label):
- Target rationale: TypeScript SDK availability, runtime/CLI/native requirements, transitive dependencies, package size, licensing and transport stability (cite evidence):
- Existing accepted distribution decision or proposed change:
- Existing research, implementation issues or PRs:

## Recommendation and implementation gates

- Research completeness (`incomplete` / `complete`): explain remaining research gaps. Complete means the brief accounts for the requested scope with evidence or explicit unknowns, not that all questions are resolved.
- Implementation readiness (`ready` / `conditional` / `blocked`): name the exact slice this applies to and the decisions/investigations required before it can proceed. Tests to run during implementation are separate acceptance gates.
- Minimum useful adapter: describe one end-to-end user workflow enabled by the proposed first slice, including its limitations.
- Essential operations omitted from that workflow (such as execution or cleanup), why, and the product decision needed before shipping that reduced scope:
- Optional capabilities deferred, with reasons; these do not automatically block the useful slice:

| Decision                          | Recommendation and evidence | Alternatives / tradeoffs | Unresolved question | Blocks which operation or release? | Resolution needed (research, product decision, implementation test, or authorized live experiment) |
| --------------------------------- | --------------------------- | ------------------------ | ------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| Distribution and native transport |                             |                          |                     |                                    |                                                                                                    |
| Initial usable scope              |                             |                          |                     |                                    |                                                                                                    |
| Lifecycle and state defaults      |                             |                          |                     |                                    |                                                                                                    |
| Identity, recovery and cleanup    |                             |                          |                     |                                    |                                                                                                    |

Distinguish accepted project decisions from new recommendations. Base technical packaging rationale on the transport/dependencies actually proposed; describe unused SDK dependencies only as an alternative's cost. Identify specific investigation tasks for gaps instead of leaving the implementer to discover them.

## Contract compatibility

| Proposed behavior / default | Current Sandbar contract (link and revision) | Fits, conflicts, or unknown | Proposed resolution / required decision | Effect on implementation readiness |
| --------------------------- | -------------------------------------------- | --------------------------- | --------------------------------------- | ---------------------------------- |
|                             |                                              |                             |                                         |                                    |

Check lifecycle defaults, execution/file fidelity, identity and scope, network guarantees, recovery and deletion for the proposed slice. Native API behavior alone does not choose Sandbar's default: explain required adapter orchestration. Do not silently weaken a contract or claim a prose caveat resolves an identity/safety gap. If a prerequisite cannot be established, name the affected blocked path; do not invent a guarantee.

## Native capability summary

Use one canonical status per row: `supported`, `unsupported`, `conditional`, or `unknown`. Capability statuses belong in this table, not labels. State limitations and source IDs even for unsupported capabilities. The detailed sections below explain subfeatures and Sandbar implementation gaps. These are researched native capabilities, not live certification.

| Capability       | Native status | Limitation / evidence | Sandbar mapping |
| ---------------- | ------------- | --------------------- | --------------- |
| `lifecycle`      | unknown       | Not researched        |                 |
| `exec`           | unknown       | Not researched        |                 |
| `files`          | unknown       | Not researched        |                 |
| `snapshots`      | unknown       | Not researched        |                 |
| `volumes`        | unknown       | Not researched        |                 |
| `egress`         | unknown       | Not researched        |                 |
| `ingress`        | unknown       | Not researched        |                 |
| `suspend-resume` | unknown       | Not researched        |                 |
| `recovery`       | unknown       | Not researched        |                 |
| `typescript-sdk` | unknown       | Not researched        |                 |
| `observability`  | unknown       | Not researched        |                 |

## Evidence and capability map

Use native status **supported**, **unsupported**, **conditional**, or **unknown**. Record evidence provenance separately as docs, pinned source, or authorized live observation, with version/date. Missing docs means unknown, not unsupported. Track Sandbar mapping separately: **fits current API**, **contract extension needed**, or **out of scope**. A native feature does not mean Sandbar implements it.

For each row cite a source ID below, identify the exact native method/endpoint, summarize restrictions and the proposed mapping, and name the missing validation. Expand consequential details in the sections below.

| Area                                  | Native status / method or endpoint | Guarantees and restrictions | Sandbar mapping | Evidence | Validation gap |
| ------------------------------------- | ---------------------------------- | --------------------------- | --------------- | -------- | -------------- |
| Authentication and verified scope     |                                    |                             |                 |          |                |
| Creation, images and readiness        |                                    |                             |                 |          |                |
| Inspect, reconnect and inventory      |                                    |                             |                 |          |                |
| Stop, restart, suspend and delete     |                                    |                             |                 |          |                |
| Execution and process lifecycle       |                                    |                             |                 |          |                |
| Filesystem reads and writes           |                                    |                             |                 |          |                |
| Snapshot capture and inspection       |                                    |                             |                 |          |                |
| Snapshot restore and deletion         |                                    |                             |                 |          |                |
| Volumes and mounts                    |                                    |                             |                 |          |                |
| Egress, ingress and sandbox isolation |                                    |                             |                 |          |                |
| Async operations and recovery         |                                    |                             |                 |          |                |
| Diagnostics and tracing               |                                    |                             |                 |          |                |

## SDK, authentication and native transport

- TypeScript SDK maturity, supported Node/Bun versions, ESM/types, license and dependency implications; REST fallback if needed:
- Credentials and permissions; authenticated read that verifies account/org/project and routing partitions:
- Region/endpoints and resource scope validation; credential rotation behavior:
- SDK retry defaults and how to disable mutation retries; request timeouts, cancellation and error/rate-limit shape:
- Request/operation IDs, native idempotency and reconciliation APIs (distinguish correlation from deduplication):

## Sandbox lifecycle and interaction

- Creation inputs: prepared images/templates, OCI/build support, CPU/memory/disk, architecture/OS, env/secrets, working directory and user:
- Exact create-to-ready sequence, readiness evidence, startup limits, TTL/auto-stop/auto-delete and billing lifetime:
- Inspect/list pagination, reconnect in a fresh process, stop/start vs pause/resume, and compute deletion confirmation:
- Exec argv vs shell, exit status, binary/streamed output, detached processes/PTY, output bounds and cancellation effects:
- File read/write/transfer APIs, byte limits, atomic no-clobber, persistence and ephemeral paths:
- Diagnostics/request IDs and trace propagation hooks; sensitive fields that need redaction:

## Snapshots: complete capture → restore → cleanup workflow

- Native concept (image, template, checkpoint, reusable snapshot, etc.) and exact API calls for capture, status, restore and delete:
- Scope: whole private filesystem vs selected paths/workspace; memory/processes; excluded mounts, caches, secrets and external state:
- Default `box.snapshot()` workflow: automatic vs adapter-managed stop/pause/resume; previously running vs stopped source; restart failure and network connection effects:
- Real adapter configuration choices and proposed typed factory signature; label sketches as proposed/uncompiled:
- Consistency/quiescence guarantees and what callers must do themselves:
- Immutable captured identity vs mutable tag/alias; how restore still targets the captured artifact after an alias changes:
- Restore behavior: new sandbox, resumed processes vs fresh boot, image/region/runtime restrictions and independent writes between source and restores:
- Retention, expiry, quotas/cost dimensions, survival after source deletion and credential rotation:
- Deletion target/granularity and dependencies: one snapshot/build vs a containing template; explicit deletion vs incidental cleanup:
- Long-running capture, timeout/lost response, inspection, durable references and partial success (including capture success/restart failure):

If no native snapshot exists, record effect-free unsupported for this slice. Do not assume a portable archive/upload fallback. Lack of snapshots need not block the provider's core sandbox operations.

## Volumes and mounts

- Native storage concept/backing technology; create/get/list/delete/attach/detach APIs and stable identities:
- Mount paths, permissions/read-only, size/capacity, placement and sharing/concurrent attachment limits:
- Observable durability, locking, rename/atomicity and consistency guarantees; separate these from the storage product name:
- Persistence after compute stops/deletes, independent retention/expiry/billing, and dependency checks before deletion:
- Interaction with snapshot capture/restore: excluded, referenced or copied; share/replace/omit support and restrictions:
- Fresh-process reopen and what reference data the application must persist:

If unavailable, distinguish no native volume feature from one that cannot fit Sandbar's current contract.

## Network and security boundaries

- Isolation unit (process/container/microVM/etc.) and documented trust/tenant boundary:
- Default network behavior; internet allowed vs blocked, allow/deny lists, DNS, direct IP, IPv4/IPv6, UDP and provider-service exceptions:
- Enforcement layer, when policy takes effect, mutability and tier/region prerequisites; what strict blocked egress can actually promise:
- Ingress/preview URLs, ports, authentication, private networking/tunnels and metadata access:
- Evidence gaps and bounded positive/negative controls needed to test each proposed guarantee:

## Implementation recipes

For each operation proposed for the initial slice, supply a short call sequence or pseudocode with concrete public inputs (including one image selector for create), native methods/endpoints and request fields, readiness/completion responses, returned identity and scope checks, and failure/timeout/recovery/cleanup behavior. Link to details already documented above instead of repeating them. Examples are proposed/uncompiled unless validated; use placeholders for private IDs and credentials.

If an exact prerequisite or call is unknown, record it as a named investigation in the decision table with its blocking consequence. Unsupported or deferred operations need a reason and future gate, not a speculative implementation recipe.

## Recovery and implementation handoff

- Proposed adapter configuration/credential separation, stable provider name and public entrypoint:
- Native-client boundary and dependencies to pin; exact API sequences/pseudocode for in-scope operations:
- Serializable resource/operation references: required native IDs, scope, schema version and bounded recovery evidence; no credentials or API-key-derived signatures:
- Crash boundaries: pre-dispatch persistence, lost create/capture/delete responses, known retained resources, and read-only reconciliation vs explicit continuation:
- Unknown outcomes that cannot be reconciled and how callers will see them; do not promise exactly-once without native support:
- Ordered implementation tasks, contract changes needing a decision, and links to applicable Sandbar types/specs:
- Provider docs to write: defaults, actual choices, exclusions, recovery/cleanup and support/evidence level:

## Validation and acceptance

- Deterministic native-boundary cases: request/response mapping, effect counts, unsupported-before-effects, scope mismatch, retry behavior and lost-response recovery:
- Packed TypeScript consumer examples and runtime compatibility checks:
- Live E2E scenarios to add to the existing qualification harness; expected assertions and prerequisites:
- For snapshots: capture, inspect, fresh-process reopen, restore, two-way independent writes, repeated restore of original bytes, source cleanup and artifact cleanup as applicable:
- For volumes: persistence across compute teardown, reopen/reattach and independent cleanup as applicable:
- Proposed live budget: resource count, lifetime/wait limits, cleanup ownership, residual-resource reconciliation; authorization status (default: not requested):
- What is ready to implement, what is conditional, and what remains unverified:
- Consistency review: title/target rationale/label, capability summary, proposed useful scope, recipes, contract compatibility, readiness and acceptance criteria agree; unresolved blocking decisions are visible above:

## Sources

| ID  | Official URL / exact section or pinned source permalink | Version and access date | Claim supported / conflict or limitation |
| --- | ------------------------------------------------------- | ----------------------- | ---------------------------------------- |
| S1  |                                                         |                         |                                          |

Link claims to sources, not just a provider homepage. Label inference and conflicting evidence. Keep credentials, account/resource IDs, recovery references and raw private logs out of this issue.
