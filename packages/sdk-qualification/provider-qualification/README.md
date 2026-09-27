# Provider qualification prototype

This is a bounded manual acceptance check, not a live certification claim. The normal docs build reads only reviewed JSON records in `results/`; it does not contact providers. `bun packages/sdk-qualification/provider-qualification/render.ts --check` detects generated-page drift. No live records are committed yet. Fixture tests verify the ledger, cleanup and renderer without creating provider resources.

## Profiles and current gate

The prepared-image prototype runs through `Sandbar.connect` with the public `sandbar-sdk/modal` factory available on this base commit. Modal is planned as an external experimental adapter and this prototype is not a 1.0 launch gate. Daytona and E2B are the intended 1.0 built-in profiles; their manual wiring awaits merged public factories and native teardown evidence. The common lifecycle covers connect, one create, inspect, argv and shell commands with cwd/env and stdout/stderr, a nonzero exit, binary file write/read/overwrite, no-clobber conflict, inventory, destroy confirmation and close. Unsupported core operations are recorded as `unsupported`, never passed. OCI/image-build is separate and **blocked**: an image/template/snapshot can outlive sandbox TTL, and ownership/deletion of all possible build outcomes is not yet proven.

For a locally authorized Modal run, use a borrowed, existing prepared `im-*` image. The harness never deletes it. The exact operator command is:

```sh
SANDBAR_QUAL_PROVIDER=modal \
SANDBAR_QUAL_LIVE_AUTHORIZED=yes \
SANDBAR_QUAL_LEDGER_DIR=/absolute/stable/private/qualification-ledgers \
SANDBAR_QUAL_EVIDENCE_REF=specs/provider-evidence/modal-run-1.md \
SANDBAR_MODAL_APP=existing-app \
SANDBAR_MODAL_ENVIRONMENT=main \
SANDBAR_MODAL_REGION=chosen-region \
SANDBAR_MODAL_IMAGE_ID=im-borrowed-prepared-id \
MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... \
bun packages/sdk-qualification/provider-qualification/manual.ts live-prepared
```

The environment flag is a guard, **not authorization**. Obtain separate approval for the specific live run and resource budget first. Inject keys through the operator's secret store or environment, never chat, shell history or committed files. Preflight checks every required value before connect or create. This prototype is local only; it rejects `CI` because there is no configured durable off-runner checkpoint. Do not use a temporary ledger directory.

`SANDBAR_QUAL_SCENARIOS` can select a comma-separated subset of `inspect,exec-argv,exec-shell,exec-nonzero,file-binary,file-overwrite,file-no-clobber,inventory`. Connect, one create, cleanup confirmation and close always run. Unselected rows are recorded `not-run`. File overwrite requires file-binary; no-clobber requires both file-binary and file-overwrite.

At most one sandbox is created. Modal's public factory is configured for a 300-second native sandbox timeout. The harness aborts test work after 240 seconds, then attempts cleanup for up to 60 seconds. The borrowed prepared image may already carry costs outside this run; the harness does not own it. No image builds occur. The native billing model and account limits must be reviewed before authorization; a time limit is not a dollar ceiling.

## Ownership and recovery

The private JSON ledger records a run UUID, borrowed-image classification and nonsecret connection routing before any paid create. It then durably records create intent; the public SDK `onReference` callback saves each scoped create, exec, write and destroy identity **before submit**. Returned sandbox ID is checkpointed promptly. The SDK must not submit if that checkpoint rejects. Ledger files have owner-only permissions and can contain scope IDs and recovery references, so keep them private and off the public docs path. Credentials are never written there. Public reports contain only allowlisted metadata and no raw IDs, credentials, native logs or recovery refs. Review a sanitized report before copying it into `results/`.

On normal completion, failure or SIGINT/SIGTERM, the harness attempts destroy and checks `inspect` for `destroyed`. It marks cleanup confirmed only after that observation. If create outcome or termination is uncertain, the run remains incomplete and the ledger remains actionable. An API acknowledgement or absence without scoped proof is insufficient. To retry an incomplete run after a crash, set the same environment and run:

```sh
bun packages/sdk-qualification/provider-qualification/manual.ts reconcile RUN_UUID
```

Reconcile validates the saved create reference against the verified connection, observes a lost create without resubmission, and destroys only the positively identified sandbox from this run. If a destroy was submitted but its result or readback is uncertain, reconcile observes that original destroy and **does not submit another**. A borrowed image is never a deletion target. Unresolved state requires provider-side inspection; do not start another create to resolve it or delete a name match. If ownership cannot be proved, leave it for manual audit.

The cleanup command does not require the borrowed image ID, scenario selection, clean checkout or live-run authorization flag. It needs the saved ledger and provider connection credentials. If `SANDBAR_QUAL_EVIDENCE_REF` is omitted, cleanup still runs and updates the private ledger; no public report is written.

An independent backstop for local use is the provider-native sandbox expiry plus a separately invoked janitor that enumerates incomplete ledgers from the stable private directory and calls `reconcile` with fresh credentials. Such a janitor is not installed or scheduled by this prototype. Before enabling CI live runs, provide an off-runner durable checkpoint that acknowledges each intent/reference before dispatch; a post-job artifact upload is insufficient if the runner dies. Its janitor must discover incomplete ledgers independently of the runner. Checkpoint failure must prevent native effects. Provider outage or revoked credentials can still leave resources unresolved; these cases must be reported, never called green. Native TTL only bounds compute and does not clean retained built images.

## Evidence and status

Each result records provider/scenario, mode (`live`, `fixture`, `packed`), status, exact SDK commit/version, pinned native version, runtime/platform, timestamp, tested image/network/region class and evidence reference. The generated page uses only live records. A newer failure supersedes an older pass for the same runtime and configuration; older records remain in dated JSON history. Missing credentials or authorization mean `not-run`, not a fabricated pass. Only a run with confirmed cleanup can be proposed as a complete live qualification, and an operator must review the private ledger and sanitized result before committing evidence.

Before actual live qualification, verify the provider's pinned native TTL, create correlation, scoped readback and termination semantics against the merged adapter and official API; run the packed consumer gate on that exact commit. The current older live scripts in provider packages cover partial paths and are not this acceptance record.
