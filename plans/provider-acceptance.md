# Ordinary provider integration tests

PR #32 stays open as a draft while replacing custom test orchestration. The contract is simple: configure an adapter, exercise Sandbar's public SDK in ordinary Bun tests, assert observable behavior, clean test-owned resources, and generate a support table with concise caveats. The user owns final review and merge. No further paid allocations are authorized by this restructuring.

## Test shape

Use `describe`, `test`, `expect`, `beforeAll` and `afterAll` from `bun:test`. Bun owns selection, execution, timeout/failure reporting and standard JUnit. Shared helpers may configure providers, persist owned identities/recovery references and perform bounded cleanup. They must not schedule scenarios or collect a second set of pass/fail results.

The first bounded slice is Daytona snapshot roundtrip in `packages/sdk-qualification/live/snapshots.test.ts`. The body uses SDK handles directly and assertions an adapter author can read. Offline fixtures retain default capture/source lifecycle, filesystem isolation, RAM/fresh execution, fresh OS process reference reopen, source deletion, fresh connection, second restore and independent owned deletion. Tests cover setup/body/teardown/reopen failure and actual Bun setup/body timeouts. The fixture is published before provider IO, so teardown can abort late work; cleanup has its own bounded path.

Use the same pattern for `sandbox.test.ts`, `volumes.test.ts` and E2B's bounded IPv4 TCP `network.test.ts`. Volume CRUD remains independent of mounts. Advertised read-only support requires native rejection and unchanged bytes. Borrowed resources are never deleted. Exhaustive malformed input, retry/race and transport fault matrices remain offline.

| Before | After |
| --- | --- |
| `bun .../manual.ts live-state` plus custom selection and `Step[]` statuses | `bun test --preload .../live/preload.ts .../live/snapshots.test.ts`, standard `-t`, timeout and JUnit options |
| Assertion workflow embedded in `runState` with catch/status logic | Public SDK workflow and ordinary `expect` assertions in the test body |
| Custom baseline/state/network executors, manual launcher and branch/merged gates | Small provider factories and bounded resource setup/cleanup fixtures |
| Custom per-scenario pass/fail/observation collector | Thin offline JUnit case-to-feature mapping plus private provenance/cleanup context |

Superseded `manual.ts`, `lifecycle.ts`, `state-profile.ts`, `network-profile.ts` and revision gate code are removed after offline parity. Durable ownership custody and cleanup observation are retained, without a general resource-management framework. Historical report schemas/results remain readable; they are not relabeled as Bun evidence.

## Support table

Keep maintained supported/unsupported/conditional metadata and concise provider limitations separate from passed/failed/blocked/not-run results. Missing access is a failed or blocked exercise, never unsupported; skipped is not passed. A standard runner pass with unconfirmed cleanup/close cannot generate a passed claim. A thin JUnit transform supplies reviewed JSON input to the existing offline support generator. Publication is a reviewed repository edit, never an automatic side effect of testing.

Build shared packages sequentially before SDK imports, identify the exact source revision/native dependency/runtime/configuration, and reject dirty-source docs evidence. Branch and merged revisions use the same invocation. A historical pass covers its recorded source/configuration; unchanged production code may retain that provenance across merge, without inventing a current-head run or requiring paid work merely for a merge commit.

## Ownership and interruption

Persist scoped identities before effects and retain acknowledged resources after lost responses. Bun teardown cannot survive SIGKILL, so keep the persistent private ledger and explicit cleanup-only reconciliation command. Never replay uncertain creation or a saved delete, adopt resources by name, delete a ledger, or bypass custody through a new directory.

Preserve the independently reviewed provider-scoped admission correction and shared lock. Unresolved same-provider custody conservatively blocks new allocations; consistently identified E2B custody does not consume an independently approved Daytona budget. Unknown or conflicting identity fails closed. Preserve the original unresolved E2B volume receipt exactly. Provider TTL is fallback for compute, not storage cleanup or evidence of disappearance.

## Delivery

Demonstrate the snapshot slice offline, migrate remaining workflows with native-boundary parity, remove duplicate executors, rewrite qualification guidance and revise the draft PR description. Obtain independent reviews of coverage, cleanup and remaining custom machinery before marking ready. Run focused and required checks appropriate to the change; report that the new Bun path has not received live validation. Do not merge, publish, deploy, schedule monitoring or implement unrelated recovery DX, lifecycle changes, providers or CI architecture.

See the [operator README](../packages/sdk-qualification/provider-qualification/README.md) for invocations, finite per-suite budgets, cleanup and evidence review.
