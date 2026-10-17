# Run OpenCode with Sandbar

Two small TypeScript applications run OpenCode inside a disposable Daytona or E2B sandbox:

- `hello` asks **“What is 2 + 2?”** and prints captured stdout/stderr. It does not create an answer file.
- `edit` uploads [message.txt](agent-edit-file/message.txt), asks OpenCode to replace `NAME` with `Sandbar`, then reads and displays the changed remote file. The local fixture stays unchanged.

Both use Sandbar's public SDK. Provider selection changes setup; the workflows use the same execution and file calls.

## Setup

Use **Bun 1.3.14** from the repository root:

```sh
bun install --frozen-lockfile
bun run build:packages
cp examples/.env.example examples/.env.local
```

Edit `examples/.env.local` with the credentials for your selected sandbox provider. The scripts explicitly load that file; it is ignored by Git.

| Provider | Required configuration | Image and network prerequisites |
| --- | --- | --- |
| Daytona | `DAYTONA_API_KEY`, `DAYTONA_TARGET`, `DAYTONA_SNAPSHOT` | An active Linux snapshot in your target region. `daytona-default` is selected on the connection; your organization's policy must permit GitHub release downloads and model endpoints. |
| E2B | `E2B_API_KEY`; optional `E2B_TEMPLATE_ID` (default `base`) | A ready Linux template. Creation explicitly requests `internet`. |

The guest image needs glibc-based Linux on x64 or arm64, `curl`, `tar`, `sha256sum`, `/bin/sh`, Python 3 and the adapter's standard shell/file utilities; see the [Daytona](../apps/docs/src/content/docs/docs/providers/daytona.md#image-requirements) and [E2B](../apps/docs/src/content/docs/docs/providers/e2b.md#files-and-commands) guides. The guest working directory is `/tmp/sandbar-agent-example`. OpenCode is installed under its `opencode/` subdirectory. Installation downloads the pinned standalone binary from GitHub releases (the x64 baseline build avoids an AVX2 requirement) and verifies its pinned SHA-256 digest before extraction. It requires outbound GitHub access; model execution needs access to the selected model service.

## Model selection

The helper pins **OpenCode `1.18.35`** and explicitly selects **`opencode/nemotron-3.5-lightning-free`** by default. This model is listed in OpenCode's current public catalog and [Zen documentation](https://opencode.ai/docs/zen/) as an anonymous free option (checked October 10, 2026). No model API key is required for this default. Availability can change; override `OPENCODE_MODEL` when selecting another supported model.

```dotenv
OPENCODE_MODEL=opencode/nemotron-3.5-lightning-free
```

The deprecated `exo-free` model is not used.

Sandbox credentials stay on the host. For a keyed model, set `OPENCODE_MODEL` to its `provider/model-id` and set `OPENCODE_API_KEY_ENV` to the name of its credential variable, for example:

```dotenv
OPENCODE_MODEL=anthropic/your-model-id
OPENCODE_API_KEY_ENV=ANTHROPIC_API_KEY
ANTHROPIC_API_KEY=your-model-key
```

The chosen model key is accessible to agent tools inside the sandbox; use a scoped, short-lived key for these trusted demo prompts.

Use an available model ID accepted by the pinned OpenCode version. The helper copies only that named model key into the guest; it rejects sandbox credential names. Model service charges depend on your selected model; sandbox compute can incur provider charges even with an anonymous free model.

## Run

Choose either provider for either example:

```sh
bun run --cwd examples hello --provider daytona
bun run --cwd examples edit --provider daytona
bun run --cwd examples hello --provider e2b
bun run --cwd examples edit --provider e2b
```

Each invocation creates one new sandbox. `hello` prints the agent's answer, normally containing `4`; model wording and CLI decoration can vary. `edit` prints agent output followed by the exact file contents:

```text
Hello, Sandbar!
```

The file example fails if the returned file differs from `Hello, Sandbar!\n`. Captured agent stdout and stderr are forwarded to the corresponding local streams. Installation has a 16 KiB output bound; agent output has a 64 KiB bound, and truncated output fails the example.

## Lifecycle and validation

OpenCode uses [`run --pure`](https://opencode.ai/docs/cli/) with editing permissions enabled inside the disposable sandbox, sharing disabled and automatic updates disabled. Its configuration/data/cache/state directories live under the example working directory.

The sandbox lifetime is 600 seconds. Installation and agent calls have 120-second and 180-second deadlines, with a 480-second overall workflow wait. These bounds do not establish remote process termination at a deadline. Each entrypoint uses `client.sandboxes.with(setup.create, callback, { signal: run.signal })` to own one sandbox. Ctrl+C aborts local callback waiting and attempts destruction with a fresh 30-second cleanup budget, then the example closes its caller-owned client with a separate 5-second wait. The callback passes the work signal into all SDK calls; a callback ignoring cancellation can continue after local waiting ends. `SandboxCleanupError` preserves the completed callback value or original failure, cleanup failure, known sandbox identity and destroy recovery reference. The reporter serializes work and cleanup operation references separately; investigate them without automatically replaying uncertain work. Scope cleanup honors the connection's storage policy and never deletes retained volumes or snapshots. Manual create/destroy remain available.

Live acceptance passed on October 10, 2026 at source revision `1446cf0a013a6a2b49a65f7c419dabc3b67302bf`, using host Bun 1.3.14, standalone OpenCode 1.18.35 and anonymous `opencode/nemotron-3.5-lightning-free`:

| Provider | Passing configuration | Verified results |
| --- | --- | --- |
| Daytona | Existing `daytona-small` snapshot, `us` target, `daytona-default` network | Answer contained `4`; remote file was exactly `Hello, Sandbar!\n`. |
| E2B | Existing `base` template, `internet` network | Answer contained `4`; remote file was exactly `Hello, Sandbar!\n`. |

The live harness imported the actual `hello`, `edit`, installation, provider setup and cleanup functions and ran both workflows sequentially in one owned sandbox per provider. It did not rerun all four standalone CLI invocations above. Initial attempts using npm failed because Daytona lacked npm and E2B's npm install exited 137; the corrected standalone installer passed. All four allocated sandboxes, including those initial attempts, were independently confirmed deleted by provider GET responses returning 404. These results qualify these workflows and configurations at that revision. Offline fixtures cover SDK wiring and failure cleanup; future live sandbox runs require separate authorization.

For offline checks after package builds:

```sh
bun run --cwd examples check
bun run --cwd examples test
```
