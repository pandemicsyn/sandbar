# Modal provider adapter

Status: **implemented safe subset; deterministic fixtures only; live unverified**. This package uses the official `modal@0.10.1` JavaScript SDK. It does not require Python, Hono, SQL, or a Sandbar service in direct mode.

```ts
import { Sandbar, Image } from "@sandbar/sdk/direct";
import { modalProvider } from "@sandbar/provider-modal";

const provider = await modalProvider({
  tokenId: process.env.MODAL_TOKEN_ID!,
  tokenSecret: process.env.MODAL_TOKEN_SECRET!,
  appName: "my-existing-app",
  environment: "main",
  region: "us-east-1",
  timeoutSeconds: 300,
});
const client = Sandbar.direct({ provider });
const box = await client.sandboxes.create({
  environment: Image.prepared("im-existing-modal-image-id"),
  networkPolicy: "blocked",
  region: "us-east-1",
});
try {
  console.log(await box.inspect());
  // Binary file reads work, up to 1 MiB.
  console.log(await box.readFile("/tmp/result.bin"));
} finally {
  await box.destroy();
  await client.close();
}
```

The provider factory returns an owned lease. `client.close()` releases it and stops Sandbar waits; neither action destroys a provider sandbox. In Modal 0.10.1, `ModalClient.close()` does not actively close its gRPC channels or abort calls already in flight, so it is not a remote cancellation guarantee.

For service registration, `modalRegistration` accepts encrypted connection credentials `{tokenId,tokenSecret}` and explicit native configuration `{appName,environment,region?,timeoutSeconds?}`. `timeoutSeconds` is a decimal string in the service map. The service supplies its stored connection ID; the returned scope pins that ID to the verified native App, environment and endpoint. The registration factory contains no service-runtime imports.

The deployed Modal App and prepared image must already exist. `modalProvider` looks up the App without `createIfMissing`. The server returned App ID, configured environment and official endpoint bind the native scope. The SDK does not expose a verified workspace ID, so this adapter makes no workspace identity claim. Region is explicit when configured. The SDK's `endpoint` constructor option is unused in 0.10.1; custom endpoints and profile endpoint overrides fail closed. Credential strings are never placed in resource or recovery references.

Only an existing `im-` image ID is supported. `Image.oci(...)` is rejected before sandbox creation. Modal's registry image resolves/builds during `sandboxes.create()`, which can incur cost; it is not a pure `prepare` check. The adapter creates V2 sandboxes with `blockNetwork: true`, a unique submission name and tags, and a configured native timeout. It does not create secrets, volumes or apps. Destroy terminates compute; prepared images remain owned by their existing Modal lifecycle.

The pinned SDK automatically retries task-router `execStart` and its filesystem write helper after transient errors, without exposing the execution locator or a public no-retry switch. Therefore `exec` and `writeFile` currently return `unsupported` before any provider mutation. `writeFile(overwrite:false)` also cannot be enforced by Modal's unconditional overwrite helper. This subset is intentionally not advertised as full Sandbar resource parity. A future version-pinned task-router transport must prove single submission, exact binary output, deadline and no-clobber semantics before enabling those operations. No live Modal calls, paid builds or sandboxes have been run for qualification.

The narrow transport extension would obtain authenticated task-router access from the control plane, persist a caller generated execution UUID before `TaskExecStart`, send that RPC exactly once, and retain its task/execution locator. It would observe process status and stdout/stderr from byte offsets without starting another command, enforce a cumulative output bound, and validate the deadline and exit code. The task-router API and protobuf messages are private Modal interfaces, so this requires a version guard, vendored minimal wire schemas and local server fixtures for retries, lost responses, restart and truncated output. Write support separately needs a verified atomic no-clobber path for `overwrite:false`; Modal's FS helper exposes only unconditional `WriteFile`.

Modal's control-plane retry middleware performs three automatic retries by default even if the documented constructor `maxRetries:0` is passed. This package's public `grpcMiddleware` forwards `retries:0` to the built-in middleware. A local fake gRPC fixture demonstrated four outbound create attempts with only `maxRetries:0`, and one each for guarded App lookup, create and terminate calls. The package checks the SDK version before provider IO. Ambiguous create and terminate responses remain `unknown`; the adapter never resubmits them. Create recovery may discover an **active** sandbox by its unique native name and matching tags. Absence is not proof of no effect, and expired or terminated sandboxes may be unobservable. Direct recovery references survive a client restart only for this observable create subset.

The source audit used npm `modal@0.10.1`, published from gitHead `47e7703e25fcec5f4dc16f7aa7c691be8c85f72c` (tarball integrity `sha512-nnsWoVZ4XNLHtCV5/wuu2avQsFkGK6e/KazGPil3VwXI1aKh8jJkpP++lMPKwKQhMpe4N6WJtSRR6NwiolCEkw==`). Relevant upstream references: [SDK overview](https://modal.com/docs/sdk/js/latest), [Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox), [App lookup source](https://github.com/modal-labs/modal-client/blob/main/js/src/app.ts), [sandbox source](https://github.com/modal-labs/modal-client/blob/main/js/src/sandbox.ts), [task-router source](https://github.com/modal-labs/modal-client/blob/main/js/src/task_command_router_client.ts), and [filesystem source](https://github.com/modal-labs/modal-client/blob/main/js/src/sandbox_fs.ts). The GitHub `main` source is used only to explain behavior; the pinned npm bundle and declarations are the implementation authority.

## Opt-in live check

`bun run --cwd packages/providers/modal test:live` is deliberately gated by `SANDBAR_MODAL_LIVE=1` and `SANDBAR_MODAL_BUDGET_ACK="one sandbox, at most 300 seconds"`. It also requires `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `SANDBAR_MODAL_APP`, `SANDBAR_MODAL_ENVIRONMENT`, `SANDBAR_MODAL_REGION`, and `SANDBAR_MODAL_IMAGE_ID`. It creates at most one sandbox, sets a 300-second native timeout and attempts termination in `finally`. A failed create may have had an effect even if no handle was returned; preserve the emitted recovery reference and inspect Modal before any new run. The harness cannot enforce a dollar ceiling, so configure a provider-side spend alert or limit separately. This check has **not** been run; it requires separate live-use authorization and real credentials.
