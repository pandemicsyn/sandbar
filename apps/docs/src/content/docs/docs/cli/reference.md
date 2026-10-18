---
title: Command reference
description: Every sandbar command, flag and exit code, generated from the CLI.
---

> Generated from `sandbar schema`. Run `bun run --cwd apps/docs cli:generate` after changing a command.

## Global flags

These work with every command.

| Flag                | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `--json`            | Print one JSON document on stdout (also SANDBAR_JSON=1)                      |
| `--profile <name>`  | Profile from sandbar.json (also SANDBAR_PROFILE)                             |
| `--provider <id>`   | Official provider from environment credentials (also SANDBAR_PROVIDER)       |
| `--config <path>`   | Config file (default ~/.config/sandbar/sandbar.json, also SANDBAR_CONFIG)    |
| `--state-dir <dir>` | State store folder (default ~/.config/sandbar/state, also SANDBAR_STATE_DIR) |

## Output

With `--json`, stdout holds exactly one document: `{ok:true,data}` or `{ok:false,error:{code,message,retryable,outcome,hint?,known?,details?}}`. Diagnostics always go to stderr.

`exec`, `sh` and `run` exit with the remote command's exit code; their JSON data is `{exitCode,stdout,stderr,truncated}`, and run adds sandbox `{name,id,kept}`.

## Exit codes

| Code | Meaning                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| 0    | success                                                                                                        |
| 1    | other failure                                                                                                  |
| 2    | usage error; fix the command                                                                                   |
| 3    | not found                                                                                                      |
| 4    | unsupported by this provider or profile, adapter or password-manager CLI not installed, or store limit reached |
| 5    | authentication or permission failure, or an unreadable password-manager secret                                 |
| 6    | outcome unknown: an effect may have happened, inspect before retrying                                          |
| 7    | retryable: rate limit, capacity or unavailable before any effect                                               |
| 8    | partial: some steps were confirmed; read error.known                                                           |
| 125  | exec/run: the CLI or provider failed; details in the error                                                     |
| 130  | interrupted by SIGINT (129 for SIGHUP, 143 for SIGTERM); an interrupted run still destroys its sandbox         |

## create

Create a sandbox and print its name.

```sh
sandbar create [--name <name>] [--image <oci-ref> | --prepared <id>] [--network <policy>]
```

| Flag                 | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `--name <name>`      | Store name (default: generated, like sb-1a2b3)                     |
| `--image <oci-ref>`  | OCI image, e.g. python:3.12; default is the profile's image        |
| `--prepared <id>`    | Provider-prepared image id (template, snapshot name)               |
| `--network <policy>` | blocked or internet; default is the profile's policy               |
| `--label <k=v>`      | Label to set (repeatable)                                          |
| `--build`            | Build --image first when the provider needs it (not available yet) |
| `--if-not-exists`    | Return the named sandbox if it is still alive instead of failing   |

Examples:

```sh
sandbar create --name web --network internet
sandbar create --name job-42 --if-not-exists --json
```

## ls

List sandboxes in the store with their current state.

```sh
sandbar ls [--offline]
```

| Flag        | Description                                  |
| ----------- | -------------------------------------------- |
| `--offline` | Show stored records without asking providers |

Examples:

```sh
sandbar ls
sandbar ls --json
```

## inspect

Show a sandbox's state, expiry and reference.

```sh
sandbar inspect <sandbox>
```

Examples:

```sh
sandbar inspect web --json
```

## rm

Destroy sandboxes and remove their records.

```sh
sandbar rm <sandbox>... | --all [--force]
```

| Flag      | Description                                                                 |
| --------- | --------------------------------------------------------------------------- |
| `--all`   | Every sandbox in this store                                                 |
| `--force` | Also destroy sandboxes this CLI did not create, or drop unreachable records |

Examples:

```sh
sandbar rm web
sandbar rm --all
```

## exec

Run a command in a sandbox; exits with the command's exit code.

```sh
sandbar exec <sandbox> [--cwd <dir>] [--env K=V]... [--stdin] -- <command> [args...]
```

| Flag                   | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `--cwd <dir>`          | Working directory in the sandbox                   |
| `--env <K=V>`          | Environment variable (repeatable)                  |
| `--stdin`              | Send this process's stdin to the command           |
| `--stdin-file <path>`  | Send a local file as the command's stdin           |
| `--timeout <duration>` | Execution deadline, e.g. 90s or 10m (default 300s) |
| `--max-output <size>`  | Captured output limit, e.g. 1m                     |

