# Sandbar roadmap

Updated October 8, 2026 against main `af316b2`. This is the authoritative work queue. Contracts live in [specs](specs/README.md); public usage lives in the docs. Merged implementation and live qualification are separate facts.

## Current baseline

The SDK foundation and its planned everyday DX slices are merged: snapshots/volumes, partial outcomes and persisted identities, cleanup policy, creation defaults, reopen/inspect, lifetime renewal, native suspend/resume, file/text/directory APIs, HTTP preview access, finite E2B text streaming and termination, full-output helpers, and timeout clarification. [Finite stdin](specs/process-stdin.md) merged in #71 (release metadata/status corrected in #72); [selected-volume cold restore](specs/storage-composition.md) merged in #69. CI parallelization merged in #73; see [CI validation](CI.md).

These are completed slices, not outstanding implementation plans. Each retains documented provider limits: directory primitives are partial, previews have different protection modes, streaming/termination are E2B-only, and mounted restore is limited to eligible Daytona cold snapshots under `daytona-default`. The service and management UI were removed. Current exports and [provider support](apps/docs/src/content/docs/docs/providers/support.md) define the implemented surface.

## Current: SDK usability plans

Two focused plans own the next implementation work:

1. **[Filesystem DX](specs/filesystem-dx.md):** useful directory browsing/metadata and mkdir/remove on both built-ins; bounded-memory large transfers; copy/move and a complete artifact workflow. F1–F3 implementation is complete in this change, with the compiled artifact recipe and deterministic native-boundary coverage; live qualification is recorded separately. Traversal, text lines, ranges and batches are selected follow-ups, not prerequisites for basic filesystem usability.
2. **[Streaming and interactive processes](specs/process-io-dx.md):** bounded sustained output, status, incremental stdin/EOF, termination and build/server examples on Daytona and E2B. P0 first resolves the native transport; then deliver shared contracts and provider mappings in small PRs. P0 can run alongside F1. Preserve existing finite streaming until the new path is implemented and qualified.

These are proposed changes, not shipped support. Ordinary methods should handle provider mechanics; do not preserve unusable abstractions solely to avoid revisiting an overly strict contract. Existing guarantees change only through explicit compatibility decisions. The closed incremental-input proposal (#70) is superseded; use the new process plan, while finite ordinary exec input remains shipped.

## Qualification gaps

Use the existing [Bun integration suites](packages/sdk-qualification/provider-qualification/README.md) and reviewed results. Paid calls need a concrete bounded plan and explicit authorization; old approvals and completed run plans do not authorize another run.

| Priority | Remaining work                          | Current evidence / completion condition                                                                                                                                                                                                                                                                                            |
| -------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Finite exec input                       | `execution-stdin` is implemented but live not-run. Qualify bytes, EOF, output and cleanup for the claimed provider configurations. Deterministic/packed coverage is not live evidence.                                                                                                                                             |
| 2        | Configured creation and private ingress | Run the maintained configured-creation scenario; qualify E2B private-default ingress denial, including restore where claimed. #68's selected workflows do not establish these guarantees.                                                                                                                                          |
| 3        | Failed E2B network isolation probe      | At `431cdaa`, internet positive controls passed but blocked compute connected directly to `1.1.1.1:443`; hostname resolution failed. Mapping forwards `allowInternetAccess: false`. Investigate provider/configuration evidence before another identical run; no passing isolation claim or silent change to the requested policy. |
| 4        | Historical E2B volume uncertainty       | Preserve the unresolved creator receipts and private custody records until native evidence resolves them. Account HTTP 403 and unsupported Sandbar mounts are separate issues. New successful cleanup cannot clear an older uncertain creation.                                                                                    |

Scoped evidence already exists: #68 passed files, renewal, fresh-process reopening, E2B directories/finite streaming and supported previews at `3188e33`; #69's complete first-action selected-storage workflow passed at `5911ccc`. Daytona suspension passed at `6796b30`, E2B suspension at `26f516d`, and bounded E2B termination at `131a8c6`. Earlier failures and exact configurations remain in the [generated support/evidence pages](apps/docs/src/content/docs/docs/providers/support.md). These are not current-head or universal claims. OCI builds and stricter Daytona network controls also retain not-run evidence; qualify them when selecting those workflows, not as implied coverage from another pass.

## Follow-ups requiring a concrete use case

- **Storage:** mounted capture, memory-plus-volume restore, mounted suspension, dynamic attachment, copying/versioning/forks and stronger durability/visibility/locking/rename guarantees. The useful cold-restore composition is already shipped; these are not leftovers blocking #69.
- **Process/access beyond the active plan:** binary or reconnectable processes, PTYs and tunnels require separately selected slices. Sustained output, Daytona process support and incremental stdin are now in the active process plan. Native PID targeting limitations remain explicit; E2B termination is not process-tree termination.
- **Bounded exec outcomes:** a confirmed native exit followed by failed output retrieval can still leave the public outcome unconfirmed. The [process plan](specs/process-io-dx.md) includes a separate narrow follow-up to preserve exit evidence through output failure; do not replay execution.
- **Timeout enforcement:** documentation/fixtures are complete. Portable remote termination at an exec deadline needs stronger native evidence and a separate contract; current E2B RPC timeout does not prove termination.
- **Observability:** metrics and structured events remain deferred; tracing/diagnostics and Sentry/Datadog recipes are implemented.
- **Release compatibility:** track the deprecated empty-object restore-mount alias through its documented R/R+1 publication window before removing it. This is a release follow-up, not new storage implementation; see [migration rules](specs/storage-composition.md#compatibility-and-migration).

## Gate before new adapters

Vercel, Tensorlake and other adapters remain behind SDK usability. Reassess whether applications can create/execute/transfer files, reopen resources, handle partial outcomes, manage supported lifecycles/output and clean up with clear retained-storage ownership. Resolve or explicitly disposition material qualification gaps using tested examples and current evidence.

Universal native parity and every optional extension above are not required. Select the next adapter only after that usability review. Accounting, the removed service/management UI and Rust are not on the delivery queue. Completed plans and audit records live in Git history; do not recreate parallel backlogs.
