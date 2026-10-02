# Provider integration tests and support evidence

Live SDK workflows are ordinary `bun:test` suites in [../live](../live). Bun owns test selection, assertions, timeouts, exit status and JUnit output. Small fixtures configure a public adapter, track test-owned resources and clean them up. There is no scenario scheduler or second pass/fail collector.

## Run offline first

Use Bun 1.3.14 and the frozen workspace lockfile. Build shared packages sequentially before importing SDK bundles:

```sh
bun run build:packages
bun test packages/sdk-qualification/live packages/sdk-qualification/provider-qualification
bun run --cwd packages/sdk-qualification check
```

Ordinary CI skips live cases. Deterministic fixtures exercise the same assertion bodies, native provider boundaries, lost acknowledgements, saved-reference reopening and cleanup. Actual Bun subprocess tests cover setup/body timeouts and standard JUnit hook failures. Keep exhaustive transport faults and malformed inputs in offline provider tests.

## Explicitly authorized live runs

Prepare a concrete budget and obtain explicit user authorization before running live tests. Credentials or `SANDBAR_LIVE=1` do not grant permission. The preload refuses ordinary CI and missing authorization, then rebuilds packages before SDK imports. Debug runs may use a dirty checkout, but the docs importer rejects dirty-source evidence. Record the exact tested revision; branch and merged revisions use the same command.

Use an existing owner-only persistent `SANDBAR_QUAL_LEDGER_DIR`, outside the checkout and temporary directories. Keep this directory across runs. Use a fresh owner-only `SANDBAR_LIVE_REPORT_DIR` for each invocation's private context/JUnit. Built-in credentials can be injected or read from owner-only `~/.config/sandbar.env`; never print or commit them.

For one approved Daytona snapshot roundtrip:

```sh
export SANDBAR_QUAL_PROVIDER=daytona
export SANDBAR_DAYTONA_TARGET=us
export SANDBAR_DAYTONA_SNAPSHOT_ID=<borrowed-active-linux-snapshot>
export SANDBAR_DAYTONA_NETWORK_POLICY=daytona-default
export SANDBAR_QUAL_LEDGER_DIR=<existing-persistent-private-directory>
export SANDBAR_LIVE_REPORT_DIR=<fresh-private-report-directory>
export SANDBAR_LIVE=1
export SANDBAR_QUAL_LIVE_AUTHORIZED=yes
bun test --preload ./packages/sdk-qualification/live/preload.ts \
  packages/sdk-qualification/live/snapshots.test.ts \
  --reporter=junit --reporter-outfile="$SANDBAR_LIVE_REPORT_DIR/junit.xml"
```

Select suites by file and cases with Bun's `-t` option. Do not run concurrent live fixtures. Run only the files/cases included in the approved budget; use explicit suite paths rather than the entire `live` directory. Save Bun's actual exit code for evidence import. Do not repeatedly allocate until a failing test passes.

E2B uses `SANDBAR_QUAL_PROVIDER=e2b`, optional `SANDBAR_E2B_TEAM_ID`, and `SANDBAR_E2B_TEMPLATE_ID` (default borrowed `base`). Its native lifetime is 300 seconds. Daytona's native lifetime is 15 minutes. `daytona-default` allows essential services and does not prove strict blocked egress. Strict `blocked` requests require eligible organization settings. Borrowed prepared snapshots/templates are never deletion targets.

