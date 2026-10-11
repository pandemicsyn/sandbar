# Public packages and adapter conventions

**Accepted user decision — October 11, 2026.** Daytona and E2B are separately installed, officially maintained integrations. This supersedes the September 27 bundled-provider decision. These packages remain unpublished; registry commands describe the intended release experience.

## Names and imports

| Purpose | npm package | Import path |
| --- | --- | --- |
| Provider-neutral SDK | `sandbar-sdk` | `sandbar-sdk` |
| Official Daytona adapter | `sandbar-daytona` | `sandbar-daytona` |
| Official E2B adapter | `sandbar-e2b` | `sandbar-e2b` |
| Experimental Modal adapter | `sandbar-modal` | `sandbar-modal` |
| Custom adapter authoring | `sandbar-adapter` | `sandbar-adapter` |
| Adapter conformance tests | included in `sandbar-adapter` | `sandbar-adapter/testing` |
| Future integrations | `sandbar-<provider>` | e.g. `sandbar-vercel` |

Use these unscoped public names; the occupied `sandbar` package is unrelated. Registry absence does not reserve a name or authorize publication. Third-party authors may use their own names/scopes, such as `@acme/sandbar-adapter`. Package names are independent of stable provider IDs (`daytona`, `e2b`, `modal`).

## Consumer experience

```sh
npm install sandbar-sdk sandbar-daytona
```

```ts
import { Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-daytona";

const sandbar = await Sandbar.connect(daytona({
  apiKey: process.env.DAYTONA_API_KEY!,
  target: "us",
}));
```

For E2B install `sandbar-sdk sandbar-e2b` and import `e2b` from `sandbar-e2b`. Factories package typed settings and credentials without provider IO. `Sandbar.connect` validates and verifies the binding and owns the session. Custom authors may use `bindAdapter` from `sandbar-adapter`, or the definition/config/credentials connection form directly.

The unpublished `sandbar-sdk/daytona` and `sandbar-sdk/e2b` subpaths are removed without aliases. Update imports and install the selected adapter. Provider IDs, configuration defaults, resource identity, references, recovery and execution semantics remain unchanged.

## Support and implementation scope

Daytona and E2B remain first-class official integrations maintained in this monorepo. Separate installation does not imply experimental or community support. Implementation, deterministic fixture qualification, packed qualification and live qualification remain distinct statuses.

Modal remains separately installed and experimental, with its existing release status unchanged. Its private version-sensitive transport, uncertain image-build recovery and unrun live scenarios remain documented limitations. It is not a 1.0 release gate.

Fast-follow priority remains **Vercel, Boxed (boxd), Islo, Tensorlake**. This decision does not authorize their implementation, placeholder exports, publication or paid operations. The fake provider remains a deterministic development fixture.

## Dependency and schema ownership

`sandbar-sdk` contains the provider-neutral consumer API and execution engine. It must not depend on provider packages or native provider libraries. Each adapter owns its native production dependencies; E2B's native `e2b` dependency belongs only to `sandbar-e2b`.

`sandbar-adapter` owns portable definitions, image inputs and the provider-neutral binding contract/helper. It must not depend on the SDK or native libraries. Adapters must not depend on the SDK at runtime. There is no catch-all public contracts package.

Private implementation workspaces may be bundled into adapter artifacts. Their unpublished names must not leak into runtime imports or declarations. Daytona bundles private SPI implementation and vendors required declarations; do not publish SPI to satisfy packaging.

## Implementation and release acceptance

The initial fixed, lockstep public release group is `sandbar-adapter`, `sandbar-sdk`, `sandbar-daytona`, and `sandbar-e2b`. Separate installation does not require independent release infrastructure. Keep the existing release machinery and release the actual distributable graph. Modal remains outside this group.

Qualify real tarballs in isolated consumers: core alone, core plus either provider, both providers, and an independently authored adapter. Verify strict NodeNext declarations, Node/Bun execution, private-workspace isolation and npm/pnpm/Bun installation. Archive overrides may resolve transitive local packages without adding undeclared root dependencies.

Unpublished API removal does not weaken scope, binary fidelity, validation, abort/close or unknown/no-replay guarantees. Never automatically delete user data. Effect remains parked.
