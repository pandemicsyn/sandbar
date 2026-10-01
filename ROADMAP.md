# Sandbar roadmap

SDK usability comes before more adapters. This is the authoritative queue; specs describe contracts and proposals. Work becomes implemented when merged, while live validation retains its actual tested revision and configuration.

## Merged foundation

Snapshot/volume support (#25), tracing/diagnostics (#24), CI cleanup (#29), provider acceptance (#32), and ordinary recovery results/resource identities (#33) are implemented. See [CI validation](CI.md), the [acceptance plan](plans/provider-acceptance.md) and [recovery direction](specs/sdk-recovery-dx.md).

The latest SDK DX work is also merged:

- [PR #34](https://github.com/pandemicsyn/sandbar/pull/34): connection cleanup policy and per-call overrides.
- [PR #35](https://github.com/pandemicsyn/sandbar/pull/35): direct public types and actionable caller input errors.
- [PR #37](https://github.com/pandemicsyn/sandbar/pull/37): documentation reconciliation, including still-relevant guidance from #30.
- [PR #38](https://github.com/pandemicsyn/sandbar/pull/38): scoped sandbox references, fresh-process reopening, state and deadline inspection. Reopening does not implicitly create, resume or extend lifetime. Live reopening validation remains pending.
- [PR #39](https://github.com/pandemicsyn/sandbar/pull/39): removal of the optional service and management UI. The project now focuses on the SDK and adapter API.

The [streaming implementation brief](specs/interactive-execution-and-access.md) merged in [PR #36](https://github.com/pandemicsyn/sandbar/pull/36). It is a spec, not shipped streaming support.

Cleanup policy precedence is per-call choice, `cleanup.storage`, then `require-durable`. `allow-unconfirmed` permits compute destruction without promising flushed writes or deleting retained volumes. See the [state contract](specs/provider-state-portability.md#3-persistent-volumes-and-mount-sessions).

## Now: execution and cancellation DX

Keep these as separate, bounded PRs. Read cancellation and output helpers can proceed independently of streaming.

| Priority | Work                               | Readiness and scope                                                                                                                                                                                                                                                                                                                                  |
| -------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | E2B text streaming                 | Coding slice under review. One E2B command start, timely separate stdout/stderr text, confirmed exit and prompt local detach, using #38 non-resuming attachment. Finite bounded text only; no remote kill, reopening, binary streaming or Daytona. Deterministic/packed validation; maintained live scenario not run.                                |
| 2        | Read cancellation consistency      | Implementation in review. Caller cancellation for `readFile`, aligned read/inspection options, and one fixed 30-second local read deadline with prompt cleanup. Cancellation stops local observation; it does not terminate remote workloads. Live qualification remains pending.                                                                    |
| 3        | Output helpers and timeout clarity | [Implementation-ready brief](specs/output-and-timeouts.md), runtime unshipped. Two slices: full decoding/structured previews with existing defaults, and timeout docs/fixtures. E2B RPC timeout does not establish termination; Daytona documents termination with deployed-wrapper/descendant limits unverified. Native enforcement stays separate. |

The [execution brief](specs/interactive-execution-and-access.md#usage-and-delivery) defines signatures, defaults, provider limitations, acceptance cases and scope cuts. Do not introduce a generic process or durable workflow framework to deliver these slices.

## Next: lifecycle controls, then storage composition

Sandbox reopen/inspect is complete as an implementation slice. Timeout mutation and suspend/resume follow as separate PRs; both now have their merged lifecycle and recovery prerequisites.

1. **Reset native timeout:** accept explicit timeout scope before implementation. The proposal defaults to running-session scope for E2B and requires explicit sandbox-wide TTL for Daytona; resetting can shorten remaining lifetime.
2. **Suspend/resume:** accept native no-argument preservation defaults and optional exact requirements. The proposal uses Daytona container filesystem preservation and E2B memory pause, with native execution evidence or explicit unknown rather than fabricated continuity.

These remain product decisions in the [lifecycle spec](specs/sandbox-lifecycle.md#decisions-to-accept-and-later-documentation-edits). Neither mutation API is implemented. Keep mounted suspension and snapshot emulation outside these slices.

Mounted snapshot/restore composition and stronger volume visibility/durability/locking/rename semantics follow concrete provider requirements. Current unsupported combinations remain explicit. Capacity/placement, attach/detach, volume versions and native forks are optional extensions driven by demonstrated need. See [storage follow-ups](specs/sdk-recovery-dx.md#later-volume-guarantees-and-mounted-restore). Expanded persistence hooks, normalized recovery-facts envelopes and generic continuation/workflow machinery remain deferred.

## Qualification gaps

The generated [support table](apps/docs/src/content/docs/docs/providers/support.md) separates implementation from live evidence. Current follow-ups are:

- Run the maintained scoped-reopening scenarios for Daytona and E2B after explicit paid-run authorization; both are currently marked not-run.
- Investigate and disposition the recorded failed E2B network probe. Fix an integration defect if found, or document the demonstrated provider/configuration limitation; do not promote the result to a pass without evidence.
- Preserve the distinction between E2B volume account access blocked by HTTP 403 and Sandbar E2B mounts being unsupported. Resolve the historical volume-creation uncertainty only with sufficient evidence; newer successful cleanup does not erase it.

Use the existing Bun suites and generated docs. Historical passes cover their recorded revision/configuration; offline fixtures do not qualify live behavior. This roadmap does not authorize paid calls or require a new testing framework.

## Gate before new adapters

Vercel, Tensorlake and other adapters remain behind SDK usability. Before scheduling one, review whether applications can create/execute/transfer files, save and reopen supported resources, handle partial or uncertain outcomes, manage supported lifecycles and output, and clean up with clear retained-storage ownership. Tested public examples and the maintained acceptance suites must make those workflows understandable. Resolve or explicitly disposition material qualification failures and missing evidence.

This milestone does not require universal provider parity. Reassess material DX gaps with the user before scheduling new adapters; completing one small streaming slice does not automatically satisfy the gate.

## Later

Advanced process/access features and storage extensions follow demonstrated needs. Additional observability metrics/events and accounting remain deferred. The removed service and management UI are not on the delivery queue. Rust is not planned. [Detailed plans](plans/implementation-plan.md) do not override this queue.
