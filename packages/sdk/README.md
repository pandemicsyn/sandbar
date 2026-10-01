# TypeScript resource SDK

`sandbar-sdk` uses an installed adapter in the caller's server-side Node.js or Bun process. Built-in Daytona and E2B adapters are available from `sandbar-sdk/daytona` and `sandbar-sdk/e2b`. The experimental Modal integration is installed separately as `sandbar-modal` and uses the same public adapter contract as custom integrations. The fake provider is a deterministic test fixture. Live provider qualification remains separate from the packaged API shape.

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
  try {
    const result = await box.exec(["printf", "hello"]);
    console.log(result.stdoutText(4096));
  } finally {
    await box.destroy();
  }
} finally {
  await sandbar.close();
}
```

Provider credentials remain in the caller's process and are inappropriate for browser code. The repository's deterministic fake provider is an internal test fixture and is not published with the SDK.

`exec` and `submitExec` accept a `readonly string[]` shorthand, such as `box.exec(["git", "status"])`. Each element is a literal argument; arrays never invoke a shell. The shorthand uses the same validation and defaults as `{ command: { kind: "argv", argv } }`, including rejection of empty arrays. Use the object form for `cwd`, `env`, deadlines, output limits, or an explicit `{ kind: "shell", script }` command. Arguments are copied before dispatch.

`exec` returns exact `Uint8Array` stdout/stderr. A nonzero exit throws `NonzeroExitError` with the captured result; a completed execution with no exit code throws `NoExitCodeError`. Transport errors and unknown effects use separate errors. `stdoutText(maxBytes)` and `stderrText(maxBytes)` are bounded UTF-8 display helpers. File reads and writes are currently buffered to 1 MiB.

`submitCreate` and `box.submitExec` return operation handles with `reference`, `observe()`, and `wait({ signal })`. Ordinary `create` and `exec` call `wait` themselves. A direct operation has `durability: "process"`. An abort signal stops waiting, not provider compute. If it fires after an ordinary mutation was submitted, `WaitAbortedError` carries the recovery reference and original abort reason. `close()` releases client-owned state and never destroys a sandbox; call `box.destroy()` explicitly.

References are versioned, serializable, and contain no credentials, command, environment, or file bytes. A direct reference records verified native scope, submission identity, and any required locator. The caller must separately configure a provider with the same scope to import it through `recover(reference)`. Recovery only observes; it never submits the mutation again. If native submission discovery is unavailable, an unknown effect remains unknown. Applications requiring a durable submission marker can use the optional `client.operations.prepare(...).submit(..., { beforeSubmit, onCheckpoint })` lifecycle, where `onCheckpoint` durably saves each versioned token before the provider proceeds, then persist pending-token updates and use observation-only recovery. Advanced mutations that call `ctx.checkpoint()` stop if this callback is missing or fails.

`await client.capabilities()` and `await box.capabilities()` return dated, detached observations that retain command, image, network, and file facts. State support has four outcomes: `supported`, `unsupported`, `unavailable`, and `unknown`. `await client.sandboxes.checkCreate(input)` and `await box.checkSnapshot(request)` are read-only checks on SDK connections. They never build images, reserve compute, stop a sandbox, or submit a capture. A supported check resolves a single profile with exact preservation, bounded interruption, source state, consistency, mount handling, and retention evidence; it is not a reservation. Snapshot restore and volume operations report provider-specific support independently.

Creation can require snapshot guarantees with `requirements: { snapshot: { requirements: { preserve: "filesystem" } } }`. `box.snapshot()` accepts the configured native default; optional requirements reject unsupported guarantees before effects. Daytona container capture stops/captures/restarts and preserves the filesystem with fresh restore execution. E2B capture preserves filesystem and memory. Unsupported combinations fail before allocation with `UNSUPPORTED` and `effect: "none"`; unavailable or unknown evidence fails with `UNAVAILABLE`. The mutation revalidates its plan before submission.

Snapshot handles expose inspect and separately supported restore/delete operations. Volume handles expose native management and create-time mount descriptors. Daytona supports restore and verified mounts. E2B restores the saved native build UUID with `templateId:buildUUID` and cleans up its dedicated containing template after identity, scope and dependency checks; E2B mounts remain unsupported because the pinned API exposes reusable names without mounted native IDs. Writable mounted compute needs explicit `storage: "allow-unconfirmed"` cleanup when shutdown durability cannot be established; destroy never deletes independently retained storage. Provider capabilities and live qualification remain separate evidence.

`ResourceReference` is the version-1 schema for resource identity, separate from an operation recovery reference. It supports sandbox, image, snapshot, volume, volume-version, mount, and session kinds, with verified provider scope, native locator, optional native generation, and ownership evidence (`borrowed`, `verified-created`, or `unknown`). `validateResourceReference`, `assertResourceScope`, and `assertResourceIdentity` validate serialized data and known identity. An adapter must supply generation evidence when a locator can be reused; the SDK never invents a generation or treats a reference as authority. These descriptors do not open, inspect, or delete artifacts, and cannot certify expiry or native ownership by themselves.

Requirement reads finish before the durable submission marker; the approved preparation is then dispatched without another capability read. For already-stopped sources, an unchanged lifecycle request accepts a stopped outcome.

Tracing uses your application’s OpenTelemetry provider. Set `tracing: false` to disable Sandbar spans and propagation, or inject `tracing: { tracerProvider }`. Sandbar never configures exporters or shuts down your provider. See the [tracing and safe diagnostics guide](https://sandbarsdk.dev/docs/observability/) for pinned Node/Bun recipes and local-only vendor evidence; metrics and structured logs are a later release.


Persist resource and operation references as versioned JSON in your own application storage. Their historical observations do not depend on the original API key or a mandatory signature. Reopen with current credentials for the same verified native scope; E2B credential rotation requires verified `teamId` configuration. `onReference` is awaited before stage dispatches and when evidence changes. Observation stays read-only; explicit `operation.continue()` may advance a proven never-submitted next stage. Serialize continuation across processes through your own lease or compare-and-swap. E2B cleanup deletes the containing template, not an individual build, and rejects known shared expansion; the provider offers no transactional read/delete generation condition.

Empty restore resource and mount maps are equivalent to omitting those overrides. Snapshot and volume deletion persist a rejected stage when cancellation is known to precede native dispatch. The SDK allows up to one second after caller cancellation to join deletion finalization and surface a proven rejection with `effect: "none"`; client close remains immediate, and a stalled finalization still reports uncertainty. Other mutation waits retain their existing cancellation behavior.

Start with the [everyday SDK guides](https://sandbarsdk.dev/docs/guides/resources/) and [snapshots/volumes](https://sandbarsdk.dev/docs/guides/snapshots-and-volumes/). Save `captured.snapshot.reference` or `volume.reference` in application storage and reopen with `client.snapshots.get(...)` or `client.volumes.get(...)` on a fresh matching connection. Handles expose `provider` and `id`. Confirmed partial capture errors expose the snapshot reference and capture details through `SandbarError.outcome`; do not parse native tokens or repeat capture. The [compiled example](../../apps/docs/examples/recovery-outcomes.ts) demonstrates these paths. Existing checkpoint/continuation APIs are advanced compatibility paths, not a prerequisite for ordinary application persistence.

For explicit direct connection annotations, import `DirectSandbarClient` and `DirectSandboxHandle` from `sandbar-sdk`. They include `client.snapshots`, `client.volumes` and `sandbox.snapshot()`. `SandbarClient` and `SandboxHandle` are aliases for those complete SDK surfaces.

Malformed snapshot requests, restore requests, inventory inputs, volume creation inputs and mount descriptors reject with `SandbarError` (`INVALID_ARGUMENT`, effect `none`) before provider mutation. Restore preflight uses `UnsupportedFeatureError.unmetRequirements` to report network policy, sizing, independent lifecycle and mount limitations together. Native response validation remains separate from caller input errors.

`RestoreRequest.mounts` remains in the schema for compatibility. Nonempty share, replace and omit choices are currently unsupported, as are snapshots with mounts or unknown mount provenance. Omit `mounts` (or pass an empty object) and restore only snapshots with confirmed `mountHandling: "none"` and no recorded mounts. Independent lifecycle is required by default; `requireIndependentLifecycle: false` opts out of that requirement only.
