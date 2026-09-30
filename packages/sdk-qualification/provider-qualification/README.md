# Provider qualification

The built-in profiles are **Daytona and E2B**; external adapters supply a small profile to the same runner. Prepared profiles exercise the public SDK with finite native lifetimes and owned cleanup. Keep one reviewed qualification summary per provider in `results/daytona.json` and `results/e2b.json`; detailed run diagnostics and cleanup ledgers stay private outside the repository. The September 28 merged-source reruns passed all 13 baseline scenarios for both providers with confirmed cleanup: E2B public `base` in `/home/user`, and Daytona `daytona-small` in `us` with explicit `daytona-default`. Earlier E2B sticky-`/tmp` failure and Daytona strict-blocked unsupported results remain recorded for their original configurations. OCI builds and network probes were not run.

## When to run

Run live acceptance tests when adding a provider or changing a fundamental public guarantee. Routine changes use offline fixtures and packed checks. The repository skill in `.agents/skills/qualify-provider/SKILL.md` explains scenario selection, extending coverage and certifying docs evidence. Runs are manual and require explicit authorization for their specific resource budget. Do not schedule routine paid CI runs.

The common lifecycle covers connect, one borrowed prepared-image create, inspect, argv and shell commands with cwd/env and stdout/stderr, nonzero exit, binary file write/read/overwrite, no-clobber conflict, inventory, destroy confirmation and close. Unsupported operations are recorded as `unsupported`, never passed. OCI/image-build is separately blocked until ownership and deletion of every retained artifact are proven; sandbox TTL does not expire retained storage.

## Credentials and profile gates

The manual entrypoint reads `~/.config/sandbar.env` (override with `SANDBAR_CREDENTIALS_FILE`). The file must belong to the current user and have owner-only permissions (`chmod 600 ~/.config/sandbar.env`). It imports only Daytona/E2B API keys, accepts `DAYTONA_API_KEY` or `SANDBAR_DAYTONA_API_KEY` and `E2B_API_KEY` or `SANDBAR_E2B_API_KEY`, and preserves injected environment values. It never imports live-enable flags. Offline tests use synthetic credentials and never load the operator file.

The local E2B profile creates at most one sandbox from an existing borrowed template (the public `base` template by default). Native timeout is fixed at 300 seconds, exercise waits are aborted after 240 seconds, and cleanup has a separate 60-second budget. No image builds occur and the borrowed template is never deleted. Before approving a live run, review native pricing/account limits and the template's prerequisites; lifetime is not a dollar ceiling. Approval must cover the exact resource budget. A credential file or enable flag does not grant authorization.

Create a stable owner-only ledger directory outside the repository and temporary storage. Live preflight checks run before secret loading and connection: selected provider, explicit run-enable flag, local-only execution, clean exact SDK commit, routing, valid scenario dependencies and safe evidence reference.

After separate approval, export `SANDBAR_QUAL_EVIDENCE_REF` with a real, resolvable evidence artifact or review reference prepared for this run. Verify the target first; do not substitute an invented run URL. Then the prepared E2B command is:

```sh
SANDBAR_QUAL_PROVIDER=e2b \
SANDBAR_QUAL_LIVE_AUTHORIZED=yes \
SANDBAR_QUAL_LEDGER_DIR=/absolute/stable/private/qualification-ledgers \
SANDBAR_QUAL_EVIDENCE_REF="${SANDBAR_QUAL_EVIDENCE_REF:?Set a resolvable evidence reference first}" \
bun packages/sdk-qualification/provider-qualification/manual.ts live-prepared
```

`SANDBAR_QUAL_SCENARIOS` optionally selects comma-separated `inspect,exec-argv,exec-shell,exec-nonzero,file-binary,file-overwrite,file-no-clobber,inventory`. Connect, one create, teardown confirmation and close always run; unselected rows are not-run. File overwrite requires file-binary; no-clobber requires both earlier file scenarios. If a prerequisite fails, its dependent scenario is blocked without another write. E2B requests blocked internet and uses the provider's default region. This profile does not probe egress and does not certify network isolation; records use `blocked-requested`.

