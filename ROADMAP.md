# Sandbar roadmap

SDK usability comes before more adapters. This file is the authoritative order of work; specs define contracts and detailed plans describe individual tasks. Status changes when work merges, not when a task starts or a PR opens.

## Now: finish the SDK foundation and DX cleanup

Snapshot/volume support merged in [PR #25](https://github.com/pandemicsyn/sandbar/pull/25), direct tracing and diagnostics in PR #24, and CI cleanup in [PR #29](https://github.com/pandemicsyn/sandbar/pull/29). See [CI validation](CI.md) for the implemented build reuse, independently rerunnable jobs and fixture fixes.

| Work                         | Status                                                | Outcome / detail                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider acceptance          | Implementation and validation in progress; not merged | One maintained public-SDK runner, generated support table, and honest provider limitations and validation status. [Acceptance plan](plans/provider-acceptance.md).                                                                                  |
| Recovery DX                  | Implementation and validation in progress; not merged | Clear call results/errors, provider-identifying resource handles, minimal saved references and direct partial results. Revise PR #33; expanded persistence hooks and workflow continuation are deferred. [Recovery spec](specs/sdk-recovery-dx.md). |
| Documentation pass           | Awaiting integration into main                        | [PR #30](https://github.com/pandemicsyn/sandbar/pull/30) merged into `agent/ci-cleanup` after #29 merged. Its clearer examples, provider limitations and plan updates are not on main yet; integrate the docs changes before marking this complete. |
| Volume cleanup configuration | Delegated; waiting for a committed recovery API base  | Add upfront connection policy and per-call overrides in one small PR; preserve existing unconfigured behavior. Details below.                                                                                                                       |

E2B volume creation remains unqualified because the test account receives HTTP 403; E2B mounts are unsupported in Sandbar. Existing snapshot and Daytona volume live results must retain their actual tested revision/configuration. Missing access is not proof that E2B lacks native volumes, and a historical pass is not a new-code pass.

## Next: make everyday sandbox and storage lifecycles usable

### Volume cleanup ergonomics — approved and delegated

Applications can select the writable-volume cleanup policy upfront for a client connection, with an explicit per-call override. Precedence is per-call choice, then configured choice, then the existing SDK default. Preserve `require-durable` as the unconfigured default unless a separate decision changes it.

Choosing `allow-unconfirmed` permits compute destruction; it never promises flushed writes or deletes retained volumes. Results still report actual durability and retained storage. Surface an unsatisfied cleanup requirement before it becomes an unexpected end-of-workflow failure where feasible; checks are observations, not reservations.

Keep this a small SDK/API task with compiled configuration and cleanup examples. No new flush implementation, background cleanup service or expanded storage guarantees are required. See the [state contract](specs/provider-state-portability.md#3-persistent-volumes-and-mount-sessions).

### Sandbox lifecycle — scoped; implementation not started

The focused [lifecycle spec](specs/sandbox-lifecycle.md) merged in [PR #31](https://github.com/pandemicsyn/sandbar/pull/31). It defines native mappings, proposed signatures, explicit unsupported behavior and acceptance cases. Deliver up to three independently useful PRs, each with its API, adapter implementation, focused tests and docs:

| Slice                   | Scope                                                                                                                                                                      | Dependency / readiness                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Reopen and inspect   | Reopen Sandbar-created compute from a saved scoped reference in a fresh process; inspect state and available deadlines. No implicit creation, resume or timeout extension. | Scoped for handoff. Coordinate create/restore reference changes with recovery DX. Verify the pinned E2B guest-attachment path before claiming support; use the spec's cut line if unavailable.  |
| 2. Reset native timeout | Explicit timeout scope, bounded native units, acknowledgement and no-replay recovery.                                                                                      | After slice 1 and recovery DX. Accept the proposed distinction between E2B session timeout and explicit Daytona sandbox-wide TTL before implementation.                                         |
| 3. Suspend/resume       | Daytona container filesystem preservation and E2B memory pause, with explicit native resume of the same logical resource.                                                  | After slice 1 and recovery DX; slice 2 is recommended but not mechanically required. Accept native defaults with optional exact requirements and native execution identity or explicit unknown. |

The proposed defaults and execution-evidence choices are recorded in [the spec's remaining product decisions](specs/sandbox-lifecycle.md#decisions-to-accept-and-later-documentation-edits); merging the research spec does not mark these APIs implemented or all decisions accepted. Slice 1 does not depend on accepting slice 2/3 choices.

Keep each PR bounded. The spec supplies scope cuts if guest attachment or provider transitions grow too large; do not introduce a generic lifecycle engine. No mounted suspension, snapshot emulation, service parity or new providers. Representative live acceptance requires separate paid-run authorization.

## Then: interactive execution and useful storage composition

- **Interactive execution, first slice:** process handles, stdout/stderr streaming, exit results, cancellation and reattachment where supported. Specify buffering, output gaps and disconnect behavior. Keep PTYs, endpoints and tunnels separate. The [interactive execution spec](specs/interactive-execution-and-access.md) is a draft, not a commitment to ship its entire surface at once.
- **Storage semantics and composition:** make visibility, durability, locking and rename guarantees understandable; support snapshots with attached storage and explicit reuse/replace/omit restore choices where native behavior permits. Unsupported combinations must be easy to discover. Schedule concrete slices from the [recovery spec's storage follow-ups](specs/sdk-recovery-dx.md#later-volume-guarantees-and-mounted-restore).
- Capacity/placement, dynamic attach/detach, volume versions and native forks remain optional extensions driven by an actual application need. They are not all prerequisites for a usable SDK.

## Gate before new adapters

Vercel, Tensorlake and other new adapters are **not next on deck**. Research can remain as reference material; it does not authorize implementation or take priority over the SDK work above.

Before scheduling another adapter, review whether an application can:

- Create compute, execute useful workloads, transfer files, manage supported lifecycle operations and clean up with a coherent public API.
- Persist identities, reconnect, and handle partial/uncertain outcomes without parsing provider tokens or guessing whether to retry a mutation.
- Use snapshots and retained storage with clear defaults, discover unsupported combinations, and understand which resources remain after cleanup.
- Get timely execution output and manage long-running work through the supported process API.
- Follow concise tested examples and trust the generated support matrix and maintained acceptance runner; routine CI must give reliable feedback.

This is a usability milestone, not universal provider feature parity. The baseline should be mostly feature complete for those workflows, with explicit limits. Reassess remaining material DX gaps with the user before moving new adapters onto the delivery schedule. No automatic “next provider” commitment follows the current cleanup tasks.

## Later

Advanced process/access features and storage extensions follow demonstrated needs. Additional observability metrics/events remain deferred beyond the implemented tracing baseline. Service expansion, management features and accounting stay distant; preserve existing service regressions without requiring new SDK features to ship through the service. Rust is not planned.

Keep this roadmap short. Link focused specs and remove completed task detail instead of accumulating review history or duplicate backlogs. Older sequencing in [the implementation plan](plans/implementation-plan.md) must be reconciled to this roadmap; it does not override this order.
