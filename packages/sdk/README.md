# TypeScript resource SDK

`sandbar-sdk/direct` uses a provider driver in the caller's server-side Node.js or Bun process. `sandbar-sdk/remote` uses the Sandbar service over HTTP. Both expose the same resource flow. The fake provider is the initial verified implementation; it is a simulation, not an OCI importer or evidence of real-provider support.

```ts
import { Sandbar, Image } from "sandbar-sdk/direct";
import { fakeProvider } from "@sandbar/provider-fake/client";

const sandbar = Sandbar.direct({
  provider: await fakeProvider({ url: process.env.FAKE_PROVIDER_URL!, token: process.env.FAKE_PROVIDER_TOKEN! }),
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
import { Sandbar, Image } from "sandbar-sdk/remote";

const sandbar = Sandbar.connect({ url: "https://sandbar.example/", token: process.env.SANDBAR_TOKEN!, projectId: "my_project" });
const box = await sandbar.sandboxes.create({ environment: Image.prepared("fake-starter") });
await box.destroy();
await sandbar.close();
```

`exec` and `submitExec` accept a `readonly string[]` shorthand, such as `box.exec(["git", "status"])`. Each element is a literal argument; arrays never invoke a shell. The shorthand uses the same validation and defaults as `{ command: { kind: "argv", argv } }`, including rejection of empty arrays. Use the object form for `cwd`, `env`, deadlines, output limits, or an explicit `{ kind: "shell", script }` command. Arguments are copied before dispatch.

`exec` returns exact `Uint8Array` stdout/stderr. A nonzero exit throws `NonzeroExitError` with the captured result; a completed execution with no exit code throws `NoExitCodeError`. Transport errors and unknown effects use separate errors. `stdoutText(maxBytes)` and `stderrText(maxBytes)` are bounded UTF-8 display helpers. File reads and writes are currently buffered to 1 MiB.

`submitCreate` and `box.submitExec` return operation handles with `reference`, `observe()`, and `wait({ signal })`. Ordinary `create` and `exec` call `wait` themselves. A direct operation has `durability: "process"`; a remote operation has `durability: "service"`. An abort signal stops waiting, not provider compute. If it fires after an ordinary mutation was submitted, `WaitAbortedError` carries the recovery reference and original abort reason. `close()` releases client-owned state and never destroys a sandbox; call `box.destroy()` explicitly.

References are versioned, serializable, and contain no credentials, command, environment, or file bytes. A direct reference records verified native scope, submission identity, and any required locator. The caller must separately configure a provider with the same scope to import it through `recover(reference)`. A remote reference is bound to the service URL and project. Recovery only observes; it never submits the mutation again. If native submission discovery is unavailable, an unknown effect remains unknown. A process can crash after submission and before returning a reference; callers needing guaranteed crash recovery must use the service or arrange their own before-submit handoff. This SDK does not create a local database or background service.