Cleanup after interruption needs only the saved run UUID/private routing and the same valid API key. In the default authenticated API-key scope, rotating the key changes recovery authority; an API-key ID cannot replace the original credential. It does not require the live-enable flag, clean checkout, template/team environment variables or public evidence reference:

```sh
SANDBAR_QUAL_PROVIDER=e2b \
SANDBAR_QUAL_LEDGER_DIR=/absolute/stable/private/qualification-ledgers \
bun packages/sdk-qualification/provider-qualification/manual.ts reconcile RUN_UUID
```

Without `SANDBAR_QUAL_EVIDENCE_REF`, cleanup updates only the private ledger. With a reference and verified clean source provenance, it writes a new sanitized report preserving original dated scenarios and separate SDK/harness revisions. Dirty or unverified checkouts suppress the public report while continuing private cleanup. CI live runs remain blocked without an off-runner checkpoint that acknowledges intent/reference before dispatch and an independent janitor; final artifact upload is insufficient.

## Ownership and recovery

`runPrepared` and `reconcile` use the public SDK. The private ledger stores the run UUID, borrowed-image classification, nonsecret routing and create intent. The awaited SDK `onReference` callback journals scoped create, exec, write and destroy references before dispatch. Checkpoint failure prevents the mutation. Returned sandbox identity is saved promptly. Borrowed images are never deletion targets.

On completion, failure or interruption, the lifecycle attempts owned-sandbox teardown. Confirmed cleanup requires a correlated public SDK `computeStopped` completion or scoped inspect state `destroyed`. Unknown state, uncorrelated absence and mere acknowledgement do not confirm cleanup. An absent durable pre-submit create reference proves that this harness dispatched no create; cleanup is `not-required`. Unknown submitted creates are observed without resubmission; a saved destroy is observed without another destroy. E2B confirms termination with its scoped destroy result; stopped/absent inspect state alone is unknown. SDK-exposed pending recovery tokens are checkpointed, including on cleanup timeout. If cancellation loses a token before the SDK exposes it, leave the outcome unresolved rather than inventing evidence or replaying a mutation. Unresolved resources remain private, durable and actionable. Never use account-wide name matching or create another sandbox to resolve uncertainty.

## Failure diagnostics

A failed scenario captures its stage, timestamp and elapsed time before teardown. File failures distinguish write, read and byte comparison; the tiny binary fixture records expected/write bytes and lengths, and actual bytes/length when a read completed. After an overwrite write exception, the harness attempts one public read of its owned fixture with a five-second wait bound. It preserves the write exception and stage even if that diagnostic read fails. An unexpected no-clobber write error also attempts one bounded owned-fixture read, recording the expected preserved bytes and actual bytes without replay. A failed no-clobber diagnostic read is logged separately and retained as `readbackError` on the original write diagnostic. E2B write recovery now retains an allowlisted native error class, connection/upload/link stage and HTTP status when available; readback failures include that classification plus expected/actual lengths, truncation and digest-match facts. Command mismatches record bounded expected/actual stdout and stderr, exit code and truncation. Inspect and inventory failures retain state or bounded page/item counts. Cleanup and connection-release failures are captured separately, preserving the original exercise failure. Interrupted connection setup joins late release for up to five seconds; failure or timeout produces a close failure record, and a later release still journals its diagnostic. Failed prerequisites keep dependent scenarios blocked.

Diagnostics are appended to the durable private ledger and emitted as structured `qualification-failure` console records. `persisted: false` identifies a diagnostic checkpoint failure; the sanitized console record still retains the original failure. Private sanitized run reports include each scenario's diagnostic; committed provider summaries omit those diagnostic fields. Error name, code, message and up to two causes are retained; known credentials, native IDs, recovery tokens and auth fields are replaced with placeholders. No raw error serialization, stacks, response bodies or native logs are published. Text is capped at 1024 characters and byte previews at 32 bytes, with original lengths and truncation flags. Review sanitized artifacts before committing them.

