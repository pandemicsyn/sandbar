# Continuous integration

The [CI workflow](.github/workflows/ci.yml) builds the shared graph once per commit and runs independent validation jobs against those fresh outputs.

| Job       | Coverage                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `build`   | Locked install, lint/format, sequential package builds and workspace typechecks.                        |
| `offline` | SDK, adapter, provider and qualification fixtures.                                                      |
| `packed`  | Isolated Node/Bun consumers, observability fixtures, and release rehearsals when release inputs change. |
| `docs`    | Content/type checks, generated TypeScript and provider evidence, static site and executable examples.   |
| `verify`  | Requires every validation job to succeed.                                                               |

The build job archives fresh package `dist` directories. Consumer jobs restore the artifact from the same workflow run and commit after their locked install. There is no cross-run build cache. One-day artifact retention can require rebuilding an older run. Shared builds remain sequential.

`check`, `test`, `build`, `package:smoke` and `docs:check` rebuild their prerequisites. The `:built` variants require matching fresh outputs; they do not infer freshness from existing `dist` directories.

The [release workflow](.github/workflows/release-npm.yml) performs the full SDK qualification, tracing checks, stable/prerelease rehearsal, exact-version npm/pnpm/Bun installer checks and documentation checks. Publication requires an exact version tag reachable from main, qualified artifacts, a non-dry-run dispatch and the protected `npm` environment. Ordinary CI does not publish packages or call live providers.
