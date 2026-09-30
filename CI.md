# CI validation

`.github/workflows/ci.yml` runs for every pull request, pushes to `main`, and manual dispatch. Feature branch pushes do not start a second copy of PR validation. New runs cancel older runs for the same PR or branch. No workflow-level path filters leave expected checks pending.

| Job       | Coverage                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `build`   | Locked install, lint/format, sequential package builds (including the service UI), workspace typechecks, server build.             |
| `offline` | SDK, adapter, core, provider contracts, qualification unit tests and vendored lint-rule regressions. No live provider credentials. |
| `service` | Existing store/runtime/client/server regressions and Chromium management UI tests.                                                 |
| `packed`  | Packed Node/Bun consumers and local OTel/Sentry/Datadog fixtures. Conditional release rehearsal below.                             |
| `docs`    | Docs typechecks, generated references, support data, site build and executable examples.                                           |
| `verify`  | Always runs and fails unless all five jobs succeed, preserving the original aggregate status name.                                 |

The build job archives fresh `dist` directories and consumer jobs restore that artifact from **this workflow run and commit** after their locked install. There is no cross-run build cache. Rerunning a consumer job uses the original run's immutable build artifact; a build rerun replaces that run's archive from the same checkout; a changed source revision requires a new workflow run. The one-day artifact retention means an older partial rerun may require rerunning all jobs. Shared builds remain sequential.

`check`, `test`, `build`, `package:smoke` and `docs:check` remain safe standalone developer commands: each rebuilds prerequisites. The `:built` variants are lower-level commands for a checkout whose matching prerequisites were just built or restored; they deliberately do not infer freshness from an existing `dist` directory. CI alone supplies `SANDBAR_TEST_BUILT_WEB=true` after restoring the matching UI output; standalone UI tests still build it.

The stable/prerelease release rehearsal runs when the diff includes workflows, Changesets, release/build scripts, any workspace manifest or TypeScript configuration, the lockfile, npm-ignore rules, or the UI entry/build configuration. It also runs on manual validation or when a usable base commit is unavailable. Other changes still get packed consumer and tracing qualification. Every job keeps a status regardless of this step's scope. Main pushes validate the merged diff under the same rules.

`release-npm.yml` always performs the full rehearsal, tracing checks, exact-version installer qualification and documentation/service regressions. Publication still requires an exact version tag reachable from main, the qualified SHA/artifacts, a non-dry-run dispatch and the `npm` environment. The publish job rebuilds its separate checkout and verifies it against the qualified artifacts. No publication is part of ordinary CI. At implementation time, GitHub reported no main-branch protection and no repository rulesets; `verify` remains available for a future required check.

## Work removed

The previous workflow built the shared graph five times (`check`, `test`, `build`, `package:smoke`, `docs:check`), then four more times in the release rehearsal. The rehearsal now builds only once for each changed stable/prerelease manifest set; two redundant builds around stable tagging/repacking were removed. Ordinary validation now builds the graph once; release-scoped validation builds it three times including the two versioned fixture checkouts. Each graph build also builds the service UI, so those redundant UI builds disappear too. CI's UI tests reuse the fresh UI build instead of adding another build.

Packed smoke runs once for ordinary PRs, or three times for release-related changes (the original checkout, stable and prerelease); previously it ran three times on every change. The docs site builds once instead of twice, and documentation example tests run once instead of in both the root suite and docs suite. Workspace typechecks still include the docs check; the dedicated docs job repeats that check to keep its standalone validation complete. Tracing and all existing offline/service tests remain covered.

On the local macOS/Bun 1.3.14 checkout, a fresh package graph took 8.6 seconds, offline tests took 121 seconds, service/UI tests took 20 seconds, docs validation took 10 seconds, packed consumers took 29 seconds, tracing fixtures took 50 seconds, and the full release rehearsal took 113 seconds. These are local measurements, not predicted GitHub runner timings. The bounded fake history fixture took 27 ms after replacing 520 writes with a valid 511-entry persisted seed and nine real rejection/eviction writes.

The old packed restart failure log did not identify its wait stage or runner error cause, so it cannot prove the original cause. The fixture now holds provider observation pending, waits for persisted `awaiting_observation` phases, restarts, explicitly reconciles and checks both completed operations with one submission each. Timeout diagnostics name the exact stage and include only HTTP status, operation status/phase and counters. The runner reports its poll stage plus an allowlisted store/SQLite code, without error messages, causes, credentials or provider payloads. Recovery deadlines and production scheduling semantics are unchanged.