The E2B profile makes a 5-second, 64-KiB, owned-sandbox-only public info read that rejects redirects after create to collect deployed `envdVersion`. Records distinguish `available`, `unavailable` (with a sanitized lookup error when present), and `not-collected`. A missing version does not mask the exercise result or prevent teardown. Offline tests inject the info response; they never contact E2B. Historical evidence lacking these fields stays unchanged: new instrumentation does not recover bytes or errors from an earlier run. A diagnostic live rerun requires fresh authorization.

## Evidence and offline checks

Exercise and reconciliation hold an exclusive per-run lock across all mutations. A second process fails before mutations. A killed process can leave `<run UUID>.json.lock`; inspect its private host/PID metadata and prove that process has stopped before manually removing only that lock and resuming cleanup. Never remove a lock held by an active process. The recovery ledger remains intact; stale locks are never stolen automatically.

Publish only intentionally selected summary records in `results/daytona.json` or `results/e2b.json`, updating the existing provider file. Include scenario status, exact SDK/harness source revisions, versions, timestamp, configuration and cleanup status. Review the summary before committing it; omit diagnostic error text, byte dumps and native responses. Keep debugging runs and private cleanup receipts outside the repository. Earlier published results remain in Git history.

The normal docs build reads only committed JSON and never contacts providers. The generated page uses live evidence only. A newer failure supersedes an older pass for the same configuration. Scenario successes with incomplete cleanup remain incomplete. Missing credentials or approval means not-run. The current E2B records preserve the earlier overwrite failure and dependent no-clobber blockage alongside the passing `/home/user` baseline; they do not establish arbitrary-path support.

```sh
bun test packages/sdk-qualification/provider-qualification
bun run --cwd packages/sdk-qualification check
bun packages/sdk-qualification/provider-qualification/render.ts
bun packages/sdk-qualification/provider-qualification/render.ts --check
```

`SANDBAR_E2B_TEAM_ID` optionally selects the shipped verified-team mode; `SANDBAR_E2B_TEMPLATE_ID` optionally selects a native validated borrowed template. Neither is needed for the API-key-only `base` profile. `E2B_API_ID` is not used.

Before a later authorized live run, qualify the selected profiles through relevant offline fixtures and packed consumers on that exact commit. The existing partial provider live scripts do not supply this acceptance record.

The live gate requires a clean exact source commit, defaulting to `HEAD`. `SANDBAR_QUAL_SDK_REF` may name another commit only when SDK/adapter/provider sources and dependency pins match it exactly; SDK and harness revisions remain separate. Branch and merged revisions use the same workflows and report. The launcher builds shared packages sequentially (providers before SDK) before importing any SDK-dependent module. A failed build stops the run instead of loading stale bundles. Cleanup reconciliation remains available without clean-source verification; unverified cleanup suppresses public reports.


## E2B file workspace

