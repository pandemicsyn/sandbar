# Public packages and adapter conventions

**Accepted user decision — September 27, 2026.** Updated for the 1.0 launch decision: Daytona and E2B are the only launch built-ins; Modal is external and experimental. It supersedes provisional package names and import paths in earlier specs. It records a design decision, not a claim that these packages are published or all providers are implemented.

## Names and imports

| Purpose | npm package | Import path |
| --- | --- | --- |
| Main SDK | `sandbar-sdk` | `sandbar-sdk` |
| Built-in Daytona adapter | included in `sandbar-sdk` | `sandbar-sdk/daytona` |
| External experimental Modal adapter | `sandbar-modal` | `sandbar-modal` |
| Built-in E2B adapter for 1.0 | included in `sandbar-sdk` | `sandbar-sdk/e2b` |
| Custom adapter authoring | `sandbar-adapter` | `sandbar-adapter` |
| Adapter conformance tests | included in `sandbar-adapter` | `sandbar-adapter/testing` |
| Optional management service | `sandbar-service` | `sandbar-service` |
| Service HTTP client | included in `sandbar-service` | `sandbar-service/client` |
| Future additional integrations | `sandbar-<provider>` | e.g. `sandbar-tensorlake`, `sandbar-vercel` |

SDK subpaths are exports of the parent package, not separate npm installations. Use these unscoped public names; do not assume ownership of the `@sandbar` npm scope. The occupied `sandbar` package is unrelated. Registry absence is not reservation or a guarantee of publication rights. Publication, account/scope setup and live provider operations are not authorized by this decision.

Third-party authors may use their own names/scopes, for example `@acme/sandbar-adapter`. The npm name is independent of the adapter's stable provider ID (`daytona`, `modal`, `e2b`, or a custom ID). Installation never automatically registers providers in a service.

## Consumer experience

The accepted target for built-in providers is one installation:

```sh
npm install sandbar-sdk
```

```ts
import { Sandbar } from 'sandbar-sdk';
import { daytona } from 'sandbar-sdk/daytona';

const sandbar = await Sandbar.connect(
  daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    target: 'us',
  }),
);
```

This is a target API example, not a live-verified or currently published quickstart. `daytona` packages typed provider configuration and credentials for the common connection path. Constructing it performs no provider IO; `Sandbar.connect` validates and verifies the binding and owns the resulting session. It uses the same engine, configuration schemas, scope verification, host policy and close/recovery semantics as custom adapters. E2B uses the same built-in factory pattern; external adapters use the public binding or definition connection form. Exact options must follow their supported implementations. Keep the general custom-adapter connection form available without forcing custom authors to implement a factory.

The service is separately installed with `npm install sandbar-service`. A remote consumer imports `sandbar-service/client`; it does not need a running local service. Service hosting retains its documented runtime/database requirements. The client subpath must run in supported Node and Bun environments without importing Bun-only hosting, SQL or UI code.

## Support and implementation scope

Daytona and E2B are the selected 1.0 built-in providers. Bundled convenience, conformance tests and maintenance distinguish them; they have no privileged execution path. Both use the same public `sandbar-adapter` API as external integrations. Implementation, fixture qualification, packed qualification and live qualification are separate statuses; a roadmap selection does not establish support.

Modal is a separately installed experimental `sandbar-modal` adapter. Its implementation uses the public adapter API; its built-in SDK export and bundled native dependencies have been removed. The experimental designation must describe actual limitations: private version-sensitive transport, uncertain image-build recovery and any unrun live qualification. The optional service can consume it through explicit custom registration; installation never auto-registers it. Modal is not a 1.0 built-in release gate.

Fast-follow priority is exactly **Vercel, Boxed (boxd), Islo, Tensorlake**. Additional integrations retain the external `sandbar-<provider>` distribution convention unless the user separately changes it. This roadmap does not start those implementations, authorize publication or permit placeholder exports. None is a 1.0 launch gate.

Daytona and E2B implementations and the external Modal transition are merged. Their package READMEs and qualification evidence describe supported behavior and remaining limitations; merger does not establish live qualification or npm publication. The fake provider remains a deterministic development/test fixture.

## Dependency and schema ownership

`sandbar-sdk` includes implemented built-in adapters and their required production dependencies. Modal's native dependencies belong only to the separately installed `sandbar-modal` package. Provider-specific code loads through explicit subpaths; importing the SDK root must not initialize provider clients or load unrelated provider implementations. One install can still download built-in provider dependencies: subpaths isolate imports, not installation size.

Avoid a dependency cycle: `sandbar-adapter` holds the shared lower-level portable definitions needed by adapter implementations and the SDK. It must not depend on the SDK, service, SQL or native provider libraries. The SDK owns its consumer API, errors and execution engine. Built-in implementation workspaces may remain private and be bundled; their unpublished names must not leak into installed runtime imports or declarations. Do not publish core/SPI/store workspaces just to satisfy monorepo dependencies.

There is no public catch-all contracts package. HTTP/project/auth envelopes, routes and OpenAPI generation belong to the service, composing portable definitions where appropriate. SDK/adapter imports must not depend on service HTTP schemas or OpenAPI tooling. The service consumes supported public SDK APIs, including the optional advanced lifecycle used for durable admission and observation-only recovery. Shared public errors retain one identity across SDK and service client.

## Implementation and release acceptance

Apply the names consistently to manifests, exports, dependency ranges, documentation, generated references, examples, tarball tests and Changesets release configuration. Remove superseded unpublished aliases, including SDK `/direct` and `/remote`, rather than maintaining compatibility layers. Workspace directory names may remain stable; users depend on package names and export paths.

The SDK task implements the package boundaries and currently implemented built-ins on its isolated branch. The release task integrates only after that branch is reviewed and merged, using the final actual distributable graph. Do not include planned providers as releasable packages or phantom exports.

Qualify actual packed artifacts with strict external TypeScript consumers and Node/Bun execution: SDK root plus built-in subpaths; an independently authored adapter; service/client HTTP flows; and service admission/restart/observation without mutation replay. Release qualification additionally exercises npm, pnpm and Bun installation without workspace aliases or extra root dependencies masking missing transitive packages. Verify that SDK imports exclude service/SQL and service/client imports exclude hosting code.

Zero compatibility with unpublished APIs does not weaken current-version scope, binary fidelity, validation, durable submission markers, abort/close or unknown/no-replay guarantees. Do not automatically delete user data. Effect remains parked and contributes no dependencies, hooks, work or completion gate.
