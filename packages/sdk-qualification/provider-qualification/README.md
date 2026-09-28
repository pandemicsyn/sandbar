# Provider qualification

The qualification targets are **Daytona and E2B**. The E2B borrowed prepared-template profile uses the merged public SDK factory with a 300-second native sandbox lifetime. Daytona's manual profile remains blocked pending its merged native lifetime/cleanup enhancements. The common lifecycle, private cleanup ledger, offline fixtures and generated evidence page do not constitute a live certification claim. No live records have been collected.

## When to run

Run live acceptance tests when adding a provider or changing a fundamental public guarantee. Routine changes use offline fixtures and packed checks. The repository skill in `.agents/skills/qualify-provider/SKILL.md` explains scenario selection, extending coverage and certifying docs evidence. Runs are manual and require explicit authorization for their specific resource budget. Do not schedule routine paid CI runs.

The common lifecycle covers connect, one borrowed prepared-image create, inspect, argv and shell commands with cwd/env and stdout/stderr, nonzero exit, binary file write/read/overwrite, no-clobber conflict, inventory, destroy confirmation and close. Unsupported operations are recorded as `unsupported`, never passed. OCI/image-build is separately blocked until ownership and deletion of every retained artifact are proven; sandbox TTL does not expire retained storage.

## Credentials and profile gates

The manual entrypoint reads `~/.config/sandbar.env` (override with `SANDBAR_CREDENTIALS_FILE`). It imports only Daytona/E2B API keys, accepts `DAYTONA_API_KEY` or `SANDBAR_DAYTONA_API_KEY` and `E2B_API_KEY` or `SANDBAR_E2B_API_KEY`, and preserves injected environment values. It never imports live-enable flags. Offline tests use synthetic credentials and never load the operator file.

The local E2B profile creates at most one sandbox from an existing borrowed team-owned template. Native timeout is fixed at 300 seconds, exercise waits are aborted after 240 seconds, and cleanup has a separate 60-second budget. No image builds occur and the borrowed template is never deleted. Before approving a live run, review native pricing/account limits and the template's prerequisites; lifetime is not a dollar ceiling. Approval must cover the exact resource budget. A credential file or enable flag does not grant authorization.

Create a stable owner-only ledger directory outside the repository and temporary storage. Live preflight checks run before secret loading and connection: selected provider, explicit run-enable flag, local-only execution, clean exact SDK commit, routing, valid scenario dependencies and safe evidence reference.

After separate approval, the prepared E2B command is:

```sh
SANDBAR_QUAL_PROVIDER=e2b \
SANDBAR_QUAL_LIVE_AUTHORIZED=yes \
SANDBAR_QUAL_LEDGER_DIR=/absolute/stable/private/qualification-ledgers \
SANDBAR_QUAL_EVIDENCE_REF=https://github.com/pandemicsyn/sandbar/blob/main/specs/provider-evidence/e2b-run-1.md \
SANDBAR_E2B_TEAM_ID=existing-team \
SANDBAR_E2B_TEMPLATE_ID=borrowed-ready-template \
bun packages/sdk-qualification/provider-qualification/manual.ts live-prepared
```

`SANDBAR_QUAL_SCENARIOS` optionally selects comma-separated `inspect,exec-argv,exec-shell,exec-nonzero,file-binary,file-overwrite,file-no-clobber,inventory`. Connect, one create, teardown confirmation and close always run; unselected rows are not-run. File overwrite requires file-binary; no-clobber requires both earlier file scenarios. E2B requests blocked internet and uses the provider's default region. This profile does not probe egress and does not certify network isolation; records use `blocked-requested`.

Cleanup after interruption needs only the saved run UUID/private routing and fresh credentials. It does not require the live-enable flag, clean checkout, template/team environment variables or public evidence reference:

```sh
SANDBAR_QUAL_PROVIDER=e2b \
SANDBAR_QUAL_LEDGER_DIR=/absolute/stable/private/qualification-ledgers \
bun packages/sdk-qualification/provider-qualification/manual.ts reconcile RUN_UUID
```

Without `SANDBAR_QUAL_EVIDENCE_REF`, cleanup updates only the private ledger. With a reference, it writes a new sanitized report preserving original dated scenarios. CI live runs remain blocked without an off-runner checkpoint that acknowledges intent/reference before dispatch and an independent janitor; final artifact upload is insufficient.

## Ownership and recovery

`runPrepared` and `reconcile` use the public SDK. The private ledger stores the run UUID, borrowed-image classification, nonsecret routing and create intent. The awaited SDK `onReference` callback journals scoped create, exec, write and destroy references before dispatch. Checkpoint failure prevents the mutation. Returned sandbox identity is saved promptly. Borrowed images are never deletion targets.

On completion, failure or interruption, the lifecycle attempts owned-sandbox teardown. Confirmed cleanup requires a correlated public SDK `computeStopped` completion or scoped inspect state `destroyed`. Unknown state, uncorrelated absence and mere acknowledgement do not confirm cleanup. An absent durable pre-submit create reference proves that this harness dispatched no create; cleanup is `not-required`. Unknown submitted creates are observed without resubmission; a saved destroy is observed without another destroy. E2B confirms termination with its scoped destroy result; stopped/absent inspect state alone is unknown. SDK-exposed pending recovery tokens are checkpointed, including on cleanup timeout. If cancellation loses a token before the SDK exposes it, leave the outcome unresolved rather than inventing evidence or replaying a mutation. Unresolved resources remain private, durable and actionable. Never use account-wide name matching or create another sandbox to resolve uncertainty.

## Evidence and offline checks

Exercise and reconciliation hold an exclusive per-run lock across all mutations. A second process fails before mutations. A killed process can leave `<run UUID>.json.lock`; inspect its private host/PID metadata and prove that process has stopped before manually removing only that lock and resuming cleanup. Never remove a lock held by an active process. The recovery ledger remains intact; stale locks are never stolen automatically.

Only reviewed sanitized JSON belongs in `results/`. Records contain provider/scenario, mode (`live`, `fixture`, `packed`), exact merged SDK commit/version and harness commit, pinned native version, runtime/platform, timestamp, tested image/network/region class, evidence reference and cleanup state. Private ledgers can contain resource IDs and recovery references; never publish them, credentials or native logs.

The normal docs build reads only committed JSON and never contacts providers. The generated page uses live evidence only. A newer failure supersedes an older pass for the same configuration. Scenario successes with incomplete cleanup remain incomplete. Missing credentials or approval means not-run. No live records are committed yet.

```sh
bun test packages/sdk-qualification/provider-qualification
bun run --cwd packages/sdk-qualification check
bun packages/sdk-qualification/provider-qualification/render.ts
bun packages/sdk-qualification/provider-qualification/render.ts --check
```

Before a later authorized live run, qualify the merged profiles through relevant offline fixtures and packed consumers on that exact commit. The existing partial provider live scripts do not supply this acceptance record.

The live gate checks that SDK sources and dependency pins match `origin/main` (or `SANDBAR_QUAL_SDK_REF`, which must be an ancestor of `origin/main`). A clean, independently reviewed harness branch can run against those unchanged merged sources; both revisions are recorded. Cleanup reconciliation remains available without this gate. Refresh `origin/main` before selecting the SDK revision.
