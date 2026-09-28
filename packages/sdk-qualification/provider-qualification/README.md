# Provider qualification

The qualification targets are **Daytona and E2B**. This branch provides the common public SDK lifecycle, private cleanup ledger, offline fixtures and generated evidence page. Their live entrypoint profiles are **blocked pending merged public factories and verified native lifetime/teardown semantics**. `manual.ts` validates the selected provider, loads the operator credential file, then fails before any provider import, connection or mutation. This scaffold is not a live certification claim.

## When to run

Run live acceptance tests when adding a provider or changing a fundamental public guarantee. Routine changes use offline fixtures and packed checks. The repository skill in `.agents/skills/qualify-provider/SKILL.md` explains scenario selection, extending coverage and certifying docs evidence. Runs are manual and require explicit authorization for their specific resource budget. Do not schedule routine paid CI runs.

The common lifecycle covers connect, one borrowed prepared-image create, inspect, argv and shell commands with cwd/env and stdout/stderr, nonzero exit, binary file write/read/overwrite, no-clobber conflict, inventory, destroy confirmation and close. Unsupported operations are recorded as `unsupported`, never passed. OCI/image-build is separately blocked until ownership and deletion of every retained artifact are proven; sandbox TTL does not expire retained storage.

## Credentials and profile gates

The manual entrypoint reads `~/.config/sandbar.env` (override with `SANDBAR_CREDENTIALS_FILE`). It imports only Daytona/E2B API keys, accepts `DAYTONA_API_KEY` or `SANDBAR_DAYTONA_API_KEY` and `E2B_API_KEY` or `SANDBAR_E2B_API_KEY`, and preserves injected environment values. It never imports live-enable flags. Offline tests use synthetic credentials and never load the operator file.

Before enabling either live profile, use its merged public SDK factory, prove scoped create correlation and termination semantics, configure a native lifetime for at most one sandbox, bound exercise and cleanup waits, and establish cleanup of all owned artifacts. Require a clean exact SDK commit, explicit run authorization, selected scenarios and a stable owner-only ledger directory outside the repository and temporary storage. Cleanup after interruption must need only the saved ledger and fresh credentials. CI live runs remain blocked without an off-runner checkpoint that acknowledges intent/reference before dispatch and an independent janitor; final artifact upload is insufficient.

## Ownership and recovery

`runPrepared` and `reconcile` use the public SDK. The private ledger stores the run UUID, borrowed-image classification, nonsecret routing and create intent. The awaited SDK `onReference` callback journals scoped create, exec, write and destroy references before dispatch. Checkpoint failure prevents the mutation. Returned sandbox identity is saved promptly. Borrowed images are never deletion targets.

On completion, failure or interruption, the lifecycle attempts owned-sandbox teardown. Confirmed cleanup requires a correlated public SDK `computeStopped` completion or scoped inspect state `destroyed`. Unknown state, uncorrelated absence and mere acknowledgement do not confirm cleanup. Unknown creates are observed without resubmission; a saved destroy is observed without another destroy. Unresolved resources remain private, durable and actionable. Never use account-wide name matching or create another sandbox to resolve uncertainty.

## Evidence and offline checks

Exercise and reconciliation hold an exclusive per-run lock across all mutations. A second process fails before provider calls. A killed process can leave `<run UUID>.json.lock`; inspect its private host/PID metadata and prove that process has stopped before manually removing only that lock and resuming cleanup. Never remove a lock held by an active process. The recovery ledger remains intact; stale locks are never stolen automatically.

Only reviewed sanitized JSON belongs in `results/`. Records contain provider/scenario, mode (`live`, `fixture`, `packed`), exact SDK commit/version, pinned native version, runtime/platform, timestamp, tested image/network/region class, evidence reference and cleanup state. Private ledgers can contain resource IDs and recovery references; never publish them, credentials or native logs.

The normal docs build reads only committed JSON and never contacts providers. The generated page uses live evidence only. A newer failure supersedes an older pass for the same configuration. Scenario successes with incomplete cleanup remain incomplete. Missing credentials or approval means not-run. No live records are committed yet.

```sh
bun test packages/sdk-qualification/provider-qualification
bun run --cwd packages/sdk-qualification check
bun packages/sdk-qualification/provider-qualification/render.ts
bun packages/sdk-qualification/provider-qualification/render.ts --check
```

Before a later authorized live run, qualify the merged profiles through relevant offline fixtures and packed consumers on that exact commit. The existing partial provider live scripts do not supply this acceptance record.