The default E2B baseline uses `/home/user`, matching the [documented default user/workdir](https://docs.e2b.dev/template/user-and-workdir) and [upload example](https://docs.e2b.dev/quickstart/upload-download-files). `SANDBAR_QUAL_FILE_ROOT` may explicitly select `/home/user` or `/tmp`; custom templates require an appropriate confirmed workdir. The private ledger and public configuration retain the selected file root. File evidence groups by root so a home-directory pass cannot supersede a `/tmp` failure. Historical records lacking this field remain unchanged and display “not recorded”; their handoffs retain the original `/tmp` path. The earlier native sticky-directory limitation remains documented. This is a test-workspace correction, not a provider write workaround or broader overwrite claim.


## Network enforcement profile

`manual.ts live-network` is a separate opt-in E2B profile. It creates **at most two sandboxes**, each with a **300-second native lifetime**, with at most two running concurrently. It uses the borrowed `base` template and creates no images, volumes or snapshots. The overall exercise budget is 240 seconds; each sandbox gets up to 60 seconds for owned teardown. The two independent private ledgers point to each other, and a shared admission lock serializes exercise and reconciliation. Running the existing `reconcile RUN_UUID` command for either ledger reconciles both; it never replays a create or uncertain destroy. After a crash, prove the recorded host/PID process has stopped before removing its stale `<run UUID>.json.lock` and `.admission.lock`. The latter serializes every run in the ledger directory and must also be cleared before either ledger can reconcile. Single-sandbox manual runs use the same directory-level `.admission.lock` with the same verification rule. Pair-level cleanup is confirmed when every created resource is confirmed stopped, even if the other ledger required no create; choosing either UUID cannot change that result. If a crash occurs before the first sanitized public report is saved, reconciliation publishes cleanup evidence only: probe observations remain durably available in both private ledgers, and network rows stay not-run. It cannot reconstruct original run certification/provenance from those observations alone. An existing public report retains its dated network evidence while cleanup is reconciled.

Use the same credential, clean source provenance, ledger-directory, evidence-reference and explicit authorization settings as `live-prepared`, replacing the action with `live-network`. Authorization must specifically cover this two-sandbox budget. This profile cannot run in ordinary CI. Python 3 and DNS resolution are prerequisites for the selected template.

The public SDK creates one sandbox with `networkPolicy: "internet"`. Its probe attempts IPv4 TCP connections to `one.one.one.one:443` and `1.1.1.1:443`. After both connect, a second sandbox created through the public SDK with `networkPolicy: "blocked"` attempts the same connections. The original internet sandbox then repeats both connections before either resource is terminated. `network-internet` and `network-blocked` records retain all three bounded observations. The intended probe version is checkpointed before effects and recorded independently of observations. Evidence groups by that version, so a newer failure before its first sample supersedes an older pass for the same probe. A failed before control prevents the blocked allocation; a failed after control cannot produce a blocked pass. Missing/truncated/malformed output, DNS failures, connection refusal and unclassified errors do not count as isolation passes. Every owned sandbox is cleaned even after a leak, failed command, interruption or control failure. Incomplete cleanup keeps all records incomplete.

This measures TCP egress for the stated public IPv4 destinations, not every destination, UDP, IPv6, DNS confidentiality, ingress, private networks, metadata endpoints or isolation between tenants. The positive controls prevent a dead endpoint from producing a false pass; they do not prove universal firewall correctness. The E2B adapter maps its network policies to the native `allowInternetAccess` flag ([official network API](https://github.com/e2b-dev/E2B/blob/main/spec/openapi.yml)); the probes test the shipped mapping rather than calling native policy APIs directly. Daytona has no internet-mode capability in the current adapter; this paired profile remains unsupported there pending a separately designed reachable control.

## Snapshot and volume state profile

`manual.ts live-state` selects `snapshot-roundtrip,volume-crud,volume-persistence` through public shipped SDK methods. This is a separate paid storage budget, never implied by prepared baseline or credential authorization. The exact-source, clean-tree, local-only and explicit approval gates apply before loading secrets. Branch and merged runs share this launcher and report. Historical acceptance at 5db0558 is retained with its source and configuration; later production guard/recovery changes and the new fresh-process assertion have not been rerun live.

The default bounded plan for **one provider per approval** is:

| Resource / bound | Daytona | E2B |
| --- | --- | --- |
| Compute allocations | At most 6 total, peak 2, no build | At most 6 total, peak 2, no build |
| Native compute lifetime | 900 seconds each; at most 90 sandbox-minutes | 300 seconds each; at most 30 sandbox-minutes |
| Retained artifacts | 1 container cold snapshot, 1 new volume | 1 RAM/filesystem snapshot, 1 new volume |
| Source prerequisites | Exact approved container image ID, Python 3, pinned shell utilities, warm-pool inventory permission | Exact approved template ID, Python 3, envd >=0.5.0, volume beta access in native default region |
| Approved image ceiling | Operator verifies <=2 vCPU, <=2 GiB RAM, <=20 GiB root disk before launch | Operator verifies <=2 vCPU, <=2 GiB RAM, <=20 GiB root disk before launch |
| Artifact size ceiling | Approved root <=20 GiB; volume probe <128 bytes | Approved root <=20 GiB plus <=2 GiB RAM; volume probe <128 bytes |
| Exercise / final reconciliation | 240 seconds exercise, 60 seconds final cleanup | 240 seconds exercise, 60 seconds final cleanup |
| Requests | No creator retries; bounded 100-item inventory; each read <=30 seconds | Same; pinned SDK retries disabled |

The image resource ceilings are **approval prerequisites**, not limits enforced by Sandbar; the launcher does not measure template/root capacities. Stop before approval if the operator cannot verify them for the exact native image ID. Approval must include provider/account pricing, the particular image configuration, retained artifact costs and possible uncertain cleanup. Sandbox TTL does not expire snapshots or volumes. An acknowledgement lost after capture/create may retain storage without safely owned identity; preserve the ledger and arrange native operator investigation instead of deleting by guessed name. There is no claimed dollar ceiling or automatic storage expiry. Inline compute cleanup can use an additional bounded 60 seconds per teardown; at most four such cleanup phases plus the final 60-second reconciliation are attempted, so allow a 540-second operation envelope plus local close time. Native TTL remains fallback after process loss.

The `snapshot-roundtrip-v3` probe calls `checkSnapshot()` and `snapshot()` with no request, verifies configured native defaults, and proves Daytona source/restore guest processes are absent after stop and fresh execution. It requires a profile that keeps the source running after capture; other profiles are unsupported for this two-way isolation probe before capture. It writes captured bytes, captures, checks actual source lifecycle and metadata, restores new compute, and verifies captured bytes. With both sandboxes live, it writes distinct source and restored payloads, reads each write back, and checks that the other sandbox is unchanged in both directions. Fixtures that drop either write or alias the filesystems fail. It then destroys both computes, serializes the artifact reference as JSON, reopens/inspects it in a separate bounded OS process, closes the client, reconnects with the same verified native scope, reopens and inspects the reference, and restores again to prove the artifact survived source deletion and remained unchanged. RAM profiles additionally observe a UNIX socket process with a random nonce held only in RAM and independent counter progression in source/restored processes. Reconstructing a guest process or reading a nonce file is not a RAM pass.

The volume probe creates and inspects an owned volume (or uses an explicitly approved borrowed scoped reference), writes a unique run path through a finite writer, closes/fsyncs it, reads it back, permits compute cleanup with `storage: "allow-unconfirmed"`, verifies volume existence, then remounts into independent compute and checks identical run bytes. This observes persistence without claiming native durability, locking or atomic rename. Current built-ins explicitly report read-only unsupported, so they use five computes total. If read-only is advertised, the runner creates one additional reader within the six-compute ceiling, requires native EACCES/EPERM/EROFS write rejection, then verifies unchanged bytes. It never simulates read-only with chmod.

After approving this exact plan, use the baseline routing variables plus:

```sh
SANDBAR_QUAL_PROVIDER=e2b \
SANDBAR_QUAL_LIVE_AUTHORIZED=yes \
SANDBAR_QUAL_SCENARIOS=snapshot-roundtrip,volume-crud,volume-persistence \
SANDBAR_QUAL_LEDGER_DIR=/absolute/stable/private/qualification-ledgers \
SANDBAR_QUAL_EVIDENCE_REF="${SANDBAR_QUAL_EVIDENCE_REF:?Set a real resolvable evidence reference}" \
bun packages/sdk-qualification/provider-qualification/manual.ts live-state
```

For Daytona select an eligible **container** image ID, verified `SANDBAR_DAYTONA_TARGET`, and the expressly approved `SANDBAR_DAYTONA_NETWORK_POLICY`; the prepared profile's Linux VM image does not satisfy this capture profile. `SANDBAR_QUAL_SCENARIOS` may select any state workflow alone. `volume-crud` uses no compute and one owned volume, with create/inspect and independent delete confirmation even when mounts are unsupported. Selecting CRUD plus mounted persistence reuses that one volume; the retained-artifact ceiling is unchanged. Snapshot-only uses 3 computes/1 snapshot; volume-only uses at most 3 computes/1 volume (2 when read-only is unsupported). `SANDBAR_QUAL_BORROWED_VOLUME_REF` may contain a scoped JSON reference only after explicit approval: no volume allocation/deletion, unique no-clobber run path, unrelated existing bytes untouched, and the run file remains on borrowed storage. Private-beta denial is blocked/unavailable, unsupported guarantees are unsupported, missing approval is not-run.

Each creator and deleter is journaled independently by the awaited pre-dispatch reference hook. Provider stage checkpoints and pending observation token changes use the same awaited hook, so crash recovery retains each dispatch marker and newly learned native identity. Updated native acknowledgement tokens and owned resources are retained after both successful and interrupted waits. Reconciliation observes every creator first, preserves source evidence for unresolved captures, destroys dependent compute before storage, and observes saved deletes without replay. One unresolved retained artifact blocks subsequent allocation in that ledger directory. `manual.ts reconcile RUN_UUID` selects the saved state mode, roles and routing, including scoped borrowed-volume custody. Do not remove custody to bypass admission. Public evidence contains exact probe/preservation/ownership configuration and can pass only after every owned resource has confirmed cleanup; SDK/harness provenance and diagnostics remain separate from fixture coverage.

## Daytona prepared profile

Select `SANDBAR_QUAL_PROVIDER=daytona` for `manual.ts live-prepared`. Supply `SANDBAR_DAYTONA_TARGET` (the verified native region ID, such as `us`) and `SANDBAR_DAYTONA_SNAPSHOT_ID` for an existing borrowed active Linux VM/container snapshot. The credential loader accepts the existing Daytona key in `~/.config/sandbar.env`. The public factory always receives `ttlMinutes: 15`: at most one sandbox, native lifetime900seconds,240-second exercise,60-second owned cleanup, no image build, snapshot capture or retained storage allocation. The borrowed snapshot is never deleted. Explicit approval must cover that budget; ordinary CI remains offline.

Use the same ledger-directory, explicit run authorization and resolvable evidence-reference gates as E2B, with the provider/target/snapshot variables above. The region ID is recorded as the public region class so evidence for different regions cannot supersede each other. The native boundary is labeled `Daytona REST 0.218`, not a deployed server version. The profile covers the same13 baseline scenarios through public SDK calls, including atomic no-clobber on snapshots with GNU-compatible `ln -T` and hard links. All required shell utilities listed in the provider README must exist in the borrowed snapshot.

The awaited SDK reference hook journals the scoped identity before create/exec/write/delete effects. Read-only preparation verifies snapshot readiness, organization and target. A lost create acknowledgement is observed by the same correlation and never recreated. A lost delete acknowledgement is observed by scoped native state without another DELETE; uncorrelated404 remains unknown. Incomplete cleanup remains actionable in the private ledger. `reconcile RUN_UUID` with `SANDBAR_QUAL_PROVIDER=daytona` reuses saved target/snapshot/TTL routing and the current valid key, without requiring environment target/snapshot variables or live authorization. It can stop owned compute even if current egress eligibility changed. The paired network profile is E2B-only because the Daytona adapter does not support internet mode. The separately budgeted state profile qualifies implemented capture/restore; prepared baseline does not.

### Daytona Tier 2 baseline

For an account using Daytona's default network restrictions, set `SANDBAR_DAYTONA_NETWORK_POLICY=daytona-default` and select an existing public Linux snapshot by name (`SANDBAR_DAYTONA_SNAPSHOT_ID=daytona-small`) or ID. The public factory and create request both select this policy. The connection persists it privately for cleanup/recovery; old ledgers without the field keep their original blocked routing. The 15-minute TTL/240-second exercise/60-second cleanup budget is unchanged. This profile records `daytona-default-requested`, never `blocked-requested`, and does not qualify egress isolation. Strict block-all is unsupported on Tier 2; the paired network profile remains E2B-only.

The standard `DAYTONA_API_KEY` entry takes precedence over a legacy `SANDBAR_DAYTONA_API_KEY` entry in the credential file; injected environment values still take precedence.

An explicitly authorized branch acceptance run uses this same launcher, public-SDK assertions, durable custody and finite budget. Record exact source/dependency/configuration provenance. Reviewed unchanged production paths may retain that acceptance after merge; changed paths remain unverified until tested. Diagnostics and custody stay private. Never turn dirty or stale-bundle runs into clean-commit evidence.


### Cleanup between runs

Use the same private persistent ledger directory for all qualification runs. A directory admission lock serializes exercise and reconciliation across run IDs. A new manual run refuses to allocate while an earlier ledger contains an unconfirmed create. Reconcile that ledger first; never remove it or its crash lock to bypass unresolved cleanup. Read-only recovery continues within the cleanup budget, including delayed create discovery and asynchronous deletion. A saved delete is observed without submitting DELETE again. Native expiry is a fallback for process loss; confirmed cleanup still requires observation. Original exercise and teardown failures remain captured separately.


## External adapter profiles and generated support

An adapter author exports `defineProviderProfile(...)` from `profile.ts` as a default module. Supply the stable provider ID, pinned native version, credential variable names, `configure(environment, savedRouting)`, a public SDK `connection(routing, credentials)` factory, report configuration, native/exercise/cleanup bounds, and `support` feature declarations/caveats. See the small [external fixture profile](./fixtures/external-profile.ts) and its tests for an independently authored public adapter. The fixture is offline-only and is not a live provider.

`configure` returns bounded nonsecret scalar routing with `imageId`, `networkPolicy` and `nativeLifetimeSeconds`. Persisted routing must reopen the same verified scope without current template/region environment settings. The lifetime must match `bounds.nativeLifetimeSeconds`; the factory must actually set provider-native expiry. The common baseline uses one compute; state uses at most six total/peak two, one snapshot and one volume; no creator retry or OCI build. Profile bounds may shorten the 240-second exercise / 60-second cleanup budgets, not expand them. These declarations are approval prerequisites, not dollar ceilings or proof of provider expiry. Credentials are injected through declared variables; external profiles do not load the built-in operator credential file.

Profiles are trusted adapter code, committed within the clean checkout. Pin installed external adapter/native packages in the lockfile; do not import an unbuilt local adapter bundle. Live provenance includes the profile in the harness source commit and dependency pins in the SDK source verification. Profile construction/configuration must be effect-free. Public SDK capability discovery determines runtime eligibility; profile support describes implementation/configuration, never account entitlement. Snapshot assertions select actual public profiles; source defaults must support the running-source two-way probe. Snapshot reopen uses a 30-second read-only child process with inherited credentials and private stdin custody; failure still triggers owned cleanup.

After approval for the selected finite budget, the same short command handles external adapters:

```sh
SANDBAR_QUAL_PROVIDER=acme SANDBAR_QUAL_PROFILE=profiles/acme.ts \
bun packages/sdk-qualification/provider-qualification/manual.ts live-prepared
# Select state assertions independently; E2B CRUD does not require unsupported mounts.
SANDBAR_QUAL_PROVIDER=acme SANDBAR_QUAL_PROFILE=profiles/acme.ts \
SANDBAR_QUAL_SCENARIOS=volume-crud \
bun packages/sdk-qualification/provider-qualification/manual.ts live-state
```

Keep the authorization, private-ledger and evidence variables from the built-in examples. Reconcile uses the same profile plus its saved routing. Network pairing is currently the separately budgeted E2B profile; an external adapter needs a reviewed positive-control design before claiming measured network enforcement.

Declared support is `supported`, `unsupported` or `conditional`; observed acceptance is `passed`, `failed`, `blocked` or `not-run`. Keep volume CRUD separate from mounted persistence. Both docs pages are generated from `support.ts` and reviewed `results/<provider>.json`. Historical summaries may retain missing provenance explicitly in `historicalEvidence`; they must not invent full records or current-head passes. E2B's 403 no-effect denial and the earlier uncertain creator are separate evidence; the latter remains unresolved and blocks admission in its private ledger directory.

```sh
bun packages/sdk-qualification/provider-qualification/render.ts
bun packages/sdk-qualification/provider-qualification/render.ts --check
# Generate an external provider's two pages into an existing output directory.
bun packages/sdk-qualification/provider-qualification/render.ts \
  --profile profiles/acme.ts --results reviewed-results --output generated-docs
```

External results use the same strict schema and one JSON file per declared provider. Review summaries before publication; the renderer does not contact providers or publish automatically.
