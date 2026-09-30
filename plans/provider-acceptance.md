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

Preserve the independently reviewed provider-scoped admission correction and shared lock. Unresolved same-provider compute, snapshot, mixed or unidentified custody conservatively blocks new allocations; E2B identified volume-only custody does not block suites with an enforced zero-volume budget. E2B volume CRUD and persistence skip before setup; consistently identified E2B custody does not consume an independently approved Daytona budget. Unknown or conflicting identity fails closed. Preserve the original unresolved E2B volume receipt exactly. Provider TTL is fallback for compute, not storage cleanup or evidence of disappearance.

## Delivery

Demonstrate the snapshot slice offline, migrate remaining workflows with native-boundary parity, remove duplicate executors, rewrite qualification guidance and revise the draft PR description. Obtain independent reviews of coverage, cleanup and remaining custom machinery before marking ready. Run focused and required checks appropriate to the change; retain exact live results and cleanup evidence without weakening a failed assertion. Do not merge, publish, deploy, schedule monitoring or implement unrelated recovery DX, lifecycle changes, providers or CI architecture.

See the [operator README](../packages/sdk-qualification/provider-qualification/README.md) for invocations, finite per-suite budgets, cleanup and evidence review.

## Authorized live validation

The user subsequently authorized live tests with failure cleanup checks. At clean source `1505ee0`, the ordinary Daytona Bun suites produced five passing tests and one lifecycle failure: the running owned sandbox was absent from managed inventory. Execution, files, snapshot roundtrip, volume CRUD and mounted persistence passed. The finite run used six total compute allocations (peak two), one snapshot and one volume; every creator has confirmed cleanup and all clients closed. A final read-only inventory found no known owned retained artifacts, but the failed managed inventory assertion means empty compute inventory is not independent cleanup proof.

E2B reconciliation made no allocation and still returned `OUTCOME_UNKNOWN` for the preserved original volume receipt. No new E2B tests were admitted. Raw JUnit, provider logs and receipts remain private; sanitized records retain exact source/configuration and failed lifecycle evidence. No creator retry, image build or additional live budget is included. PR #32 remains draft and unmerged.

## Failure investigation and E2B selection

The user requested diagnosis of the Daytona failure and explicitly directed E2B volume cases to skip without suppressing its other tests. A single Daytona diagnostic at `5ea4923` reproduced successful direct running inspection followed by two empty native lists; matching labels and SDK inventory appeared about 1.3 seconds after creation. The diagnostic compute has confirmed cleanup. Daytona documents listing as eventually consistent. Lifecycle now allows a 30-second read-only convergence window; permanent absence still fails, without another allocation.

E2B volume CRUD and persistence skip before setup. Admission isolates only consistently identified volume-only E2B custody when the new fixture enforces a zero-volume budget; compute, capture, mixed and malformed custody remain blocked. A pre-dispatch guard rejects new volume creators. The original receipt stays unresolved and unchanged. Independent admission review cleared the change. Live verification is bounded to six E2B compute allocations (peak two), one snapshot, no volumes, plus one Daytona sandbox; no image builds or creator retries.
