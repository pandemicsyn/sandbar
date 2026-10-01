# Sandbar roadmap

SDK usability comes before more adapters. This is the authoritative queue; specs describe contracts and proposals. Delegated work is in progress, and becomes implemented only when merged.

## Merged foundation

Snapshot/volume support merged in [PR #25](https://github.com/pandemicsyn/sandbar/pull/25), tracing/diagnostics in PR #24, CI cleanup in [PR #29](https://github.com/pandemicsyn/sandbar/pull/29), provider acceptance in [PR #32](https://github.com/pandemicsyn/sandbar/pull/32), and ordinary recovery results/resource identities in [PR #33](https://github.com/pandemicsyn/sandbar/pull/33). Main at `d186cea` includes #32 and #33. See [CI validation](CI.md), the [acceptance plan](plans/provider-acceptance.md) and [recovery direction](specs/sdk-recovery-dx.md).

[PR #30](https://github.com/pandemicsyn/sandbar/pull/30) merged into `agent/ci-cleanup` after #29 merged. Its commit is absent from main's ancestry. This documentation pass selectively integrates still-relevant guidance against current code; its old recovery and harness descriptions do not establish shipped behavior.

## Now: focused SDK usability work

| Work                                  | Status                                 | Scope                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Volume cleanup configuration          | Resumed; in progress, not merged       | Task `01a0f028-e7d6-7f70-9dd2-50e17296636f`: upfront connection policy and per-call override. Upfront policy is absent at `d186cea`.                                       |
| Public types and errors               | Delegated; in progress, not merged     | Task `01a0f4e3-70c7-73c1-bb40-6a161180b73e`: focused public API usability work.                                                                                            |
| Lifecycle slice 1: reopen and inspect | Delegated; in progress, not merged     | Task `01a0f4e3-ac2a-70d2-aabe-0684b897f7c1`: saved compute identity, fresh-process reopening, state and available deadlines. [Lifecycle spec](specs/sandbox-lifecycle.md). |
| Streaming and cancellation scope      | Delegated spec work; no implementation | Task `01a0f4e3-f581-7061-9398-17a555b52990`: bound the first streaming/cancellation slice. [Interactive execution draft](specs/interactive-execution-and-access.md).       |
| Documentation reconciliation          | In progress, not merged                | Everyday SDK examples, provider limitations and truthful indexes/status against current main.                                                                              |

Planned cleanup policy precedence is per-call choice, configured choice, then the existing `require-durable` default. `allow-unconfirmed` permits compute destruction without promising flushed writes or deleting retained volumes. This task adds no flush implementation or background cleanup service. See the [state contract](specs/provider-state-portability.md#3-persistent-volumes-and-mount-sessions).

Slice 1 adds no implicit creation, resume or timeout extension. Verify the pinned E2B guest-attachment path before claiming support; use the [lifecycle spec](specs/sandbox-lifecycle.md)'s scope cuts if needed. Paid live acceptance needs separate authorization.

## Next: decide later lifecycle slices and storage composition

Timeout mutation and suspend/resume follow slice 1 and the merged recovery foundation. Their timeout scope, native defaults and execution-evidence choices remain product decisions in the [lifecycle spec](specs/sandbox-lifecycle.md#decisions-to-accept-and-later-documentation-edits). Slice 1 does not depend on accepting those later choices. Keep delivery in separate bounded PRs.

Mounted snapshot/restore composition, stronger volume visibility/durability/locking/rename semantics, capacity/placement, attach/detach, volume versions and native forks require concrete provider work. Current unsupported combinations remain explicit. See [storage follow-ups](specs/sdk-recovery-dx.md#later-volume-guarantees-and-mounted-restore). Expanded persistence hooks, normalized recovery-facts envelopes and generic continuation/workflow machinery remain deferred.

Historical live evidence covers its recorded revision and configuration. The generated [support table](apps/docs/src/content/docs/docs/providers/support.md) preserves blocked/not-run results. E2B volume access remains blocked by account HTTP 403; Sandbar E2B mounts are unsupported separately. Offline fixtures do not qualify live provider behavior.

## Gate before new adapters

Vercel, Tensorlake and other adapters remain behind SDK usability. Before scheduling one, review whether applications can create/execute/transfer files, save and reopen supported resources, handle partial or uncertain outcomes, manage supported lifecycles and output, and clean up with clear retained-storage ownership. Tested public examples and the maintained acceptance runner must make those workflows understandable. This milestone does not require universal provider parity; reassess material DX gaps with the user before scheduling new adapters.

## Later

Advanced process/access features and storage extensions follow demonstrated needs. Additional observability metrics/events remain deferred. Service expansion, management and accounting stay distant; preserve existing service regressions without requiring new SDK parity. Rust is not planned. [Detailed plans](plans/implementation-plan.md) do not override this queue.
