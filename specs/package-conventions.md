# Public packages and adapter conventions

**Accepted user decision — October 11, 2026.** Daytona and E2B are separately installed, officially maintained integrations. This supersedes the September 27 bundled-provider decision. The 0.1.0 release is prepared in source; registry commands describe the intended release experience. As of October 11, registry latest entries are 0.0.0 name-reservation placeholders, not usable SDK releases.

## Names and imports

| Purpose | npm package | Import path |
| --- | --- | --- |
| Provider-neutral SDK | `sandbar-sdk` | `sandbar-sdk` |
| Official Daytona adapter | `@sandbar-sdk/daytona` | `@sandbar-sdk/daytona` |
| Official E2B adapter | `@sandbar-sdk/e2b` | `@sandbar-sdk/e2b` |
| Experimental Modal adapter | `@sandbar-sdk/modal` | `@sandbar-sdk/modal` |
| boxd adapter (experimental) | `@sandbar-sdk/boxd` | `@sandbar-sdk/boxd` |
| Boat adapter (experimental) | `@sandbar-sdk/boat` | `@sandbar-sdk/boat` |
| Official Vercel adapter | `@sandbar-sdk/vercel` | `@sandbar-sdk/vercel` |
| Command line (`sandbar` binary) | `@sandbar-sdk/cli` | none; run `sandbar` |
| Custom adapter authoring | `@sandbar-sdk/adapter` | `@sandbar-sdk/adapter` |
| Adapter conformance tests | included in `@sandbar-sdk/adapter` | `@sandbar-sdk/adapter/testing` |
| Future integrations | `@sandbar-sdk/<provider>` | e.g. `@sandbar-sdk/tensorlake` |

**Accepted user decision — October 11, 2026.** The core keeps the unscoped `sandbar-sdk` name; every other official package lives in the project-owned `@sandbar-sdk` npm scope, so new official integrations need no separate name reservation. This supersedes the earlier unscoped `sandbar-<package>` names, whose placeholders are removed from npm. The occupied `sandbar` package and `@sandbar` scope are unrelated; private workspaces keep `@sandbar/*` names and are never published. Registry absence does not reserve a name or authorize publication. Third-party authors may use their own names/scopes, such as `@acme/sandbar-adapter`. Package names are independent of stable provider IDs (`daytona`, `e2b`, `boxd`, `vercel`, `modal`).

## Consumer experience

```sh
npm install sandbar-sdk @sandbar-sdk/daytona
```

```ts
import { Sandbar } from "sandbar-sdk";
import { daytona } from "@sandbar-sdk/daytona";

const sandbar = await Sandbar.connect(daytona({
  apiKey: process.env.DAYTONA_API_KEY!,
  target: "us",
}));
```

For E2B install `sandbar-sdk @sandbar-sdk/e2b` and import `e2b` from `@sandbar-sdk/e2b`. Factories package typed settings and credentials without provider IO. `Sandbar.connect` validates and verifies the binding and owns the session. Custom authors may use `bindAdapter` from `@sandbar-sdk/adapter`, or the definition/config/credentials connection form directly.

The unpublished `sandbar-sdk/daytona` and `sandbar-sdk/e2b` subpaths are removed without aliases. Update imports and install the selected adapter. Provider IDs, configuration defaults, resource identity, references, recovery and execution semantics remain unchanged.

## Support and implementation scope

Daytona and E2B remain first-class official integrations maintained in this monorepo. Separate installation does not imply experimental or community support. Implementation, deterministic fixture qualification, packed qualification and live qualification remain distinct statuses.

Modal remains separately installed and experimental, with its existing release status unchanged. Its private version-sensitive transport, uncertain image-build recovery and unrun live scenarios remain documented limitations. It is not a 1.0 release gate.

boxd (#82) and Vercel (#93) are implemented and included in the initial release group; boxd retains its experimental support status. Vercel provides disposable immutable sessions, bounded binary execution and compute stop with retained named metadata. Its [provider README](../packages/providers/vercel/README.md) records REST stability and unrun live qualification; [boxd](../packages/providers/boxd/README.md) records its scoped live baseline. Islo and Tensorlake remain candidates for further research; [the roadmap](../ROADMAP.md) owns sequencing. The fake provider remains a deterministic development fixture.

## Dependency and schema ownership

`sandbar-sdk` contains the provider-neutral consumer API and execution engine. It must not depend on provider packages or native provider libraries. Each adapter owns its native production dependencies; E2B's native `e2b` dependency belongs only to `@sandbar-sdk/e2b`.

`@sandbar-sdk/adapter` owns portable definitions, image inputs and the provider-neutral binding contract/helper. It must not depend on the SDK or native libraries. Adapters must not depend on the SDK at runtime. There is no catch-all public contracts package.

Private implementation workspaces may be bundled into adapter artifacts. Their unpublished names must not leak into runtime imports or declarations. Daytona bundles private SPI implementation and vendors required declarations; do not publish SPI to satisfy packaging.

## Implementation and release acceptance

The initial 0.1.0 fixed, lockstep public release group is `@sandbar-sdk/adapter`, `sandbar-sdk`, `@sandbar-sdk/daytona`, `@sandbar-sdk/e2b`, `@sandbar-sdk/boxd`, `@sandbar-sdk/boat`, and `@sandbar-sdk/vercel`; `@sandbar-sdk/cli` joins the group from its first release. Separate installation does not require independent release infrastructure. Keep the existing release machinery and release the actual distributable graph. Modal remains outside this group.

Qualify real tarballs in isolated consumers: core alone, core plus each released provider, combined Daytona/E2B, and an independently authored adapter. Verify strict NodeNext declarations, Node/Bun execution, private-workspace isolation and npm/pnpm/Bun installation. Archive overrides may resolve transitive local packages without adding undeclared root dependencies.

Unpublished API removal does not weaken scope, binary fidelity, validation, abort/close or unknown/no-replay guarantees. Never automatically delete user data. Effect remains parked.