| Suite/case | Maximum owned resources per fixture | What the assertions prove |
| --- | --- | --- |
| `streaming.test.ts` / `execution-streaming` (E2B only) | 1 compute, zero snapshots/volumes | Finite text arrives before exit, separate stderr, ordinary nonzero result, owned compute teardown. Setup 90s, exercise 240s, cleanup 60s, E2B native TTL 300s. Not run; separate paid authorization required. |
| `sandbox.test.ts` | 1 compute | Running inspect/inventory, argv/env/cwd/stdout/stderr, shell, nonzero error, binary files, overwrite, rejected no-clobber and unchanged bytes; `lifecycle-renew` sends one 61-second request (Daytona resolves 120, E2B 61), checks the observed deadline within request-duration plus five seconds of clock tolerance, rejects above the SDK ceiling without another POST, then uses existing owned cleanup. No additional allocations; live scenario not run. `lifecycle-suspend-resume` uses the same one compute, writes known bytes and starts a bounded nonce/counter process, pauses once, reopens inactive in a separate process, rejects guest access without waking, resumes once, checks unchanged identity/files, Daytona ended process versus E2B advancing correlated counter, then shared owned cleanup. Passed for Daytona at `6796b30` and E2B at `26f516d`; see the exact evidence below. `lifecycle-reopen` persists the scoped reference, closes/reconnects, reopens in a separate OS process, checks original bytes/exec and unchanged deadline, deletes owned compute and verifies absence. E2B requires a known session deadline for no-extension evidence. Owned teardown uses the existing ledger. |
| `snapshots.test.ts` | 3 total compute, peak 2; 1 snapshot | Native default capture/source lifecycle, exact metadata, two-way filesystem isolation, advertised RAM nonce/counter or fresh-process observations, serialized reference reopened by a separate OS process, fresh SDK connection after source deletion, second restore of original bytes, independent storage deletion. |
| `volumes.test.ts -t volume-crud` | 1 volume; no compute | Create/readiness/inspect/delete without implying mounts. |
| `volumes.test.ts` persistence | 1 shared volume; 2 compute, or 3 when read-only is advertised; peak 2 | Native mount, bounded write/flush/readback, producer destruction, independent remount/readback, and native read-only rejection plus unchanged bytes when advertised. |
| `network.test.ts` (E2B borrowed `base` only) | 2 compute | Same reachable IPv4 TCP control before and after the blocked probe; bounded measured hostname/direct IPv4 denial. No DNS/UDP/IPv6/ingress/metadata/tenant isolation claim. |

Each fixture has a 30-second setup limit, at most 240 seconds for exercise, and an independent 60-second cleanup budget plus bounded client release. Bun hooks allow the cleanup path to finish. For suspension selection, Daytona hard TTL continues while stopped (15 minutes initially; earlier selected renewal may shorten it). E2B uses 300 seconds per active session; paused state has indefinite retention, so approval must cover residual storage and explicit owned kill reconciliation after interruption. No snapshots/volumes/builds, at most one pause/resume, exercise 240 seconds and cleanup 60 seconds. Native TTL is fallback after process loss; retained snapshots and volumes need separate deletion. The pre-dispatch hook enforces creator attempt counts and peak two compute; no OCI build or creator retry is included. Test selection never suppresses teardown. Missing access fails the selected test; declared unsupported cases skip and never become passed evidence.

## Crash cleanup

The awaited SDK reference hook persists scoped recovery identity before native effects, and later checkpoints retain acknowledged IDs/tokens. Teardown first observes pending creators without replay, then destroys compute and independently deletes verified-owned retained artifacts. Existing delete receipts are observed without another DELETE. An uncertain capture preserves its source evidence. Cleanup or SDK close failure fails the run.

SIGKILL cannot run Bun hooks. Reconcile the existing receipt with the current key and saved routing:

```sh
SANDBAR_QUAL_LEDGER_DIR=<same-persistent-directory> \
  bun packages/sdk-qualification/live/reconcile.ts <run-UUID>
```

Reconciliation rebuilds before SDK imports, takes the shared directory/run locks, permits observation and verified-owned cleanup only, and exits unsuccessfully on unresolved custody. It preserves historical receipt fields. It requires no new allocation authorization. External profiles must also supply their original `SANDBAR_QUAL_PROFILE` path.

