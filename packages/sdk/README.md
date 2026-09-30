# TypeScript resource SDK

`sandbar-sdk` runs in your server-side Node.js or Bun process, with built-in Daytona and E2B entrypoints. Packages are not yet published. Keep provider credentials on the server.

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

const sandbar = await Sandbar.connect(daytona({
  apiKey: process.env.DAYTONA_API_KEY!,
  target: "us",
  networkPolicy: "daytona-default",
}));
try {
  const box = await sandbar.sandboxes.create({
    environment: Image.prepared("daytona-small"),
    networkPolicy: "daytona-default",
  });
  try {
    console.log((await box.exec(["printf", "hello"])).stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await sandbar.close();
}
```

`close()` releases the connection; it never destroys compute. Argument arrays pass literal arguments without a shell. Output is binary, with bounded text helpers; file transfers are buffered to 1 MiB. See [Getting started](https://sandbarsdk.dev/docs/direct-quickstart/), [execution](https://sandbarsdk.dev/docs/guides/resources/) and [files](https://sandbarsdk.dev/docs/guides/files-and-output/).

Direct connections expose snapshot capture/restore/delete and retained volume management. `box.snapshot()` accepts the native default: Daytona stops/captures/restarts with fresh processes; E2B pauses/resumes and retains RAM/process state. Restore requires a supported explicit network policy. Daytona supports writable create-time mounts; E2B private-beta volume CRUD is mapped but live create validation is blocked by account HTTP 403, and mounts are unsupported separately. External-mount capture, mounted restore, read-only mounts and volume versions are unsupported. Writable mounted compute requires `destroy({ storage: "allow-unconfirmed" })`, which does not guarantee flush or durability. Volumes need separate deletion. Use the [snapshots and volumes guide](https://sandbarsdk.dev/docs/guides/snapshots-and-volumes/) for examples and limits.

Persist resource and operation references as versioned JSON in your application's storage. Reopen with current credentials for the same verified scope; E2B key rotation needs verified `teamId`. Recovery observes without replay; explicit continuation can advance only a proven never-submitted next stage. Currently `onReference` requires the explicit adapter connection form, and partial recovery can require opaque provider tokens. Typed outcomes and bound-connection persistence are [active follow-up work](../../specs/sdk-recovery-dx.md). Follow [Errors and recovery](https://sandbarsdk.dev/docs/guides/recovery/).

Use [provider support](https://sandbarsdk.dev/docs/providers/support/) for evidence and [the TypeScript reference](https://sandbarsdk.dev/docs/reference/typescript/) for API details. Historical snapshot workflows and Daytona mounted persistence passed on premerge `5db0558`; those runs do not certify later merged fixes.

Direct construction imports no service or database. `sandbar-service/client` is the separate HTTP client and has no snapshot/volume endpoints. Experimental Modal uses the separately installed `sandbar-modal` adapter; the fake provider is an internal deterministic fixture. Tracing uses your application's OpenTelemetry provider without configuring exporters; see [tracing and diagnostics](https://sandbarsdk.dev/docs/observability/).
