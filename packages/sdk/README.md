# TypeScript resource SDK

`sandbar-sdk` uses an installed adapter in the caller's server-side Node.js or Bun process. Implemented first-party adapter imports are `sandbar-sdk/daytona` and `sandbar-sdk/modal`; both are included in the SDK package and use the same public adapter contract as custom integrations. `sandbar-service/client` uses the Sandbar service over HTTP. The fake provider is a deterministic test fixture. Live provider qualification remains separate from the packaged API shape.

```ts
import { Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

const sandbar = await Sandbar.connect(daytona({ apiKey: process.env.DAYTONA_API_KEY!, target: "us" }));
await sandbar.close();
```

```ts
import { Sandbar, Image } from "sandbar-sdk";
import { createFakeAdapter } from "@sandbar/provider-fake";

const sandbar = await Sandbar.connect({
  adapter: createFakeAdapter({ url: process.env.FAKE_PROVIDER_URL!, token: process.env.FAKE_PROVIDER_TOKEN! }),
  config: {}, credentials: {},
});
try {
  const box = await sandbar.sandboxes.create({ environment: Image.prepared("fake-starter") });
  await box.writeFile("/input.bin", Uint8Array.of(0, 255));
  const bytes = await box.readFile("/input.bin");
  const result = await box.exec(["fixture", "hello"]);
  console.log(result.stdoutText(4096), bytes.length);
  await box.destroy();
} finally {
  await sandbar.close();
}
```

The independent fake service must be running for this fixture. Its command fixtures must be seeded in test mode before `exec`; the SDK does not start the fake server. Direct construction imports no service, database, Hono or Drizzle code. Provider credentials remain in the caller's process and are inappropriate for browser code.

```ts
import { Sandbar, Image } from "sandbar-service/client";

const sandbar = Sandbar.connect({ url: "https://sandbar.example/", token: process.env.SANDBAR_TOKEN!, projectId: "my_project" });
const box = await sandbar.sandboxes.create({ environment: Image.prepared("fake-starter") });
await box.destroy();
await sandbar.close();
```

`exec` and `submitExec` accept a `readonly string[]` shorthand, such as `box.exec(["git", "status"])`. Each element is a literal argument; arrays never invoke a shell. The shorthand uses the same validation and defaults as `{ command: { kind: "argv", argv } }`, including rejection of empty arrays. Use the object form for `cwd`, `env`, deadlines, output limits, or an explicit `{ kind: "shell", script }` command. Arguments are copied before dispatch.

`exec` returns exact `Uint8Array` stdout/stderr. A nonzero exit throws `NonzeroExitError` with the captured result; a completed execution with no exit code throws `NoExitCodeError`. Transport errors and unknown effects use separate errors. `stdoutText(maxBytes)` and `stderrText(maxBytes)` are bounded UTF-8 display helpers. File reads and writes are currently buffered to 1 MiB.

`submitCreate` and `box.submitExec` return operation handles with `reference`, `observe()`, and `wait({ signal })`. Ordinary `create` and `exec` call `wait` themselves. A direct operation has `durability: "process"`; a remote operation has `durability: "service"`. An abort signal stops waiting, not provider compute. If it fires after an ordinary mutation was submitted, `WaitAbortedError` carries the recovery reference and original abort reason. `close()` releases client-owned state and never destroys a sandbox; call `box.destroy()` explicitly.

References are versioned, serializable, and contain no credentials, command, environment, or file bytes. A direct reference records verified native scope, submission identity, and any required locator. The caller must separately configure a provider with the same scope to import it through `recover(reference)`. A remote reference is bound to the service URL and project. Recovery only observes; it never submits the mutation again. If native submission discovery is unavailable, an unknown effect remains unknown. Applications requiring a durable submission marker can use the optional `client.operations.prepare(...).submit(..., { beforeSubmit })` lifecycle, then persist pending-token updates and use observation-only recovery. This SDK does not create a local database or background service.