The shared `.admission.lock` serializes runs and reconciliation. Prior unresolved creators block the same provider conservatively across accounts/regions. E2B volume CRUD and persistence are unsupported and skip before setup. Its identified volume-only pending receipt may coexist with a new suite whose enforced volume allocation budget is zero; pending compute, snapshot, mixed or malformed custody still blocks admission. The original receipt remains unresolved and unchanged. Another provider may proceed only when all pending custody consistently identifies the other provider, within its separately authorized budget. Unknown/malformed/conflicting identity fails closed. A shared user-imposed limit still applies. Never delete ledgers, adopt resources by name, create a new ledger directory to bypass custody, or clear a live process's lock. After a crash, verify its recorded host/PID has stopped before removing a stale lock for reconciliation.

## Provider factories

Built-in configuration/factories remain in `daytona-profile.ts` and `e2b-profile.ts`. External authors export `defineProviderProfile(...)` from `profile.ts`: stable ID, effect-free configuration, public SDK connection, nonsecret saved routing, credential variables, pinned native dependency version, finite native/exercise/cleanup bounds, support declarations and concise caveats. See [fixtures/external-profile.ts](fixtures/external-profile.ts) and its offline tests. Set `SANDBAR_QUAL_PROFILE` to the trusted committed profile and select its ID with `SANDBAR_QUAL_PROVIDER`. Pin external packages in the lockfile. Profile metadata does not prove account entitlement.

## Generate reviewed support evidence

Bun's standard JUnit is the only test-result source. Private context files add build/configuration provenance and actual cleanup/close outcome. The small offline importer records each named case once, using workflow IDs for grouped checks and preserving individual IDs for single-scenario cases; it does not execute tests, inspect providers or publish docs:

```sh
python3 packages/sdk-qualification/live/import-junit.py \
  --junit <private-junit.xml> --contexts <private-report-directory> \
  --exit-code <actual-bun-exit-code> --evidence-ref <reviewed-evidence-reference> \
  --output <new-sanitized-summary.json>
```

Review the summary and private receipts before intentionally appending selected records to `results/<provider>.json`. Unnamed Bun hook failures invalidate associated evidence; no contextualized executed cases means no importable result. Skipped is `not-run`; incomplete cleanup/close is unsuccessful. The importer excludes native logs, credentials, hostnames, resource IDs and recovery references. Keep private context/JUnit/receipts outside the repository. The reviewed source revision and asserted workflow define a Bun pass; do not manufacture historical observation booleans.

Declared supported/unsupported/conditional capabilities in `support.ts` are separate from passed/failed/blocked/not-run evidence. Missing access is not unsupported. Fixtures/packed checks never produce a live pass. Generate both public pages offline:

```sh
bun packages/sdk-qualification/provider-qualification/render.ts
bun packages/sdk-qualification/provider-qualification/render.ts --check
```

Use `--profile`, `--results` and `--output` for an external provider's offline docs. Historical records keep their original provenance and validation. The reviewed Daytona run at `1505ee0` used the ordinary Bun suites: execution, files, snapshot roundtrip, volume CRUD and mounted persistence passed; lifecycle failed because managed inventory omitted the running owned sandbox. All six compute instances, one snapshot and one volume have confirmed cleanup, and clients closed successfully. The lifecycle workflow failed; the grouped JUnit case cannot assign failures to individual operations. Teardown remains independently confirmed. Earlier `9a6c1c1` evidence retains its former-executor provenance. E2B cleanup-only reconciliation still returned `OUTCOME_UNKNOWN`; its original volume receipt remains unresolved, and no new E2B allocations were made. Empty inventory or a different rejected request does not resolve that receipt. This completed run grants no additional paid budget.

