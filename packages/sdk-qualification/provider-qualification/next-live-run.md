# Proposed feature acceptance run — awaiting authorization

No live calls are authorized. This proposal selects existing ordinary Bun cases,
with no new runner, retry, build-image workflow, snapshots or volumes. Use the
final reviewed clean commit of this PR, Bun 1.3.14 and its frozen lockfile. Record
that exact commit and native versions from the preload; do not call historical
passes current-head qualification. PR #57 suspend/resume acceptance is separate.

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
  E2B streaming needs `/bin/bash`; directories additionally need `ln`. File roots are Daytona `/tmp` and
  E2B `/home/user`. Confirm default image resource sizes and account billing
  rates before assigning a dollar ceiling. No image build is included.

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
Actual cost depends on the borrowed image shape, provider rounding/minimums and
account rates; dollar cost is not yet estimable from repository evidence. Obtain
an explicit dollar cap using those rates before approval. Successful cleanup
should substantially reduce this fallback exposure.

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
