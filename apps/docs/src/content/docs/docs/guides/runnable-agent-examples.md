---
title: Runnable agent examples
description: Run OpenCode inside a Daytona or E2B sandbox, capture its answer, or edit a remote file.
---

Run two small TypeScript applications from the Sandbar checkout. They use the same public execution and file API with either official provider:

| Workflow | What it does                                                                                                                                | Source                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `hello`  | Asks OpenCode “What is 2 + 2?” and prints captured stdout/stderr.                                                                           | [Hello application](https://github.com/pandemicsyn/sandbar/blob/main/examples/agent-hello-world/main.ts)   |
| `edit`   | Uploads `message.txt`, asks OpenCode to replace `NAME` with `Sandbar`, and reads back `Hello, Sandbar!`. The local fixture stays unchanged. | [File-edit application](https://github.com/pandemicsyn/sandbar/blob/main/examples/agent-edit-file/main.ts) |

The [examples README](https://github.com/pandemicsyn/sandbar/blob/main/examples/README.md) is the full runbook, including model overrides, bounds, failure handling, and live acceptance provenance.

## Set up and run

Use **Bun 1.3.14** on the host. Packages are unpublished, so run from a checkout:

```sh
git clone https://github.com/pandemicsyn/sandbar.git
cd sandbar
bun install --frozen-lockfile
bun run build:packages
cp examples/.env.example examples/.env.local
```

Edit `examples/.env.local` with the selected provider's credentials. The scripts load this ignored file explicitly.

| Provider | Configuration                                              | Prerequisites                                                                                                                                                               |
| -------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daytona  | `DAYTONA_API_KEY`, `DAYTONA_TARGET`, `DAYTONA_SNAPSHOT`    | An active Linux snapshot in the target region. Connection and creation select `daytona-default`; organization policy must permit GitHub release downloads and model access. |
| E2B      | `E2B_API_KEY`; optional `E2B_TEMPLATE_ID` (default `base`) | A ready Linux template; creation explicitly selects `internet`.                                                                                                             |

The guest needs glibc-based Linux on x64 or arm64, `curl`, `tar`, `sha256sum`, `/bin/sh`, Python 3, and the adapter's [Daytona shell/file utilities](/docs/providers/daytona/#image-requirements) or [E2B file prerequisites](/docs/providers/e2b/#files-and-commands). The helper downloads pinned standalone **OpenCode 1.18.35** from GitHub and verifies its pinned SHA-256 digest. It does not need npm in the guest.

Run either workflow with either provider:

```sh
bun run --cwd examples hello --provider daytona
bun run --cwd examples edit --provider daytona
bun run --cwd examples hello --provider e2b
bun run --cwd examples edit --provider e2b
```

Each invocation creates one sandbox and attempts destruction in `finally`, then closes the client. `hello` normally prints an answer containing `4`; `edit` verifies the exact returned file bytes `Hello, Sandbar!\n`.

## Model and lifetime

The explicit default is `opencode/nemotron-3.5-lightning-free`, an anonymous free model accepted in the recorded October 10, 2026 run. It needs no model API key. Availability can change; the README describes `OPENCODE_MODEL` and keyed-model overrides. Sandbox credentials stay on the host; only an explicitly named model key is forwarded to the guest. Sandbox compute can incur provider charges.

Sandbox lifetime is 600 seconds. Installation and agent deadlines are 120 and 180 seconds, with a 480-second overall workflow wait. Aborting a wait does not prove remote termination. Cleanup uses a separate 30-second destruction signal and 5-second client-close wait; failed cleanup reports the known sandbox ID. Uncertain operations retain a recovery reference and are not automatically replayed.

## Tested configurations

Live acceptance passed at `1446cf0a013a6a2b49a65f7c419dabc3b67302bf` on October 10, 2026 with host Bun 1.3.14, OpenCode 1.18.35 and the default anonymous model:

- Daytona: `daytona-small` snapshot, `us` target, `daytona-default` network.
- E2B: `base` template, `internet` network.

The harness imported the actual workflows and ran both sequentially in one sandbox per provider; it did not rerun all four standalone CLI invocations. Both answers contained `4` and both edited files matched exactly. All four allocations, including two earlier failed npm-install attempts, were independently confirmed deleted. See the [README acceptance record](https://github.com/pandemicsyn/sandbar/blob/main/examples/README.md#lifecycle-and-validation) for limits and provenance. This evidence covers those configurations and revision; it does not qualify arbitrary images or future model availability.