Daytona native sandbox listing is [eventually consistent](https://www.daytona.io/docs/openapi.json). A one-sandbox diagnostic at `5ea4923` reproduced two empty list reads after a successful running detail read, then matching list/detail labels about 1.3 seconds after creation. Its compute cleanup was confirmed. The lifecycle assertion now waits up to 30 seconds using read-only inventory scans, without another allocation; permanent absence still fails and tears down. The original `1505ee0` failure remains recorded.

Supported E2B suites ran at `8449def` with zero volumes: lifecycle, execution, files and snapshot roundtrip passed with confirmed cleanup. The original network run returned `OUTCOME_UNKNOWN` during the blocked guest command. DNS resolution is now isolated in a subprocess with a three-second deadline, killed and reaped on expiry; TCP connects retain their three-second limits. The single additional paired run at `431cdaa` returned a concrete failure: both positive controls passed, the blocked hostname lookup failed, and direct IPv4 TCP to `1.1.1.1:443` connected. All eight E2B compute allocations across these runs and the owned snapshot have confirmed cleanup. The original unknown volume receipt is byte-for-byte unchanged. Daytona baseline verification at `8449def` passed all three cases with cleanup confirmed. No further live retry is included.

### Preview access acceptance (not run)

`live/preview.test.ts` maintains `preview-protected` for Daytona and `preview-public` for E2B. It uses one owned prepared-image sandbox, zero snapshots/volumes, Python 3 for a temporary HTTP listener, setup 90 seconds, exercise 240 seconds and cleanup 60 seconds. Native fallback expiry is the existing 15-minute Daytona TTL or 300-second E2B session. Explicit paid authorization and the normal private ledger/preload remain required. E2B public exposure also requires `SANDBAR_E2B_PREVIEW_ACCESS=public`; routing saves that choice for reconciliation. This publishes HTTP ports from creation, including any image-owned services. Ordinary protected/default E2B profiles remain private and cannot run public preview acceptance.

The body checks access before listener readiness, unchanged expiry after lookup, correct content, anonymous/invalid-header denial for Daytona, reopened access, missing compute rejection and owned teardown. Python absence or proxy errors fail the case and do not become qualification. No expiry-timer or native pause/resume token assertion is claimed; those remain documentation/source evidence and deterministic unsupported-state checks. Earlier lifecycle/exec passes do not qualify the new E2B inbound protection default. Neither case has run.

### Directory acceptance (unrun)

The `file-directories` case in `live/sandbox.test.ts` uses the suite's existing one owned sandbox (no added allocation, snapshot, volume, image build or retained artifact). E2B only: recursive mkdir/idempotence, byte IO, dangling-link existence/removal, final-link target preservation, native parent-link traversal, unsupported nonrecursive/listing requests, root refusal and missing removal. It uses `/bin/sh` and `ln` only to seed test links, with paths supplied as positional argv; SDK directory operations use native file APIs. The body keeps the existing 240-second exercise bound; teardown retains the suite's separate cleanup bound and provider-native TTL/ledger custody. Any files remaining after a body failure stay in the owned sandbox until teardown destroys it. The prepared image must supply those setup utilities; this source change does not authorize a paid run or qualify deployed guest versions. Other providers skip this unsupported case.

### Suspend/resume live evidence

On October 2, 2026, the single maintained `lifecycle-suspend-resume` case passed for Daytona at `6796b30` (Bun 1.3.14, darwin-arm64, borrowed prepared snapshot, `us`, `daytona-default`, 15-minute hard TTL). It verified inactive reopening in a separate process, no implicit guest wake, explicit stop/start with unchanged UUID/files/expiry, and terminated process state.

E2B borrowed `base` with private traffic defaults first failed at `6796b30` during guest attachment before pause. The pinned API's omitted/null domain mapping was corrected without implicit connect. One bounded confirmation at `cb39884` passed the initial file/process setup, then rejected suspension because native detail omitted mount facts. Neither run establishes an E2B lifecycle pass. The revised lifecycle mapping keeps missing mount facts unknown without blocking private filesystem/RAM preservation, rejects known native mounts and excludes external-storage durability/consistency. Bounded confirmation passed at `26f516d` with inactive fresh-process reopening, same identity/files and preserved RAM nonce/advancing counter after explicit resume. All four owned compute allocations have confirmed cleanup and client close, with zero snapshots/volumes/builds. Historical failures and the unrelated unresolved E2B volume receipt remain unchanged.
