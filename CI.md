# Continuous integration

The [CI workflow](.github/workflows/ci.yml) builds the shared graph once per commit and runs independent validation jobs against those fresh outputs.

| Job       | Coverage                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `build`   | Locked install, lint/format, sequential package builds and workspace typechecks.                      |
| `offline` | SDK, adapter, provider and qualification fixtures.                                                    |
| `packed`  | Isolated Node/Bun consumers and observability fixtures when packaging inputs change.                  |
| `docs`    | Content/type checks, generated TypeScript and provider evidence, static site and executable examples. |
| `verify`  | Requires selected validation jobs to succeed; accepts only an intentional `packed` skip.              |

Packed validation runs when manifests (including export maps), dependency locks, TypeScript/build configuration, package ignore files, public build entrypoints, package assets, qualification code or the packed recovery example change. Changes to CI workflows, release scripts or Changesets configuration also select it. Routine implementation edits, tests outside the qualification harness, documentation and changeset prose do not select it. Manual CI dispatches and unavailable base commits select packed validation conservatively. Renames check both the old and new paths.

Stable/prerelease and npm/pnpm/Bun installer rehearsals run in the release workflow, rather than ordinary CI. The release workflow always runs full qualification before publication, including for code changes whose PR skipped packed validation. Such changes can surface a packaging failure during release qualification; ordinary PR builds, typechecks, offline tests and docs checks still run on every PR.

The build job archives fresh package `dist` directories. Consumer jobs restore the artifact from the same workflow run and commit after their locked install. There is no cross-run build cache. One-day artifact retention can require rebuilding an older run. Shared builds remain sequential.

`check`, `test`, `build`, `package:smoke` and `docs:check` rebuild their prerequisites. The `:built` variants require matching fresh outputs; they do not infer freshness from existing `dist` directories.

The [release workflow](.github/workflows/release-npm.yml) performs the full SDK qualification, tracing checks, stable/prerelease rehearsal, exact-version npm/pnpm/Bun installer checks and documentation checks. Publication requires an exact version tag reachable from main, qualified artifacts, a non-dry-run dispatch and the protected `npm` environment. Ordinary CI does not publish packages or call live providers.
