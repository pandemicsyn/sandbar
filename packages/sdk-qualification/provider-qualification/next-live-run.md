# Completed approved feature acceptance run

This records the user-approved five-fixture run and its original bounds, using
existing ordinary Bun cases with no new runner, retries, builds, snapshots or
volumes. Completion grants no additional live runs. The tested clean revision
and native versions are recorded below; historical passes retain their source
provenance. Reconciled against merged main `0a022a8`;
suspend/resume and termination already have separate dated live evidence and
are not selected by this plan.

## Prerequisites and configuration

- Use the existing owner-only persistent ledger directory and shared admission
  lock. Reconcile pending compute/snapshot custody first. The original E2B
  volume-only unknown receipt stays unchanged; admission must verify it permits
  a zero-volume budget. Never replace the ledger directory to bypass custody.
- Inject credentials privately or use owner-only `~/.config/sandbar.env`.
  Unset `CI` and `SANDBAR_QUAL_PROFILE`. Use the same verified account/team as the
  saved routing. Never print credentials, resource IDs, tokens or references.
- Daytona: `SANDBAR_QUAL_PROVIDER=daytona`, `SANDBAR_DAYTONA_TARGET=us`,
  `SANDBAR_DAYTONA_NETWORK_POLICY=daytona-default`, and
  `SANDBAR_DAYTONA_SNAPSHOT_ID` set to the existing borrowed active Linux
  snapshot. Its actual ID is a private approval prerequisite. Native TTL is
  15 minutes; configured creation environment is that snapshot.
- E2B: `SANDBAR_QUAL_PROVIDER=e2b`, `SANDBAR_E2B_TEMPLATE_ID=base`, native default
  region, API-key authority (unset `SANDBAR_E2B_TEAM_ID` unless the approved
  account requires the saved verified team). Native timeout is 300 seconds;
  outbound `blocked` remains only a requested setting. Unset
  `SANDBAR_E2B_PREVIEW_ACCESS` for sandbox/streaming; set it to `public` only for
  preview. This exposes all guest HTTP ports, including image-owned listeners.
- Borrowed images must contain `/bin/sh`, GNU no-clobber utilities and Python 3;
  E2B streaming needs `/bin/bash`; directories additionally need `ln`. File
  roots are Daytona `/tmp` and E2B `/home/user`. No image build is included.
  Read-only preflight on October 2 verified the borrowed Daytona image is
  active in `us` with 1 vCPU, 1 GiB RAM and 3 GiB disk. Zero-storage admission
  cleared for both providers; admission is rechecked before every run.

## Selected invocations and budget

Run sequentially, with a fresh private report directory per invocation. Each
fixture enforces 30 seconds for setup, 240 seconds total exercise, independent
60-second cleanup and 15-second client release. Budget 345 seconds per
invocation after preload, at most 28 minutes 45 seconds for all five. Package
build time is additional local time. Do not kill a running fixture to enforce a
wall-clock limit; allow teardown. Bun hook timeouts are outer bounds, not extra
exercise budget.

| Provider / invocation | Cases                                          | Total / peak compute | Purpose                                                                                                                                                                 |
| --------------------- | ---------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daytona sandbox       | `files`, `lifecycle-renew`, `lifecycle-reopen` | 1 / 1                | Configured environment creation, signal-bearing binary read and pre-aborted rejection, renewal, separate-process scoped reopen and unchanged deadline, deletion/absence |
| E2B sandbox           | Above plus `file-directories`                  | 1 / 1                | Configured template creation, home file reads, native recursive/link directory semantics, renewal and scoped reopen                                                     |
| Daytona preview       | `preview-protected`                            | 1 / 1                | Access before readiness, valid content, anonymous/invalid-header denial, unchanged expiry, reopened access, missing-resource rejection                                  |
| E2B streaming         | `execution-streaming`                          | 1 / 1                | stdout before exit, separate stderr, exit 7, repeat wait, detach and owned deletion                                                                                     |
| E2B public preview    | `preview-public`                               | 1 / 1                | Explicit public creation, content, unchanged expiry, reopened access and missing-resource rejection                                                                     |

