# TypeScript resource SDK

`sandbar-sdk` uses an installed adapter in the caller's server-side Node.js or Bun process. The implemented built-in Daytona adapter is available from `sandbar-sdk/daytona`. The experimental Modal integration is installed separately as `sandbar-modal` and uses the same public adapter contract as custom integrations. `sandbar-service/client` uses the Sandbar service over HTTP. The fake provider is a deterministic test fixture. Live provider qualification remains separate from the packaged API shape.

```ts
import { Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

const sandbar = await Sandbar.connect(daytona({ apiKey: process.env.DAYTONA_API_KEY!, target: "us" }));
await sandbar.close();
```

```ts
import { Sandbar, Image } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

const sandbar = await Sandbar.connect(daytona({ apiKey: process.env.DAYTONA_API_KEY!, target: "us" }));
try {
  const box = await sandbar.sandboxes.create({ environment: Image.prepared("your-snapshot-id") });
  const result = await box.exec(["printf", "hello"]);
  console.log(result.stdoutText(4096));
  await box.destroy();
} finally {
  await sandbar.close();
}
```

Direct construction imports no service, database, Hono or Drizzle code. Provider credentials remain in the caller's process and are inappropriate for browser code. The repository's deterministic fake provider is an internal test fixture and is not published with the SDK.

```ts
import { Sandbar, Image } from "sandbar-service/client";

const sandbar = Sandbar.connect({ url: "https://sandbar.example/", token: process.env.SANDBAR_TOKEN!, projectId: "my_project" });
const box = await sandbar.sandboxes.create({ environment: Image.prepared("your-image-id") });
await box.destroy();
await sandbar.close();
```

`exec` and `submitExec` accept a `readonly string[]` shorthand, such as `box.exec(["git", "status"])`. Each element is a literal argument; arrays never invoke a shell. The shorthand uses the same validation and defaults as `{ command: { kind: "argv", argv } }`, including rejection of empty arrays. Use the object form for `cwd`, `env`, deadlines, output limits, or an explicit `{ kind: "shell", script }` command. Arguments are copied before dispatch.

`exec` returns exact `Uint8Array` stdout/stderr. A nonzero exit throws `NonzeroExitError` with the captured result; a completed execution with no exit code throws `NoExitCodeError`. Transport errors and unknown effects use separate errors. `stdoutText(maxBytes)` and `stderrText(maxBytes)` are bounded UTF-8 display helpers. File reads and writes are currently buffered to 1 MiB.

`submitCreate` and `box.submitExec` return operation handles with `reference`, `observe()`, and `wait({ signal })`. Ordinary `create` and `exec` call `wait` themselves. A direct operation has `durability: "process"`; a remote operation has `durability: "service"`. An abort signal stops waiting, not provider compute. If it fires after an ordinary mutation was submitted, `WaitAbortedError` carries the recovery reference and original abort reason. `close()` releases client-owned state and never destroys a sandbox; call `box.destroy()` explicitly.

References are versioned, serializable, and contain no credentials, command, environment, or file bytes. A direct reference records verified native scope, submission identity, and any required locator. The caller must separately configure a provider with the same scope to import it through `recover(reference)`. A remote reference is bound to the service URL and project. Recovery only observes; it never submits the mutation again. If native submission discovery is unavailable, an unknown effect remains unknown. Applications requiring a durable submission marker can use the optional `client.operations.prepare(...).submit(..., { beforeSubmit })` lifecycle, then persist pending-token updates and use observation-only recovery. This SDK does not create a local database or background service.

`await client.capabilities()` and `await box.capabilities()` return dated, detached observations that retain command, image, network, and file facts. State support has four outcomes: `supported`, `unsupported`, `unavailable`, and `unknown`. `await client.sandboxes.checkCreate(input)` and `await box.checkSnapshot(request)` are read-only checks in direct and service mode. They never build images, reserve compute, stop a sandbox, or submit a capture. A supported check resolves a single profile with exact preservation, bounded interruption, source state, consistency, mount handling, and retention evidence; it is not a reservation. Snapshot restore and volume operations report provider-specific support independently.

Creation can require snapshot guarantees with `requirements: { snapshot: { requirements: { preserve: "filesystem" } } }`. `box.snapshot()` accepts the configured native default; optional requirements reject unsupported guarantees before effects. Daytona container capture stops/captures/restarts and preserves the filesystem with fresh restore execution. E2B capture preserves filesystem and memory. Unsupported combinations fail before allocation with `UNSUPPORTED` and `effect: "none"`; unavailable or unknown evidence fails with `UNAVAILABLE`. The mutation revalidates its plan before submission.

Snapshot handles expose inspect and separately supported restore/delete operations. Volume handles expose native management and create-time mount descriptors. Daytona supports restore and verified mounts; E2B restore, snapshot deletion and mounts remain unsupported because the pinned API cannot bind them to immutable native identities. Writable mounted compute needs explicit `storage: "allow-unconfirmed"` cleanup when shutdown durability cannot be established; destroy never deletes independently retained storage. The service does not expose these state mutations. Provider capabilities and live qualification remain separate evidence.

`ResourceReference` is the version-1 schema for resource identity, separate from an operation recovery reference. It supports sandbox, image, snapshot, volume, volume-version, mount, and session kinds, with verified provider scope, native locator, optional native generation, and ownership evidence (`borrowed`, `verified-created`, or `unknown`). Service bindings include URL, project, and connection. `validateResourceReference`, `assertResourceScope`, and `assertResourceIdentity` validate serialized data and known identity. An adapter must supply generation evidence when a locator can be reused; the SDK never invents a generation or treats a reference as authority. These descriptors do not open, inspect, or delete artifacts, and cannot certify expiry or native ownership by themselves.

Requirement reads finish before the durable submission marker; the approved preparation is then dispatched without another capability read. For already-stopped sources, an unchanged lifecycle request accepts a stopped outcome. Resource-reference service URLs are HTTP(S) endpoints and reject userinfo, queries, and fragments before serialization.

Tracing uses your application’s OpenTelemetry provider. Set `tracing: false` to disable Sandbar spans and propagation, or inject `tracing: { tracerProvider }`. Sandbar never configures exporters or shuts down your provider. See the [tracing and safe diagnostics guide](https://sandbarsdk.dev/docs/observability/) for pinned Node/Bun recipes and local-only vendor evidence; metrics and structured logs are a later release.
