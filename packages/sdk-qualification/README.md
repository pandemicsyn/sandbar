# SDK and provider qualification

Qualification belongs with the harness, not in the feature specifications. This package checks the public SDK, adapters and optional service as consumers. Passing deterministic fixtures does not establish native provider behavior.

## Offline coverage

- [Resource parity](parity.test.ts) exercises direct and service-client resource flows, including binary files and execution.
- [SDK lifecycle tests](../sdk/src/adapter-direct.test.ts) cover reference-before-dispatch, pending tokens, scope rejection, no replay and close behavior.
- [Service adapter tests](../../apps/server/src/adapter.test.ts) cover structured encrypted connections, registration, project isolation and restart observation.
- [Package smoke](package-smoke.mjs) builds isolated consumers from actual archives, checks strict NodeNext declarations, and runs Node/Bun direct and HTTP flows. It includes Daytona/E2B and experimental Modal fixtures, an independent adapter, and service admission/restart recovery.

The SDK root must not load the service, SQL or unrelated provider implementations. Built-in dependencies can still be installed with the SDK; import isolation is different from installation size. The service client must not load hosting code. Packed consumers verify these boundaries without workspace aliases masking missing dependencies.

Earlier recorded qualification covered Node.js 26.4.0 and Bun 1.3.14 on macOS arm64 for fake/Daytona/Modal fixtures, an external adapter, and HTTP client flows. That record is not a fresh run or blanket provider certification. The current [CI workflow](../../.github/workflows/ci.yml) and harness define automated coverage; provider records retain their own exact revisions, runtimes and configurations.

## Run the checks

Use the Bun version pinned in the [root manifest](../../package.json), and install dependencies with `bun install --frozen-lockfile`. From the repository root:

```sh
bun run check
bun run test
bun run package:smoke
bun run docs:check
```

Run shared builds sequentially. Focused tests are useful during iteration; package/API changes also require packed qualification. Root CI additionally runs source checks, the app build, and release/installer fixtures. See [release instructions](../../RELEASE.md) for publication requirements; a successful package smoke run does not publish anything.

## Provider evidence

The [provider qualification harness](provider-qualification/README.md) defines bounded live scenarios. [Reviewed result records](provider-qualification/results/README.md) feed the [public live matrix](../../apps/docs/src/content/docs/docs/providers/live-qualification.md). Keep fixture, packed, diagnostic and merged-source live results separate, including skipped and failed scenarios.

Live calls, paid resources and publication require explicit authorization. Do not move private diagnostics, credentials, native IDs or cleanup ledgers into specs or committed evidence.
