---
name: qualify-provider
description: Plan and extend Sandbar live provider acceptance tests and certify evidence for the docs support matrix when adding a provider or fundamentally changing supported behavior. Routine changes use offline tests.
---

# Qualify provider support

Use the bounded public-SDK qualification harness in `packages/sdk-qualification/provider-qualification`. Read its `README.md`, the selected provider's current public factory and nearby native fixtures, and `specs/package-conventions.md` before planning a run. A proposed API or an unmerged profile is not runnable support. If the harness/profile is unavailable on the selected commit, report that gate explicitly; do not substitute a legacy partial live script or private driver calls.

## When to run live E2E tests

Live qualification is an acceptance gate for:

- A newly added provider, before claiming its operations work against the real service.
- The first implementation of a fundamental feature, such as volume snapshots, or a material change to its public behavior.
- Fundamental changes to existing guarantees: image creation, command/file semantics, scope and isolation policy, resource lifetime, ownership, recovery or teardown. Run the affected providers and scenarios; a shared semantic change may affect every provider that claims the guarantee.

Do not run paid E2E tests for every PR, release, dependency update, documentation edit, formatting change or internal refactor. Use deterministic native fixtures, SDK tests and packed consumer checks for routine work. A dependency update triggers live qualification only when its actual behavior changes one of the fundamental guarantees above. Record the trigger and the finite affected scenario set in the handoff.

These are manual, opt-in runs. Do not add recurring paid CI runs or scheduled certification. Ordinary CI and docs builds must remain fully offline. A user may explicitly authorize an exceptional diagnostic live run; do not infer that authorization from a key file or from this skill.

Before requesting live approval, prepare the concrete resource budget, maximum concurrency/lifetime and build duration, provider-native expiry, owned-artifact cleanup and interruption recovery plan. Use the harness's private durable ledger and pre-submit checkpoint. For CI, that checkpoint must survive runner loss before dispatch; a final artifact upload is insufficient. If ownership, native lifetime or retained-artifact cleanup cannot be established, keep the scenario blocked. OCI/build and retained storage require their own budget and cleanup gate.

Keys may come from `~/.config/sandbar.env` through the manual entrypoint, or injected environment variables. Never print or commit them. Credential presence and a live-enable flag are not permission to create resources. Once a bounded run is explicitly authorized, complete its necessary teardown/reconciliation without asking again.

## When to extend the scenarios

Add or change a shared scenario when the public SDK gains a fundamental guarantee or materially changes one that the docs will claim. Start with one small end-to-end user workflow and observable assertions. Put exhaustive malformed inputs, transport faults, retries and race coverage in the existing deterministic provider fixtures.

For each new scenario, define:

- Stable scenario ID, intended public API and exactly what a pass proves.
- Prerequisites and configuration: runtime, image class, network policy, region and native dependencies. Use the public factory and normal SDK methods; no private hooks that bypass consumer behavior.
- Expected output/state, supported and unsupported behavior, and dependencies on other scenarios. Missing essential functionality must be reported explicitly; it is not a silent skip or a pass.
- Maximum resources/time and a teardown receipt for every run-owned billable artifact. Borrowed resources are never deletion targets. Persist identity before effects; observe uncertain attempts without replay. Keep unresolved residuals durable and actionable.
- Failure capture before teardown: stage, useful error name/code/message, expected/actual observations and bounded bytes/output. Retain cleanup failures separately and block dependent scenarios after failed prerequisites. Include deployed service version when available, without treating a missing version as an exercise failure.
- Offline harness/report tests and provider fixtures for the new assertions, failure diagnostics, redaction and cleanup behavior before any paid run.

Example: first-time volume snapshot support needs a scoped workflow that creates an owned volume, writes known bytes, snapshots it, changes the bytes, restores through the public API and verifies the snapshot content. Qualify whichever persistence/reopen behavior the API actually promises. Track and clean up the sandbox, volume and snapshot independently, including retained storage costs; compute TTL does not expire storage. A provider without that guarantee gets an explicit unsupported/blocked row. Do not invent a guest agent, new volume API or broad fault campaign just to fill the matrix.

Extend the existing scenario runner and report schema only as needed. Keep prepared-image baseline separate from OCI/build and other costly profiles. Selection may omit unrelated operations, but connect, owned-resource teardown confirmation and close remain mandatory.

## Certify the docs matrix

1. Select the exact clean, merged SDK commit and package version. A separately reviewed harness branch may run only when the production SDK sources and dependency pins are identical to that merged commit; record the harness commit separately. The launcher checks this against the fetched `origin/main` history. Confirm the profile uses shipped public APIs and deliberate pinned native dependencies. Run the relevant offline fixtures, harness tests and packed consumer checks first; fix failures before requesting a live run.
2. Run only the approved providers/scenarios/configurations using the manual command documented in the current harness README. Do not collect account-wide resources for cleanup. Preserve test failures while attempting teardown; use standalone reconcile after an interrupted or uncertain run.
3. Review the private ledger and sanitized result. Each record must include provider/scenario ID, execution mode, status, SDK commit/version, harness commit, native version, runtime/platform, timestamp, image/requested-network/region class and an evidence reference. Never publish credentials, account IDs, resource IDs, recovery refs or native logs. Keep private receipts outside the repository. Review structured diagnostics as well as statuses; retain useful error details while replacing credentials, auth fields, native IDs and recovery tokens with placeholders. Never invent missing historical diagnostics; another diagnostic live run requires explicit authorization.
4. Commit only reviewed sanitized JSON artifacts under `packages/sdk-qualification/provider-qualification/results/`, with a resolvable evidence reference. Do not invent a record for an unrun test. Preserve `passed`, `failed`, `not-run`, `unsupported` and `blocked` distinctly. Fixture and packed evidence stays labeled and can never produce a live-qualified row.
5. Generate the dedicated page with `bun packages/sdk-qualification/provider-qualification/render.ts`; verify drift with the same command plus `--check`, then run the affected docs checks/build. The target is `apps/docs/src/content/docs/docs/providers/live-qualification.md`. Do not hand-edit generated cells or sweep unrelated marketing/support prose.
6. Review the resulting table and artifact diff. A live pass qualifies only the recorded operation, commit and configuration, and the run must have confirmed cleanup. Scenario successes from incomplete cleanup remain incomplete. A prepared-image pass does not certify arbitrary OCI images, other regions, all runtimes or all native features. A requested network policy does not prove egress isolation; add a dedicated bounded assertion before certifying that guarantee. A provider-wide green badge is not a substitute for operation evidence.

Keep earlier passes as dated historical evidence; a newer failure for the same configuration supersedes the older pass. After fundamental behavior changes, an old pass remains evidence for its old commit, not certification of the changed behavior. Until the authorized rerun succeeds, describe the affected new behavior as not yet live-qualified. Missing keys or approval means not-run; unsupported is not passed; unresolved cleanup means an incomplete run.

Hand off the run trigger, tested scope, exact evidence, cleanup result, remaining unsupported/blocked operations and untested configurations. Merged implementation, deterministic fixture coverage, packed distribution checks and live certification are separate facts.
