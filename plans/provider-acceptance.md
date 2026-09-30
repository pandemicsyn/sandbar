# Simplify provider acceptance and support docs

Planned follow-up after [snapshot/volume PR #25](https://github.com/pandemicsyn/sandbar/pull/25) lands. This does not add requirements to that PR. The goal is a repeatable way to test an adapter's main SDK features and generate a small, accurate support table, with provider edge cases documented alongside it.

## Keep the feature tests; simplify how they run

Extend the existing [provider qualification harness](../packages/sdk-qualification/provider-qualification/README.md), rather than building a replacement framework. One maintained runner must work for built-in and external adapters, on an implementation branch or a merged revision, with the same assertions and report format.

A new adapter supplies a small provider profile: adapter construction, credentials/configuration requirements, capability declarations, and bounded time/resource defaults. Reuse existing capability descriptors where available; keep scenario prerequisites and documentation notes in the profile. Allow narrow provider setup/probe hooks where semantics require them, but run the workflow through the public SDK. Do not monkeypatch SDK methods or copy whole scenarios into temporary scripts.

The normal workflow should be:

1. Configure the adapter and select supported feature groups.
2. Run the shared acceptance command with an explicitly authorized resource budget.
3. Inspect the feature results and cleanup outcome; fix integration defects or document genuine limitations.
4. Generate the docs table offline from maintained profiles and reviewed, sanitized results.

Adding a provider should normally require a profile and provider notes, not edits to the shared runner. Adding a genuinely new SDK feature may require a new shared scenario.

## Test observable SDK behavior

Retain existing meaningful assertions. Group them into user-facing features rather than presenting every assertion as a separate support-table row.

| Feature group | Live acceptance evidence |
| --- | --- |
| Sandbox lifecycle | Create, inspect, inventory, destroy, and confirm cleanup. |
| Execution | Execute commands through the SDK; verify output and nonzero exits. |
| Files | Write/read bytes and verify supported overwrite behavior. |
| Snapshots | Capture, inspect, restore preserved state, prove independent writes, reopen a persisted reference from a fresh process, restore after source deletion, and delete. Assert the adapter's documented filesystem/memory and source-restart semantics. |
| Volumes | Create/inspect/delete independently of mount support. Where mounts are supported, write through one sandbox and read through another after destroying the first; verify read-only behavior when advertised. |
| Network controls | Exercise advertised allow/deny behavior with a reachable control endpoint; merely accepting a configuration flag is not proof. |

Snapshot capture alone does not prove restore/delete support. Volume CRUD does not prove persistent mounts. Keep those distinctions in the capability data and table wherever support differs. Unsupported operations should have offline contract coverage for the expected SDK error; they do not require paid attempts to fail live.

Keep exhaustive fault injection, cancellation races, malformed references, and recovery transition combinations in deterministic offline tests. Live tests cover representative end-to-end workflows and native guarantees; they are not an exhaustive provider reliability study.

## Generate a small support matrix

Use one maintained source for declared capabilities, concise limitations, and links to reviewed live evidence. Generate the overview currently maintained in [support.md](../apps/docs/src/content/docs/docs/providers/support.md) and any retained evidence detail from that source. Avoid manually synchronizing two accounts of support.

Keep two facts distinct:

- **Adapter support:** supported, unsupported, or conditional on a documented configuration. Native provider functionality does not count until the adapter exposes it.
- **Live validation:** passed, failed, blocked, or not run, with the tested configuration, date, and source revision.

The public overview is a feature-by-provider table. Use compact cells such as `Supported · passed`, `Supported · unverified`, `Supported · failing`, `Unsupported`, or `Conditional [note]` with validation shown for the tested configuration. Explain these labels once. A missing credential, provider outage, or expired test budget must never turn into `Unsupported` or a passing result.

Link cells to short provider notes for real restrictions: snapshot scope, process-memory behavior, interruption/restart defaults, mount exclusions, network semantics, or account prerequisites. Keep detailed scenario records out of the overview. Do not infer one configuration's support from another, or hide a later failed run for the same configuration behind an earlier pass.

## Use the same evidence before and after merge

A test must identify the actual SDK/adapter build, dependency versions, provider profile, and source revision it exercised. Build shared packages in order before loading them; stale bundles must invalidate a run. Keep provenance in the maintained runner instead of requiring ad hoc script hashes and separate diagnostic launchers.

An unmerged revision is valid acceptance evidence for that revision. After merge, a reviewed successful run can support the docs when relevant SDK/adapter code, dependencies, and test configuration are unchanged; record the relationship to the merged revision. Do not require another paid run merely because documentation or the merge commit changed. Changes to tested behavior require the affected feature groups to be rerun before their validation claims advance.

Publishing support docs remains a reviewed repository change. Running a test does not automatically publish claims, and historical results never become evidence for changed code by relabeling them.

## Preserve bounded runs and cleanup

Keep explicit authorization for paid calls, finite resource counts and deadlines, cleanup in normal and failure paths, and the existing durable record of run-owned resource identities for reconciliation after interruption. Cleanup may only target resources the run is authorized to remove. Provider TTLs do not substitute for snapshot/volume cleanup.

Report cleanup separately and treat unresolved resources as an unsuccessful overall run. Do not repeatedly allocate until a flaky workflow passes. Reuse existing safety mechanisms; this follow-up does not introduce another orchestration system.

## Delivery and completion

1. Consolidate useful snapshot, volume CRUD, and fresh-process recovery scenarios from the PR into the maintained runner. Preserve its baseline and state assertions; remove superseded temporary paths once parity is established.
2. Simplify branch/release execution into one command path and a small documented profile interface. Exercise external-adapter loading with an offline fixture, without implementing another provider.
3. Generate the overview and provider caveat links from the shared metadata/results. Add focused offline coverage for unsupported, conditional, unverified, failed, and passed cases, plus stale-build rejection.
4. Update the harness README and the [qualification](../.agents/skills/qualify-provider/SKILL.md) and [adapter-authoring](../.agents/skills/add-provider/SKILL.md) skills to describe this workflow and remove contradictory merged-only certification rules.

Done means an implementer can configure a new adapter, run its supported main features, and produce the docs table without a bespoke runner or manually editing support cells. Existing failures and missing live evidence remain visible. Any paid validation of this refactor needs separate authorization; this plan does not grant it.

No service work, new provider implementation, general workflow engine, or expansion of the snapshot contract is included. The [recovery DX follow-up](../specs/sdk-recovery-dx.md) remains a separate feature effort.