Exits with the remote command's exit code; failures of the CLI itself exit 125.

Examples:

```sh
sandbar exec web -- ls -la /
sandbar exec web --cwd /work --env CI=1 -- npm test
```

## sh

Run a shell script in a sandbox; exits with its exit code.

```sh
sandbar sh <sandbox> '<script>' | sandbar sh <sandbox> -- '<script>'
```

| Flag                   | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `--cwd <dir>`          | Working directory in the sandbox                   |
| `--env <K=V>`          | Environment variable (repeatable)                  |
| `--stdin`              | Send this process's stdin to the command           |
| `--stdin-file <path>`  | Send a local file as the command's stdin           |
| `--timeout <duration>` | Execution deadline, e.g. 90s or 10m (default 300s) |
| `--max-output <size>`  | Captured output limit, e.g. 1m                     |

Exits with the remote command's exit code; failures of the CLI itself exit 125.

Examples:

```sh
sandbar sh web 'cd /work && make test'
sandbar sh web -- '-n is fine here'
```

## run

Create a sandbox, run one command, and always destroy it.

```sh
sandbar run [create flags] [exec flags] [--keep] -- <command> [args...]
```

| Flag                   | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `--name <name>`        | Store name (default: generated, like sb-1a2b3)                     |
| `--image <oci-ref>`    | OCI image, e.g. python:3.12; default is the profile's image        |
| `--prepared <id>`      | Provider-prepared image id (template, snapshot name)               |
| `--network <policy>`   | blocked or internet; default is the profile's policy               |
| `--label <k=v>`        | Label to set (repeatable)                                          |
| `--build`              | Build --image first when the provider needs it (not available yet) |
| `--cwd <dir>`          | Working directory in the sandbox                                   |
| `--env <K=V>`          | Environment variable (repeatable)                                  |
| `--stdin`              | Send this process's stdin to the command                           |
| `--stdin-file <path>`  | Send a local file as the command's stdin                           |
| `--timeout <duration>` | Execution deadline, e.g. 90s or 10m (default 300s)                 |
| `--max-output <size>`  | Captured output limit, e.g. 1m                                     |
| `--keep`               | Keep the sandbox and print its name on stderr                      |

Exits with the remote command's exit code; failures of the CLI itself exit 125.

Examples:

```sh
sandbar run -- python3 -c 'print(2 + 2)'
sandbar run --network internet -- curl -sI https://example.com
```

## cp

Copy one file to or from a sandbox.

```sh
sandbar cp <src> <dst>   (one side is <sandbox>:/path)
```

| Flag              | Description                                       |
| ----------------- | ------------------------------------------------- |
| `--no-clobber`    | Fail instead of overwriting a file in the sandbox |
| `-r, --recursive` | Copy directories (not available yet)              |

Examples:

```sh
sandbar cp ./app.py web:/work/app.py
sandbar cp web:/work/out.json ./out.json
```

## cat

Print a file from a sandbox.

```sh
sandbar cat <sandbox>:/path
```

Examples:

```sh
sandbar cat web:/etc/os-release
```

## doctor

Check config, credentials and the provider connection without creating anything.

```sh
sandbar doctor
```

Examples:

```sh
sandbar doctor --provider e2b
```

## providers

List official providers, whether their adapter is installed and their credentials set.

```sh
sandbar providers
```

Examples:

```sh
sandbar providers --json
```

## skill

Print the agent skill for this CLI, or install it for your coding agents.

```sh
sandbar skill [install [--project]]
```

| Flag        | Description                                                                         |
| ----------- | ----------------------------------------------------------------------------------- |
| `--project` | Install into this folder's .agents/skills (and .claude/skills) instead of your home |

Examples:

```sh
sandbar skill
sandbar skill install
sandbar skill install --project
```

## completion

Print a shell completion script for zsh, bash or fish.

```sh
sandbar completion <zsh|bash|fish>
```

Examples:

```sh
source <(sandbar completion zsh)   # in ~/.zshrc
source <(sandbar completion bash)  # in ~/.bashrc
sandbar completion fish > ~/.config/fish/completions/sandbar.fish
```
