# TypeScript SDK runtime and package qualification

The direct SDK is a server-side TypeScript client. `sandbar-sdk` connects an installed adapter in the caller process. The optional `sandbar-service/client` uses HTTP to reach a separately hosted Bun service. The fake provider is a deterministic simulation; these checks do not qualify live Daytona, Modal or other providers.

## Measured support

The packed `sandbar-sdk`, `sandbar-service` and external adapter archives typecheck under strict NodeNext settings in isolated consumers. Node.js 26.4.0 and Bun 1.3.14 on macOS arm64 run the direct fake, Daytona fixture, Modal fixture, external adapter and service HTTP client flows. The packed service runs a Bun HTTP admission, restart and observation-only recovery flow with one adapter submission. No package was published.

The direct SDK dependency graph contains `sandbar-sdk`, `sandbar-adapter` and Zod. It does not install the service, its SQL storage, Hono or UI. The service client's JavaScript imports SDK helpers, Zod and portable adapter schemas without loading the service host. The remote-only packed consumer omits the fake provider and exercises HTTP create, inspect and destroy under Node and Bun. The fake provider persists its fixture ledger separately; that is provider evidence, not direct SDK storage.

## Behavioral coverage

`packages/sdk-qualification/parity.test.ts` exercises the public resource flow in direct and service-client modes, including binary execution and files. `packages/sdk/src/adapter-direct.test.ts` checks reference-before-dispatch, pending token recovery, no replay, scope rejection and close behavior. `apps/server/src/adapter.test.ts` checks encrypted structured connections, dynamic registration, project isolation and observation after service restart. The packed consumer check uses local archives, emitted declarations and independent process roots.

Run `bun run check`, `bun test`, and `bun run package:smoke` from the repository root. The package smoke command builds and packs local packages, validates dependency closure and strict declarations, runs Node/Bun consumers, and removes its temporary processes and files.
