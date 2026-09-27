# Modal provider adapter

Status: **create, exec, files, inspect, inventory and destroy implemented; deterministic fixtures and packed Node/Bun consumers tested; live unverified**. This package uses the official `modal@0.10.1` JavaScript SDK plus a version-pinned TaskCommandRouter wire subset. Direct SDK use does not require Hono, SQL or a Sandbar service.

```ts
import { Sandbar, Image } from "sandbar-sdk";
import { modalAdapter } from "@sandbar/provider-modal";

const client = await Sandbar.connect({
  adapter: modalAdapter,
  config: { appName: "my-existing-app", environment: "main", region: "us-east-1", timeoutSeconds: 300 },
  credentials: { tokenId: process.env.MODAL_TOKEN_ID!, tokenSecret: process.env.MODAL_TOKEN_SECRET! },
});
try {
  const box = await client.sandboxes.create({
    environment: Image.prepared("im-existing-modal-image-id"), networkPolicy: "blocked",
  });
  try {
    const result = await box.exec({ command: { kind: "argv", argv: ["/bin/sh", "-c", "printf ready"] } });
    await box.writeFile("/tmp/result.bin", new Uint8Array([0, 255, 129]), { overwrite: false });
    console.log(result.exitCode, await box.readFile("/tmp/result.bin"));
  }
  finally { await box.destroy(); }
} finally { await client.close(); }
```

The adapter verifies the existing Modal App and registers an owned close hook. `client.close()` releases local resources and stops Sandbar waits; it does not destroy provider compute. Modal's transport cannot guarantee cancellation of an already submitted native call.

The standalone service installs `modalAdapter` by default. It keeps encrypted credentials and project binding; the adapter's verified scope pins the native App, environment, region, and fixed endpoint.

The deployed Modal App must already exist; a prepared image ID must exist when that image path is used. `modalAdapter` looks up the App without `createIfMissing`. The server returned App ID, configured environment and official endpoint bind the native scope. The SDK does not expose a verified workspace ID, so this adapter makes no workspace identity claim. Region is explicit when configured. Custom endpoints and profile endpoint overrides fail closed. Credential strings are never placed in resource or recovery references.

Prepared `im-` image IDs and `Image.oci("python:3.12-slim")` are supported. OCI validation in `prepare` is read-only. Inside one create submission, `fromRegistry` constructs the image, then Modal's `experimentalCreate` calls `image.build(app)` before `SandboxCreateV2`; image building may cost money. The adapter creates V2 sandboxes with `blockNetwork: true`, a unique submission name and tags, and a configured native timeout. It does not create secrets, volumes or apps. Destroy terminates compute; prepared and built images retain their existing Modal lifecycle. A lost image-build response can leave a paid image with no sandbox name to observe. The adapter reports unknown and never automatically retries or claims no effect. A lost sandbox-create response is observed by native name and matching tags when the sandbox remains active.

The pinned SDK automatically retries task-router `execStart` and its filesystem write helper after transient errors. Sandbar sends `TaskExecStart` and stdin writes through a narrow gRPC wire client without hidden mutation retries. The execution ID is a deterministic UUID derived from the original submission ID, so direct and service observation can reattach to that process without starting it again. Argv, shell, cwd, env, exit status, and binary stdout/stderr are supported with a combined 1 MiB output bound. Native exec timeouts constrain remote execution; abort and close stop local waits and transport calls, but do not promise remote process termination. After uncertain starts or writes, a missing process is unknown rather than proof of no effect.

File reads use the pinned SDK's read-only filesystem tool with a 1 MiB transfer cap. File writes stream raw bytes to a sandbox-side POSIX shell command and verify the original process's exit code and byte-count output. `overwrite:false` uses shell noclobber (`O_EXCL` for an absent regular target), so a concurrent writer cannot be overwritten; an already present target is rejected before submission. `overwrite:true` replaces the target. The sandbox image must provide `/bin/sh`, `cat`, `mkdir`, and `wc`. The standard `python:3.12-slim` image has these tools; arbitrary prepared images should be checked by their owner. A crash or lost response while stdin is incomplete can leave a partial file or a waiting process; observation never replays bytes. A successful write is confirmed only by the same process's exit and byte count. No live Modal calls, paid builds or sandboxes have been run for qualification.

The task-router API and protobuf messages are private Modal interfaces. `createSdkTransport` checks the exact SDK version and official control endpoint; a Modal upgrade requires a wire audit. Local gRPC fixtures exercise one outbound start after a lost response, binary output and stdin offsets, truncation, abort/close, and observation by the original execution ID. Public SDK fixtures cover create, exec and write recovery across a reopened connection. The service fixture covers normal HTTP exec/write/read with encrypted credentials. Packed strict-TypeScript and Node/Bun consumers cover the SDK subpath and direct fixture flow. These fixtures do not certify the real Modal service or every prepared image.

Modal's control-plane retry middleware performs three automatic retries by default even if the documented constructor `maxRetries:0` is passed. This package's public `grpcMiddleware` forwards `retries:0` to the built-in middleware. A local fake gRPC fixture demonstrated four outbound create attempts with only `maxRetries:0`, and one each for guarded App lookup, sandbox create, image build, and terminate calls. Ambiguous responses never trigger automatic mutation replay. Create recovery may discover an **active** sandbox by its unique native name and matching submission/operation tags. Destroy recovery polls the original native ID after a scope-checked submission and confirms success only when Modal reports it stopped; missing or running stays unknown. Absence is not proof of no effect, and expired or terminated sandboxes may be unobservable.

The source audit used npm `modal@0.10.1`, published from gitHead `47e7703e25fcec5f4dc16f7aa7c691be8c85f72c` (tarball integrity `sha512-nnsWoVZ4XNLHtCV5/wuu2avQsFkGK6e/KazGPil3VwXI1aKh8jJkpP++lMPKwKQhMpe4N6WJtSRR6NwiolCEkw==`). Relevant upstream references: [SDK overview](https://modal.com/docs/sdk/js/latest), [Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox), [App lookup source](https://github.com/modal-labs/modal-client/blob/main/js/src/app.ts), [sandbox source](https://github.com/modal-labs/modal-client/blob/main/js/src/sandbox.ts), [task-router source](https://github.com/modal-labs/modal-client/blob/main/js/src/task_command_router_client.ts), and [filesystem source](https://github.com/modal-labs/modal-client/blob/main/js/src/sandbox_fs.ts). The GitHub `main` source is used only to explain behavior; the pinned npm bundle and declarations are the implementation authority.

## Opt-in live check

`bun run --cwd packages/providers/modal test:live` is deliberately gated by `SANDBAR_MODAL_LIVE=1` and `SANDBAR_MODAL_BUDGET_ACK="one sandbox, at most 300 seconds"`. It also requires `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `SANDBAR_MODAL_APP`, `SANDBAR_MODAL_ENVIRONMENT`, `SANDBAR_MODAL_REGION`, and `SANDBAR_MODAL_IMAGE_ID`. It creates at most one sandbox, sets a 300-second native timeout and attempts termination in `finally`. A failed create may have had an effect even if no handle was returned; preserve the emitted recovery reference and inspect Modal before any new run. The harness cannot enforce a dollar ceiling, so configure a provider-side spend alert or limit separately. This check has **not** been run; it requires separate live-use authorization and real credentials.
