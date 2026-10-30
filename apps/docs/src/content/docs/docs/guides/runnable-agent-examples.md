---
title: Runnable agent examples
description: Run OpenCode inside a Daytona or E2B sandbox, capture its answer, edit a remote file, or attach to an OpenCode 2 server in a box.
---

Run these small TypeScript applications from the Sandbar checkout. They use the same public execution and file API with either official provider:

| Workflow | What it does                                                                                                                                | Source                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `hello`  | Asks OpenCode “What is 2 + 2?” and prints captured stdout/stderr.                                                                           | [Hello application](https://github.com/pandemicsyn/sandbar/blob/main/examples/agent-hello-world/main.ts)   |
| `edit`   | Uploads `message.txt`, asks OpenCode to replace `NAME` with `Sandbar`, and reads back `Hello, Sandbar!`. The local fixture stays unchanged. | [File-edit application](https://github.com/pandemicsyn/sandbar/blob/main/examples/agent-edit-file/main.ts) |

The [examples README](https://github.com/pandemicsyn/sandbar/blob/main/examples/README.md) is the full runbook, including model overrides, bounds, failure handling, and live acceptance provenance.

## Set up and run

Use **Bun 1.3.14** on the host. These examples live in the repository, so run them from a checkout:

```sh
git clone https://github.com/pandemicsyn/sandbar.git
cd sandbar
bun install --frozen-lockfile
bun run build:packages
cp examples/.env.example examples/.env.local
```

Edit `examples/.env.local` with the selected provider's credentials. The scripts load this ignored file explicitly.

| Provider | Configuration                                              | Prerequisites                                                                                                                                                       |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daytona  | `DAYTONA_API_KEY`, `DAYTONA_TARGET`, `DAYTONA_SNAPSHOT`    | An active Linux snapshot in the target region. The connection selects `daytona-default`; organization policy must permit GitHub release downloads and model access. |
| E2B      | `E2B_API_KEY`; optional `E2B_TEMPLATE_ID` (default `base`) | A ready Linux template; creation explicitly selects `internet`.                                                                                                     |

The guest needs glibc-based Linux on x64 or arm64, `curl`, `tar`, `sha256sum`, `/bin/sh`, Python 3, and the adapter's [Daytona shell/file utilities](/docs/providers/daytona/#image-requirements) or [E2B file prerequisites](/docs/providers/e2b/#commands-and-files). The helper downloads pinned standalone **OpenCode 1.18.35** from GitHub and verifies its pinned SHA-256 digest. It does not need npm in the guest.

Run either workflow with either provider:

```sh
bun run --cwd examples hello --provider daytona
bun run --cwd examples edit --provider daytona
bun run --cwd examples hello --provider e2b
bun run --cwd examples edit --provider e2b
```

Each invocation creates one sandbox and attempts destruction in `finally`, then closes the client. `hello` normally prints an answer containing `4`; `edit` verifies the exact returned file bytes `Hello, Sandbar!\n`.

## OpenCode 2 in a box

The `box` example runs an OpenCode 2 server next to your project in a sandbox and attaches your local OpenCode 2 client to it. The agent's commands and edits happen in the sandbox; you drive it from your own terminal and pull the work back when you are done.

```sh
bun run --cwd examples box up --provider e2b --project ~/code/my-app
bun run --cwd examples box attach
bun run --cwd examples box pull
bun run --cwd examples box down
```

- `up` uploads your tracked and unignored files plus `.git` to the same path in the sandbox, starts `opencode2 serve` with a random password and waits until it is healthy.
- `attach` connects your local `opencode2 --server` through a localhost proxy that adds the provider's preview headers, so it works with Daytona's protected previews as well as E2B's public ones.
- `pull` copies the project back over your checkout, `.git` included, so the agent's commits show up in your `git log`. It refuses while your checkout has uncommitted changes unless you pass `--force`.
- `down` destroys the sandbox.

Set `GH_TOKEN` in `examples/.env.local` to let the agent push to GitHub from the sandbox; use a fine-grained token limited to the repository, since the agent can read it. Add `gh` to your image if the agent should open pull requests. The [examples README](https://github.com/pandemicsyn/sandbar/blob/main/examples/README.md#opencode-2-in-a-box) lists guest requirements and limits.

## Model and lifetime

The explicit default is `opencode/nemotron-3.5-lightning-free`, an anonymous free model accepted in the recorded October 10, 2026 run. It needs no model API key. Availability can change; the README describes `OPENCODE_MODEL` and keyed-model overrides. Sandbox credentials stay on the host; only an explicitly named model key is forwarded to the guest. Sandbox compute can incur provider charges.

Sandbox lifetime is 600 seconds. Installation and agent deadlines are 120 and 180 seconds, with a 480-second overall workflow wait. Aborting a wait does not prove remote termination. Cleanup uses a separate 30-second destruction signal and 5-second client-close wait; failed cleanup reports the known sandbox ID. Uncertain operations retain a recovery reference and are not automatically replayed.

## Tested configurations

Live acceptance passed at `1446cf0a013a6a2b49a65f7c419dabc3b67302bf` on October 10, 2026 with host Bun 1.3.14, OpenCode 1.18.35 and the default anonymous model:

- Daytona: `daytona-small` snapshot, `us` target, `daytona-default` network.
- E2B: `base` template, `internet` network.

The harness imported the actual workflows and ran both sequentially in one sandbox per provider; it did not rerun all four standalone CLI invocations. Both answers contained `4` and both edited files matched exactly. All four allocations, including two earlier failed npm-install attempts, were independently confirmed deleted. See the [README acceptance record](https://github.com/pandemicsyn/sandbar/blob/main/examples/README.md#lifecycle-and-validation) for limits and provenance. This evidence covers those configurations and revision; it does not qualify arbitrary images or future model availability.