Maximum: five total compute creations, peak one, zero snapshots/volumes or
retained images. No creator retries. Native fallback compute billing exposure
is at most 30 sandbox-minutes for Daytona and 15.6 for E2B: renewal can reset the
E2B sandbox deadline to 61 seconds near the end of the 270-second setup/exercise
window (331 seconds), while its other two sessions expire at 300 seconds.
Daytona renewal to 120 seconds does not exceed the initial 900-second fallback.
At October 2 published usage rates, the verified Daytona shape costs about
$0.0333 for that fallback exposure. E2B advertises default 2 vCPU / 4 GiB at
$0.000046/second, giving about $0.0429 for 931 seconds: about $0.077 combined.
These are marginal usage estimates, excluding existing plan fees, account-specific
rates and tax. Verify the E2B template shape before treating this as a hard dollar
ceiling. Successful cleanup should reduce this fallback exposure. Sources:
[Daytona pricing](https://www.daytona.io/pricing) and
[E2B pricing](https://e2b.dev/pricing).

## Executable selection after approval

The operator must export the approved private `SANDBAR_QUAL_LEDGER_DIR` and
provider variables above. Create each report directory with mode 0700 outside
the checkout. Set `SANDBAR_LIVE_REPORT_DIR` to it before each invocation. Only
after approval set `SANDBAR_LIVE=1` and `SANDBAR_QUAL_LIVE_AUTHORIZED=yes`.

For each provider's sandbox invocation:

```sh
bun test --preload ./packages/sdk-qualification/live/preload.ts \
  packages/sdk-qualification/live/sandbox.test.ts \
  -t '(files|file-directories|lifecycle-renew|lifecycle-reopen)$' \
  --reporter=junit --reporter-outfile="$SANDBAR_LIVE_REPORT_DIR/junit.xml"
```

Daytona's unsupported directory case skips before effects. Existing test order
runs renewal before reopening; a deadline failure remains a failure, not a
reason to allocate again. The baseline lifecycle/exec cases are deliberately
not selected again. File success does not prove cancellation during a native
read or private E2B ingress denial; those retain deterministic/source evidence.

For the E2B streaming invocation:

```sh
bun test --preload ./packages/sdk-qualification/live/preload.ts \
  packages/sdk-qualification/live/streaming.test.ts -t 'execution-streaming$' \
  --reporter=junit --reporter-outfile="$SANDBAR_LIVE_REPORT_DIR/junit.xml"
```

For each provider's preview invocation (E2B public setting required):

```sh
bun test --preload ./packages/sdk-qualification/live/preload.ts \
  packages/sdk-qualification/live/preview.test.ts -t 'preview-(protected|public)$' \
  --reporter=junit --reporter-outfile="$SANDBAR_LIVE_REPORT_DIR/junit.xml"
```

Save each actual Bun exit status, private JUnit/context and cleanup receipts.
Import with the README's offline JUnit importer, review sanitized records and
append only approved evidence to the maintained results source. Regenerate the
support pages; fixture passes never qualify live rows.

## Cleanup ownership and the network decision

The operator owns cleanup for every acknowledged or uncertain creator. Bun
hooks persist references before effects and destroy owned compute on failure;
borrowed snapshots/templates are never deletion targets. On interruption,
observe pending custody with `live/reconcile.ts <run-UUID>` using the same
ledger/current key/saved routing. Do not replay creators or deletes. After
SIGKILL, verify the recorded host/PID stopped before clearing a stale lock.
Unresolved cleanup or client close makes the run unsuccessful and blocks later
applicable allocations. Native TTL is fallback, not a cleanup receipt.

The stored 431cdaa Bun log confirms both internet positive controls succeeded;
the blocked hostname probe failed DNS while direct IPv4 TCP to 1.1.1.1:443
connected. The earlier 8449def run had `OUTCOME_UNKNOWN`, not a passing denial.
Pinned native mapping forwards `allowInternetAccess: false`, and the probe
isolates DNS in a bounded subprocess before direct IPv4 connection. These
facts do not identify the provider-side cause or establish isolation. Preserve
both failed records and the original unknown volume receipt.

No network rerun is proposed without new provider/configuration evidence. A
separately approved diagnostic would select only `network.test.ts`, allocate at
most two E2B `base` compute instances (peak two, no storage), retain the paired
before/blocked/after controls and use the same bounds/custody. Native fallback
exposure would add at most ten sandbox-minutes. Provider clarification or a
verifiable changed native control is the prerequisite; another allocation with
the unchanged mapping is not a repair.

## Merged dependencies and remaining gaps

Main `0a022a8` includes #65's fixed-default E2B guest routing, #66's process
termination and #57's suspend/resume. The omitted/null-domain attachment blocker
is resolved; missing mount metadata no longer blocks private E2B state capture,
while known native mounts remain unsupported. Keep their separate source rows,
actual passed/failed results and cleanup evidence unchanged. The earlier gate
failures remain historical evidence, not outcomes of these selected cases.

This plan still selects only configured-environment creation, signal-bearing
binary reads, renewal, scoped reopening, E2B directories, finite streaming and
the supported preview modes. Do not add termination or suspend/resume reruns,
network retries or retained storage. Fresh admission and intended routing must
be verified at dispatch; the earlier read-only preflight is not a future lock
or resource-readiness guarantee. The user authorized PR publication and these
five sequential fixtures, requiring cleanup on failure. API review checked the
pinned E2B 2.51.0 client and official Daytona control/toolbox schemas before
dispatch. Acknowledged deletion still requires an absence observation; renewal
resets the deadline relative to the request. Known saved Daytona routing with
10-minute TTL and `restartAfterCapture` remains readable without changing this
plan's 15-minute TTL or weakening unresolved-custody admission.

## Completed approved run

On 2026-10-02, clean source `3188e33327325d4eec22e39f4b627d7f900c8838`
ran the five ordinary Bun invocations above sequentially. All ten selected
workflow cases passed: Daytona files/renew/reopen/protected preview; E2B
files/directories/renew/reopen/finite streaming/public preview. Each invocation
exited zero with confirmed owned compute cleanup and successful client close.
Five compute creations, peak one, no retries, snapshots, volumes or builds.
The three original unresolved E2B volume receipts remain byte-for-byte unchanged.
Private JUnit/context and persistent recovery receipts remain in the existing
owner-only storage; only reviewed selected records were appended to results.
Skipped lifecycle/execution/suspend cases did not acquire new pass claims.

This is bounded by allocation counts and setup/exercise/cleanup deadlines;
provider TTL is an additional fallback. The earlier admission refusals created
no resources. Known saved-routing compatibility fixes receipt reading only;
pending legacy TTL10 cleanup still requires its compatible owning configuration.
The API review found no selected-path mismatch; deployed guest behavior is
qualified only by these recorded source/configuration-specific observations.
