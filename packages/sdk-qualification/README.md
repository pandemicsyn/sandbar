# SDK and provider qualification

Qualification belongs with the harness, not in the feature specifications. This package checks the public SDK and adapters as consumers. Passing deterministic fixtures does not establish native provider behavior.

## Offline coverage

- [SDK resource flows](resources.test.ts) exercise binary files, execution and cleanup against the process-based fake provider.
- [SDK lifecycle tests](../sdk/src/adapter-direct.test.ts) cover reference-before-dispatch, pending tokens, scope rejection, no replay and close behavior.
- [Package smoke](package-smoke.mjs) builds isolated consumers from actual archives, checks strict NodeNext declarations, and runs Node/Bun SDK flows. It includes Daytona/E2B and experimental Modal fixtures and an independent adapter.

Packed consumers verify import and dependency boundaries without workspace aliases masking missing packages. Passing deterministic fixtures does not establish live provider behavior. The current [CI workflow](../../.github/workflows/ci.yml) and harness define automated coverage; provider records retain their exact revisions, runtimes and configurations.

## Run the checks

Use the Bun version pinned in the [root manifest](../../package.json), and install dependencies with `bun install --frozen-lockfile`. From the repository root:

```sh
bun run check
bun run test
bun run package:smoke
bun run docs:check
```

Run shared builds sequentially. Focused tests are useful during iteration; package/API changes also require packed qualification. Root CI additionally runs source checks, the docs build, and release/installer fixtures. See [release instructions](../../RELEASE.md) for publication requirements; a successful package smoke run does not publish anything.

## Provider evidence

The [ordinary Bun SDK integration suites](provider-qualification/README.md) exercise explicitly authorized provider workflows with bounded owned-resource setup and cleanup. Standard Bun JUnit plus a thin provenance/cleanup mapping produces [reviewed exact-revision records](provider-qualification/results/README.md) for the [public support table](../../apps/docs/src/content/docs/docs/providers/support.md). Keep fixture, packed and live evidence distinct; preserve failed/skipped cases and original source provenance before and after merge.

Live calls, paid resources and publication require explicit authorization. Do not move private diagnostics, credentials, native IDs or cleanup ledgers into specs or committed evidence.
