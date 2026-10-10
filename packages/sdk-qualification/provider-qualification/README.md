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

Completed run plans are retained in Git history. Keep reviewed outcomes and provenance in [results](results/README.md), generated support pages and private custody records. No completed run grants additional live budget; remaining work is tracked in [the roadmap](../../../ROADMAP.md#qualification-gaps).

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
| `process-extensions.test.ts` (both built-ins) | 1 total/peak compute, zero snapshots/volumes/builds/previews | Saved scoped process reference, stdin-preserving disconnect, stale-handle rejection, live-only byte reopening in a separate OS process, exact binary input/EOF and confirmed exit with an explicit output gap; explicit controlling PTY, initial/changed dimensions and graceful SIGTERM exit. Setup 30s, exercise at most 240s, cleanup 60s plus client release. Borrowed prepared image; native expiry E2B 300s, Daytona 15min. No creator retries. Ordinary ledger teardown on failure and reconciliation after interruption; no retained artifacts. |
| `termination.test.ts` / `execution-termination` (E2B only) | 1 total/peak compute, zero snapshots/volumes | Ready stdout before one native SIGKILL request, repeat-call result, independently observed nonzero terminal integer and preserved exit; output/drain bounded by 20s. Setup 30s, exercise 30s, cleanup 60s plus client release, native TTL 300s. Borrowed base image, no retained artifacts/builds or creator retry. Owned ledger teardown on failure; crash custody uses ordinary reconciliation. |
| `streaming.test.ts` / `execution-streaming` (E2B only) | 1 compute, zero snapshots/volumes | Finite text arrives before exit, separate stderr, ordinary nonzero result, owned compute teardown. Setup 30s, exercise 240s, cleanup 60s, E2B native TTL 300s. Passed at `3188e33` on borrowed base with confirmed owned cleanup; future runs require separate paid authorization. |
| `sandbox.test.ts` | 1 compute | Running inspect/inventory, argv/env/cwd/stdout/stderr, shell, nonzero error, binary files, overwrite, rejected no-clobber and unchanged bytes; `lifecycle-renew` sends one 61-second request (Daytona resolves 120, E2B 61), checks the observed deadline within request-duration plus five seconds of clock tolerance, rejects above the SDK ceiling without another POST, then uses existing owned cleanup. No additional allocations; passed for Daytona and E2B at `3188e33` with confirmed owned cleanup. `lifecycle-suspend-resume` uses the same one compute, writes known bytes and starts a bounded nonce/counter process, pauses once, reopens inactive in a separate process, rejects guest access without waking, resumes once, checks unchanged identity/files, Daytona ended process versus E2B advancing correlated counter, then shared owned cleanup. Passed for Daytona at `6796b30` and E2B at `26f516d`; see the exact evidence below. `lifecycle-reopen` persists the scoped reference, closes/reconnects, reopens in a separate OS process, checks original bytes/exec and unchanged deadline, deletes owned compute and verifies absence. E2B requires a known session deadline for no-extension evidence. Owned teardown uses the existing ledger. Reopening passed for Daytona and E2B at `3188e33` with confirmed owned cleanup. |
| `snapshots.test.ts` | 3 total compute, peak 2; 1 snapshot | Native default capture/source lifecycle, exact metadata, two-way filesystem isolation, advertised RAM nonce/counter or fresh-process observations, serialized reference reopened by a separate OS process, fresh SDK connection after source deletion, second restore of original bytes, independent storage deletion. |
| `volumes.test.ts -t volume-crud` | 1 volume; no compute | Create/readiness/inspect/delete without implying mounts. |
| `volumes.test.ts` persistence | 1 shared volume; 2 compute, or 3 when read-only is advertised; peak 2 | Native mount, bounded write/flush/readback, producer destruction, independent remount/readback, and native read-only rejection plus unchanged bytes when advertised. |
| `network.test.ts` (E2B borrowed `base` only) | 2 compute | Same reachable IPv4 TCP control before and after the blocked probe; bounded measured hostname/direct IPv4 denial. No DNS/UDP/IPv6/ingress/metadata/tenant isolation claim. |

Each fixture has a 30-second setup limit, at most 240 seconds for exercise, and an independent 60-second cleanup budget plus bounded client release. Bun hooks allow the cleanup path to finish. For suspension selection, Daytona hard TTL continues while stopped (15 minutes initially; earlier selected renewal may shorten it). E2B uses 300 seconds per active session; paused state has indefinite retention, so approval must cover residual storage and explicit owned kill reconciliation after interruption. No snapshots/volumes/builds, at most one pause/resume, exercise 240 seconds and cleanup 60 seconds. Native TTL is fallback after process loss; retained snapshots and volumes need separate deletion. The pre-dispatch hook enforces creator attempt counts and peak two compute; no OCI build or creator retry is included. Test selection never suppresses teardown. Missing access fails the selected test; declared unsupported cases skip and never become passed evidence.

The new `execution-stdin` case in `live/sandbox.test.ts` reuses that suite's one owned compute and allocates no snapshots, volumes or builds. Five bounded exec calls check UTF-8 with NUL, arbitrary bytes, empty string/bytes and omitted-input EOF; the text case also checks separate stderr and nonzero exit. It requires `/bin/sh`, `cat`, writable `/tmp` and the adapter's existing capture/receipt utilities. Each command has a 10- or 20-second native deadline, within the existing 240-second exercise budget and independent owned teardown. Staged input can remain after interruption until sandbox destruction. This authored case has not run live and requires separate explicit authorization; historical execution passes do not qualify finite input.

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

### Preview access acceptance

`live/preview.test.ts` maintains `preview-protected` for Daytona and `preview-public` for E2B. It uses one owned prepared-image sandbox, zero snapshots/volumes, Python 3 for a temporary HTTP listener, setup 30 seconds, exercise 240 seconds and cleanup 60 seconds. Native fallback expiry is the existing 15-minute Daytona TTL or 300-second E2B session. Explicit paid authorization and the normal private ledger/preload remain required. E2B public exposure also requires `SANDBAR_E2B_PREVIEW_ACCESS=public`; routing saves that choice for reconciliation. This publishes HTTP ports from creation, including any image-owned services. Ordinary protected/default E2B profiles remain private and cannot run public preview acceptance.

The body checks access before listener readiness, unchanged expiry after lookup, correct content, anonymous/invalid-header denial for Daytona, reopened access, missing compute rejection and owned teardown. Python absence or proxy errors fail the case and do not become qualification. No expiry-timer or native pause/resume token assertion is claimed; those remain documentation/source evidence and deterministic unsupported-state checks. Earlier lifecycle/exec passes do not qualify the new E2B inbound protection default. Both cases passed at `3188e33` with confirmed owned cleanup and client close: Daytona protected access and E2B explicitly public access. Private-default E2B ingress denial remains unqualified.

### Directory acceptance

The `file-directories` case in `live/sandbox.test.ts` uses the suite's existing one owned sandbox (no added allocation, snapshot, volume, image build or retained artifact). E2B only: recursive mkdir/idempotence, byte IO, dangling-link existence/removal, final-link target preservation, native parent-link traversal, unsupported nonrecursive/listing requests, root refusal and missing removal. It uses `/bin/sh` and `ln` only to seed test links, with paths supplied as positional argv; SDK directory operations use native file APIs. The body keeps the existing 240-second exercise bound; teardown retains the suite's separate cleanup bound and provider-native TTL/ledger custody. Any files remaining after a body failure stay in the owned sandbox until teardown destroys it. The prepared image must supply those setup utilities; the case passed at `3188e33` on borrowed E2B base with confirmed owned cleanup and client close. Other templates/guest versions remain unqualified, and this record grants no additional paid runs. Other providers skip this unsupported case.

### Suspend/resume live evidence

On October 2, 2026, the single maintained `lifecycle-suspend-resume` case passed for Daytona at `6796b30` (Bun 1.3.14, darwin-arm64, borrowed prepared snapshot, `us`, `daytona-default`, 15-minute hard TTL). It verified inactive reopening in a separate process, no implicit guest wake, explicit stop/start with unchanged UUID/files/expiry, and terminated process state.

E2B borrowed `base` with private traffic defaults first failed at `6796b30` during guest attachment before pause. The pinned API's omitted/null domain mapping was corrected without implicit connect. One bounded confirmation at `cb39884` passed the initial file/process setup, then rejected suspension because native detail omitted mount facts. Neither run establishes an E2B lifecycle pass. The revised lifecycle mapping keeps missing mount facts unknown without blocking private filesystem/RAM preservation, rejects known native mounts and excludes external-storage durability/consistency. Bounded confirmation passed at `26f516d` with inactive fresh-process reopening, same identity/files and preserved RAM nonce/advancing counter after explicit resume. All four owned compute allocations have confirmed cleanup and client close, with zero snapshots/volumes/builds. Historical failures and the unrelated unresolved E2B volume receipt remain unchanged.


The one-sandbox `execution-termination` run at `4cc6a20` failed before process start with read-only E2B guest attachment unavailable. No termination was dispatched and kill/exit remains unqualified. Its owned compute cleanup and SDK close are confirmed; the failed record is retained. A later independently bounded run after the default-domain routing correction is a new acceptance run, not replay of an uncertain mutation.


The newly authorized one-sandbox `execution-termination` case passed at clean `131a8c6` after applying the shared fixed-default E2B routing patch. It observed ready stdout, an acknowledged request/repeated-call outcome and an independent nonzero terminal integer, with bounded drain, preserved exit, owned compute cleanup and SDK close. Configuration: borrowed `base`, API-key scope, native default region, requested blocked network, pinned `e2b 2.51.0`, Bun 1.3.14 on darwin-arm64; zero snapshots/volumes/builds. This does not qualify every image/platform or eliminate PID/descendant/lifecycle races. The failed `4cc6a20` record is unchanged. Both runs' private JUnit/logs and owner-only custody remain outside the checkout.

### Storage composition startup fixture and acceptance

`live/storage-composition.test.ts -t storage-composition` is the accepted bounded first-action scenario. The first authorized run at `824946d` passed A's first-action selected marker/data, private state and correlated current-start checks, then failed a harness assertion that expected the captured snapshot ID where native sandbox detail reports its name. The server explicitly assigns `sandbox.snapshot = snapshot.name`; the harness now resolves that name in the verified organization and compares the exact saved ID. B was not reached, so this is a failed workflow, not a full live pass. All three compute allocations, two volumes and the captured snapshot from that run have confirmed cleanup and SDK close. Its temporary imported fixture was also deleted with exact-ID absence confirmed. After explicit user authorization to complete testing, the corrected full workflow passed at `5911ccc` on Bun 1.3.14, darwin-arm64, `us`, `daytona-default` and the same digest-pinned first-action image. A read the selected shared data; B verified the independently empty selected volume. Both retained private `v1`, had fresh current-start nonces, exact native mounts/snapshot identity and fresh-client reopening. All four compute allocations, both volumes and the captured snapshot have confirmed cleanup and SDK close; the reimported fixture was deleted after dependencies cleared, with exact-ID absence confirmed. The original failure remains recorded. No resources from either run remain allocated. Read-only metadata on October 2 found 13 available snapshots; the active `us` container candidates `daytona-small` (1 vCPU, 1 GiB RAM, 3 GiB disk), `daytona-medium` (2/4/8), and `daytonaio/sandbox:0.9.0` had null snapshot entrypoints. Their metadata does not establish a first-action sentinel. Raw account/resource metadata is private, outside the checkout.

The concrete preparation proposal is **one native registry-image import**, using `POST https://app.daytona.io/api/snapshots`, with no Dockerfile, context upload, `buildInfo`, dependency installation or sandbox creation. The [native SDK mapping](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/libs/sdk-typescript/src/Snapshot.ts#L156) maps a registry string to `imageName` plus `entrypoint`, and the [snapshot DTO](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/api/src/sandbox/dto/create-snapshot.dto.ts) accepts that argument array. Construct this exact body offline; `sentinel` is the complete UTF-8 contents of `live/fixtures/storage-sentinel.py`, not a filename or a post-create command:

```ts
const request = {
  name: "sandbar-storage-first-action-20261002-b3cdebe",
  imageName: "daytonaio/sandbox@sha256:530d00afaeda76bf860d1eecf83f1027fd2ee8a137d9c99a31453279f635c413",
  regionId: "us",
  sandboxClass: "container",
  cpu: 1,
  memory: 1,
  disk: 3,
  gpu: 0,
  entrypoint: ["python3", "-c", sentinel],
};
```

Public registry metadata read October 2 pins the Linux/amd64 image manifest above. The corresponding `0.9.0` multi-platform index is `sha256:bf6394ea1fb0504886ec14efe1e00fedd0fd2c1a9cf05b2976a0487425cdee54`; its amd64 manifest body digest was verified against the registry header. Exact index, image-manifest and config response bytes are retained privately as `sandbar-storage-base-{index,manifest,config}.raw.json`, each checked against its OCI digest; reserialized diagnostic JSON is not digest evidence. The image config records Python 3.14.6 and includes `/usr/local/python/current/bin` on PATH, with Python installation in build history. Only manifests/config were downloaded, no layers or container execution. Compressed base layers total 7,355,807,775 bytes (about 6.85 GiB). The sentinel is exactly 2,594 bytes with SHA-256 `69a955624a816ed8a9c20cb90f20a98d2f3063e9649b99810abb37480afabb3f`. The proposed JSON request was generated offline as a private review artifact; its SHA-256 is `1b362efbf8089c119254244bbd8e709d9d76eda5775465d06362f11eb2440098`. The user approved this exact import, and the acknowledged fixture was active with the exact entrypoint, 1/1/3 defaults, `us`, and reported size below 8 GiB. Its native identity and preparation receipt remain private.

Startup has a concrete inspected path at runner/daemon commit `01c502bb1f1ff8f2885d0cd490e043736083dca8`: [container configuration](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/runner/pkg/docker/container_configs.go#L128) places the supplied entrypoint in the native daemon's command arguments. [Daemon startup](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/daemon/cmd/daemon/main.go#L130) launches those arguments in its asynchronous entrypoint session and starts Toolbox independently, so `signal.pause()` keeps the Python child idle without blocking inspection on bootstrap or failure. [Capture](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/runner/pkg/docker/snapshot_sandbox.go#L47) commits container state and reports the committed entrypoint/command; the subsequent container configuration reuses `Config.Cmd` when the committed image entrypoint is already the daemon. This supports the proposed preservation route but does not establish the deployed backend or a live pass. The maintained two-restore test must confirm this exact startup path; there is no extra probing sandbox.

The sentinel clears inherited report/start markers, generates a per-start UUID, and checks `/data/.sentinel-id`, the SHA-256 or absence of `/data/report.json`, and `/tmp/app-version.txt` once. Its private config is `/tmp/sandbar-storage-config.json`; absent config leaves bootstrap idle. It atomically publishes the correlated `/tmp/sandbar-storage-started.json` only on success and atomically publishes `/tmp/sandbar-storage-report.json` last. The harness waits at most five seconds/20 reads only while that report is missing, then treats the first available bytes as final evidence. Wrong, failed, malformed or stale reports are never retried. It neither waits for mounts nor reruns the sentinel. The harness matches the exact selected A/B marker/hash profile and current native ID, run ID and fresh nonce. Post-create exec cannot qualify first action.

**Requested amendment:** authorize exactly the single import above and its one additional owned prepared-snapshot artifact, with a ten-minute preparation observation deadline (individual HTTP reads at most 30 seconds), then the already bounded live run and deletion of this fixture within that run's 20-minute cleanup budget. Preflight the exact name as absent; save the request hash, organization/region and acknowledged native ID immediately in owner-only private custody before polling. Never retry POST or allocate a replacement on uncertainty; reconcile by exact name/ID read-only. Confirm active/container/us, exact entrypoint and 1/1/3 defaults, and a reported image size no greater than 8 GiB before any test compute. On mismatch, failure or preparation timeout, stop and delete only this confirmed owned fixture, with at most two minutes of read-only deletion verification; unknown ownership or deletion remains explicitly retained/uncertain. Delete after the live run only once all known test compute and captured-snapshot dependencies are clear, check no warm pools, and confirm exact-ID absence. Never delete the public registry base or any borrowed account image. No persistent fixture retention is requested.

This import consumes **zero of the four sandbox allocations**: [create-from-pull](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/api/src/sandbox/services/snapshot.service.ts#L162) creates a snapshot record, and the [runner pull path](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/runner/pkg/docker/snapshot_pull.go#L16) pulls/tags the registry image without a container build/create. Provider-managed pull work is not a Sandbar compute allocation. The 1/1/3 fields are resulting sandbox defaults, not an enforceable quota on provider workers. Peak owned snapshots become two during the test: this new fixture plus the captured private-state snapshot. The existing two volumes/four compute/no-build limits stay intact. A client timeout does not cancel native import; any late identity or uncertain cleanup stays in private custody for reconciliation. Preparation plus live run has a proposed 30-minute wall-clock observation envelope, or 12 minutes for failed preparation plus its cleanup. The user approved the original preparation and subsequently authorized the corrected live test, including necessary preparation and cleanup. Each run used one import without automatic creator retries; both imported fixtures have confirmed deletion.

Cost sizing, checked October 2: [published rates](https://www.daytona.io/pricing) are $0.0504/vCPU-hour, $0.0162/GiB RAM-hour and $0.000108/GiB storage-hour (storage after the first 5 free GiB). A 1/1/3 runtime is about $0.066924/hour before credits. With four 1/1/3 compute instances each at ten-minute TTL, the conservative compute-only ceiling is about $0.044616, excluding independently retained snapshot/volume charges. No separate native import tariff or account-specific storage credits were established; this compute-only figure does not cap total preparation/retention charges. The already accepted run caps remain four compute total, peak one in the maintained sequence (shared harness ceiling two), two volumes with less than 1 MiB each, one captured snapshot, no builds and at most 20 minutes including cleanup. The existing test's exercise is 240 seconds and cleanup 60 seconds.

For a supplied qualified image, use the existing private persistent ledger/preload. Set `SANDBAR_STORAGE_COMPOSITION=1`, `SANDBAR_QUAL_PROVIDER=daytona`, `SANDBAR_DAYTONA_TARGET=us`, `SANDBAR_DAYTONA_NETWORK_POLICY=daytona-default`, and `SANDBAR_DAYTONA_SNAPSHOT_ID` to that image. `SANDBAR_STORAGE_FIXTURE` is JSON with its exact `imageId`, `firstActionSentinel: true`, **confirmed native defaults** `vcpu`, `memoryMiB`, `diskMiB`. Those size fields attest inspected defaults; they do not resize compute. Setup rejects missing/mismatched prerequisites before allocating. The profile saves ten-minute TTL and `restartAfterCapture: false` for later reconciliation. Select only this case:

```sh
bun test --preload ./packages/sdk-qualification/live/preload.ts \
  packages/sdk-qualification/live/storage-composition.test.ts -t storage-composition \
  --reporter=junit --reporter-outfile="$SANDBAR_LIVE_REPORT_DIR/junit.xml"
```

The test seeds two explicit volumes, captures a separate mount-free source, saves full references, destroys source/seeder, reconnects, restores A then B, reads their first-action reports, checks exact native mounts/snapshot/policy and fresh-client sandbox reopen, then performs known owned cleanup through the existing ledger. Reports remain private; wrong/missing/stale observations and cleanup failure remain failed evidence. Prior uncertainty never triggers replacement allocations. `blocked` remains unsupported for mounted restore; this `daytona-default` acceptance tests selected storage and current-start correlation, not strict network isolation.

### Filesystem artifact acceptance

The expanded `file-directories` case runs the same compiled `artifactFiles` recipe for Daytona and E2B: recursive-opt-in mkdir/remove, complete directory/link browsing, metadata, regular-file copy, same-filesystem move, no-clobber refusal and one 32 MiB byte stream verified by SHA-256. It reuses one owned private-filesystem sandbox and creates no snapshots, volumes or builds. The existing 30-second setup, 240-second exercise and 60-second cleanup budgets apply. Compatible Linux/Python 3 images are required; E2B stream upload additionally needs envd >=0.5.7, and no-clobber native move needs Linux renameat2.

Both providers passed at `2f6afe8` on October 8, 2026 (Bun 1.3.14/darwin-arm64), with confirmed owned sandbox destruction and client close: Daytona borrowed container in us with daytona-default, and E2B borrowed base. Earlier Daytona mkdir rejection failures at `cd89f31` and `6d7ddc7` retain failed workflow results and confirmed cleanup; a stale borrowed-image attempt failed before allocation and has no passed evidence. Three Daytona compute allocations and one E2B allocation were destroyed; no retained resources were allocated. The original E2B volume custody was unchanged. These completed runs authorize no future paid reruns.


The current shared artifact recipe also walks its nested outputs and reads UTF-8 text lines. Deterministic and packed fixtures split the UTF-8 code point and CRLF across byte chunks. Historical `2f6afe8` passes used the earlier recipe and do not qualify the F4 additions; a fresh authorized run must verify traversal/line results and owned cleanup before recording F4 live evidence.

F4 qualification at `e91f2d5` ran that same compiled recipe once per provider, adding nested `walkFiles` results and Unicode/CRLF `readTextLines` assertions while retaining the 32 MiB SHA-256 transfer. Daytona borrowed Linux/us/daytona-default and E2B borrowed base passed on Bun 1.3.14/darwin-arm64. Two total compute allocations, peak one, zero snapshots/volumes/builds; both sandbox destructions and client closes were confirmed. Prior evidence remains unchanged; other configurations are unqualified.

### Sustained process acceptance

`live/interactive-processes.test.ts` uses one owned prepared-image sandbox per provider, peak one, zero snapshots, volumes or builds. It runs the compiled provider-neutral build/worker recipes: over 32 MiB stdout plus separate stderr, incremental UTF-8 and exact binary stdin including NUL/invalid UTF-8, explicit EOF, status, termination and confirmed wait. Python 3 is required. Setup is bounded to 90 seconds, each exercise to 240 seconds and cleanup to 60 seconds; existing native compute expiry and private durable custody apply. This suite does not expose a preview port. Run only through the ordinary live preload and provider admission lock. Fixture/packed passes do not qualify native deployment. The suite is not run merely by adding it; record selected revision/configuration and confirmed owned cleanup before claiming a live pass.

At `ecc73de`, the sustained process suite passed on Daytona borrowed Linux/us/daytona-default and E2B borrowed base (Bun 1.3.14/darwin-arm64). It verified the shared compiled >32 MiB build and exact text/binary incremental input/EOF recipes, running/exited status, termination acknowledgement and independent exit. Both owned sandboxes were destroyed and clients closed. The initial E2B streaming case at `37dd9c2` failed on coalesced-frame queue overflow while termination passed; its sandbox destruction/client close were also confirmed. The bounded scheduling fix and deterministic regressions precede the successful requalification. Three total compute allocations, peak one, zero snapshots, volumes or builds; no preview ports were exposed. Historical failures remain recorded, and the original unrelated E2B volume custody is unchanged. No further paid resources are needed for this implementation.
