# Sandbar roadmap

SDK usability comes before more adapters. This file is the authoritative order of work; specs define contracts and detailed plans describe individual tasks. Status changes when work merges, not when a task starts or a PR opens.

## Now: finish the SDK foundation and DX cleanup

Snapshot/volume support merged in [PR #25](https://github.com/pandemicsyn/sandbar/pull/25). Direct tracing and diagnostics merged in PR #24. Four follow-ups are in progress:

| Work | Outcome | Detail |
| --- | --- | --- |
| CI cleanup | Remove duplicate runs/builds, make checks independently rerunnable, and fix flaky fixtures without hiding regressions. | Existing CI cleanup task. |
| Provider acceptance | One maintained public-SDK runner, a generated support table, and clear provider limitations and live validation status. | [Acceptance plan](plans/provider-acceptance.md) |
| Recovery DX | Typed partial outcomes, retained resource access, useful recovered result types, continuation status, and persistence hooks on normal connections. Reduce repeated adapter checkpoint code with small shared helpers. | [Recovery spec](specs/sdk-recovery-dx.md) |
| Documentation pass | Short working examples, accurate support claims, explicit cleanup responsibilities, and current implementation status. | SDK guides, provider docs and plan indexes. |

E2B volume creation remains unqualified because the test account receives HTTP 403; E2B mounts are unsupported in Sandbar. Existing snapshot and Daytona volume live results must retain their actual tested revision/configuration. Missing access is not proof that E2B lacks native volumes, and a historical pass is not a new-code pass.

## Next: make everyday sandbox and storage lifecycles usable

### Volume cleanup ergonomics — direction approved, implementation not started

Applications can select the writable-volume cleanup policy upfront for a client connection, with an explicit per-call override. Precedence is per-call choice, then configured choice, then the existing SDK default. Preserve `require-durable` as the unconfigured default unless a separate decision changes it.

Choosing `allow-unconfirmed` permits compute destruction; it never promises flushed writes or deletes retained volumes. Results still report actual durability and retained storage. Surface an unsatisfied cleanup requirement before it becomes an unexpected end-of-workflow failure where feasible; checks are observations, not reservations.

Keep this a small SDK/API task with compiled configuration and cleanup examples. No new flush implementation, background cleanup service or expanded storage guarantees are required. See the [state contract](specs/provider-state-portability.md#3-persistent-volumes-and-mount-sessions).

### Sandbox lifecycle — needs a focused spec before implementation

The [existing lifecycle direction](specs/provider-state-portability.md#4-suspension-resumption-and-expiry) is not yet a complete implementation brief. Split it into two bounded slices:

1. **Reconnect and lifetime:** reopen existing compute from a scoped saved identity in a fresh process, inspect its state and available expiry information, and extend a running session's lifetime where supported. Missing/expired compute must fail clearly; reconnect must not create or resume it implicitly.
2. **Suspend and resume:** explicitly preserve supported state, resume the same logical sandbox, and report process/execution changes and connection loss. No checkpoint/delete/recreate emulation presented as native suspension.

Before handoff, settle exact public signatures, saved-reference and state types, expiration/time-origin semantics, optional native fields, credential/scope behavior, cancellation and uncertain outcomes. Verify Daytona/E2B native mappings and enumerate unsupported cases. Define focused offline cases and representative live acceptance scenarios; paid validation needs separate authorization. Do not reopen the general recovery architecture or add service parity.

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
