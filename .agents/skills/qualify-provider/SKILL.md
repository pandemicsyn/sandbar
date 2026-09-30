---
name: qualify-provider
description: Extend ordinary Bun SDK provider integration tests and review evidence for the generated support table when adding a provider or fundamentally changing supported behavior. Routine changes use offline tests.
---

# Provider integration testing

Read `packages/sdk-qualification/provider-qualification/README.md`, the selected provider's public factory/native fixtures and `specs/package-conventions.md`. Live workflows are ordinary `bun:test` suites in `packages/sdk-qualification/live`; Bun owns selection, execution, timeouts, failures and JUnit. Reuse public SDK assertion bodies and small provider/resource fixtures. Do not add a scenario executor, custom result collector, certification framework or separate branch/merged execution paths.

## Choose the scope

Live testing is appropriate for a new provider or a fundamental guarantee change: command/file semantics, snapshot state/isolation, mounts, network policy, lifetime, ownership or teardown. Routine refactors, dependency updates without semantic changes, formatting and docs use deterministic fixtures and relevant packed/type checks. Keys and live-enable flags never grant authorization; ordinary CI remains offline with live cases skipped. Do not add recurring paid CI or scheduled runs.

Define a small workflow with observable public SDK assertions. Keep exhaustive malformed inputs, transport faults and races offline. Unsupported capability checks must reject before effects; missing account access is not unsupported. Snapshot capture alone does not prove restore/deletion; volume CRUD does not prove mounts; a requested network flag does not prove egress isolation.

Use the existing suites for lifecycle/argv/shell/nonzero/files, default snapshot roundtrip with two-way writes and advertised RAM/fresh execution, serialized-reference reopening in a separate OS process, source deletion/fresh connection/second restore, and volume CRUD/remount/read-only. Add a normal test for a new SDK guarantee rather than copying workflows into ad hoc scripts or hiding a custom runner inside one test.

## Prepare and run

Before requesting live approval, complete the concrete resource budget, total/peak allocations, setup/exercise/cleanup bounds, provider-native expiry and owned retained-artifact cleanup/interruption plan. Read the README's per-suite limits. Select only approved files/cases through Bun. No automatic creator retry or OCI/image build is included. Storage and costly build workflows need their own explicit scope and authorization.

Use the existing persistent owner-only ledger directory, never a new directory to evade unresolved custody. The SDK's awaited pre-dispatch hook saves scoped recovery references before effects. Tests expose fixture ownership before awaiting provider IO; setup/body cancellation forbids later creators and teardown has its own bounded signal. Preserve failures and attempt necessary cleanup within the authorized run without asking again. SIGKILL requires explicit reconciliation of the saved receipt. A final CI artifact upload cannot substitute for pre-dispatch durable custody.

Run the preload documented in the README to build sequentially before SDK imports. Record exact source/native version/runtime/platform/configuration; both branches and merged revisions use the same command. Debug dirty runs cannot produce clean-revision docs evidence. Credentials may be injected or read from owner-only `~/.config/sandbar.env`; never print/commit them. External profiles are trusted, effect-free committed adapter factories with pinned dependencies, nonsecret saved routing, finite bounds and concise feature declarations.

## Cleanup and admission

Bun hooks clean normal failures/timeouts; they cannot handle a killed process. Use `live/reconcile.ts` with the existing run UUID/current key/saved routing to observe uncertain attempts and delete only verified-owned resources. Existing delete receipts are observed without another DELETE. Keep uncertain capture source evidence and independently track snapshot/volume deletion. Native compute TTL is fallback, never a storage cleanup receipt. Cleanup or close failure makes the run unsuccessful.

Preserve the shared admission lock and provider-scoped check. Unresolved creators block the same provider across accounts/regions. Exclude another provider only when ledger and pending custody consistently identify it; malformed/unknown/conflicting identity fails closed. Respect any user-imposed shared limit. A Daytona pass cannot resolve E2B custody. Never replay uncertain creates, adopt resources by name, delete ledgers or clear a live process's lock. Before removing a crash lock, verify its recorded host/PID stopped. Keep the original unresolved E2B volume receipt unchanged; empty inventory or another 403 is not proof of its outcome.

## Review support evidence

Use standard Bun JUnit as the test-result source and the small offline `live/import-junit.py` mapping for existing feature IDs. Private context supplies build/configuration provenance and cleanup/close outcomes, not parallel pass/fail statuses. Hook failures, skipped cases, missing context and incomplete cleanup must never become green evidence. Keep raw JUnit, native logs, credentials, account/resource IDs and recovery references private.

Review sanitized records before intentionally appending selected evidence to `provider-qualification/results/<provider>.json`. Keep actual passed/failed/blocked/not-run distinct from supported/unsupported/conditional declarations. Fixture/packed tests cannot create live-qualified rows. Historical evidence retains original commits, configurations and missing provenance; never fabricate observations or relabel it as a current-head/Bun run. An unchanged tested path may retain its recorded evidence across merge without an unnecessary paid rerun.

Generate both support/evidence pages with `bun packages/sdk-qualification/provider-qualification/render.ts` and verify with `--check`; run affected docs checks. Declarations/caveats live in `support.ts` or equivalent external profile metadata. Do not hand-edit generated cells or unrelated marketing prose. A pass covers its tested operation/source/configuration only, never all runtimes, regions, images or provider features.

Hand off the test trigger/scope, offline and live results, exact evidence, owned cleanup, remaining limitations and unrun configurations. Get independent coverage/cleanup/custom-machinery reviews when migrating the test infrastructure. The user owns final merge; no live budget, deployment, publication or monitoring is granted by this skill.
