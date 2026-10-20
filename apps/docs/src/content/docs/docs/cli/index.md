---
title: Command line
description: Create, use and clean up sandboxes on any Sandbar provider from your shell or your agent.
---

`sandbar` creates and manages sandboxes from the command line, on any provider with a Sandbar adapter. It is built for coding agents first: it never prompts, every command has a stable `--json` form, and exit codes say what to do next. People get readable output by default.

## Install

Install the CLI, then the adapter for each provider you use. Adapters live in their own folder so a project you happen to be in can't supply one:

```sh
npm install -g @sandbar-sdk/cli
sandbar adapter add e2b
```

The CLI runs on Node.js or Bun; `sandbar adapter` uses npm to install. `sandbar adapter add` takes one or more provider ids (`daytona`, `e2b`, `vercel`, `boxd`, `modal`, `runloop`, `boat`) and installs each official adapter at the same version as the CLI, so the two always match. It then imports the package to check that the adapter is there. Running it again with nothing to change skips npm, so it is safe in CI setup steps. `sandbar adapter ls` shows what is installed and flags an official adapter whose version differs from the CLI's; `sandbar adapter rm e2b` removes one.

`sandbar providers` lists the official adapters, whether each is installed and which credentials are missing.

## Quick start

Pick a provider with environment variables, check the setup, then work:

```sh
export SANDBAR_PROVIDER=e2b E2B_API_KEY=...
sandbar doctor                                  # checks config and credentials; creates nothing

sandbar create --name web
sandbar cp ./app.py web:/home/user/app.py
sandbar exec web --cwd /home/user -- python3 app.py
sandbar sh web 'ls -la /home/user | head'
sandbar rm web
```

For one command in a throwaway sandbox, `run` creates it, runs the command and always destroys it, even when the command fails or you press Ctrl-C (it then exits 130):

```sh
sandbar run -- python3 -c 'print(2 + 2)'
```

To keep provider settings in one place instead of environment variables, see [Configuration](/docs/cli/configuration/).

## Naming sandboxes

`create` prints the sandbox's name: the `--name` you gave, or a generated one such as `sb-1a2b3`. Every other command takes that name. The CLI also accepts a provider's own sandbox ID if the sandbox is in its list, or `@file.json` for a file holding a saved sandbox reference (the `reference` field of `sandbar inspect --json`).

`sandbar ls` shows every sandbox the CLI knows about with its live state (`running`, `gone`, `unreachable` and so on). `sandbar ls --offline` skips the provider calls.

`sandbar ls --remote` asks the selected profile's provider instead, so it also shows sandboxes created elsewhere. It prints whether the provider listed every sandbox in the account scope or only ones created through Sandbar. The `NAME` column shows the store name for sandboxes the CLI already knows. To work with a listed sandbox by name, record it with `sandbar adopt <id> --name <name>`; adopt reopens it first and fails if the provider cannot give a verifiable reference. The CLI did not create adopted sandboxes, so `rm --all` skips them and `rm <name>` needs `--force`.

## Commands and arguments

- `exec` passes the command after `--` as separate arguments, with no shell. Use `sh` when you need pipes, redirects or `&&`.
- `exec`, `sh` and `run` exit with the remote command's own exit code, so `sandbar exec web -- test -f /x && echo yes` works as expected. Failures of the CLI itself exit 125.
- `create --env K=V` (repeatable) and `--env-file <path>` set environment variables for every command in the sandbox; `exec --env` overrides a name for one command. `--env NAME` without a value copies `NAME` from your shell, which keeps secrets out of history. `.env` files hold `NAME=VALUE` lines; `#` comments (also after a value, following a space), blank lines and `export` are allowed. Unquoted values are trimmed; `"..."` values understand `\n`, `\"` and `\\`, and `'...'` values are literal. Multi-line values are not supported. Values are never written to the store, `--json` output or messages. Providers without sandbox-wide variables (boxd) reject `--env` on `create` before creating anything. On `exec`, `sh` and `run`, the same flags apply to that one command.
- `cp` copies one file in either direction; the sandbox side is written `<name>:/absolute/path`. `cat <name>:/path` prints a file.
- `--image <oci-ref>` boots an OCI image on boxd and Modal. E2B and Daytona need it built once with `sandbar image build <oci-ref>`; until then `--image` fails before creating anything, and `--build` builds it during the command instead. `--prepared <id>` picks a provider template or snapshot. `sandbar image ls`, `inspect`, `rm` and `forget` manage the recorded builds: `rm` deletes the template or snapshot on the provider and drops the record (only builds this CLI created, unless you pass `--force`), while `forget` only drops the record and lists what the provider still holds. `sandbar image ls --remote` lists the provider's own images. If `image rm` exits 6, the outcome is unknown; running it again asks the provider how the delete ended without resending it.

## JSON output for agents and scripts

Add `--json`, or set `SANDBAR_JSON=1`, and stdout holds exactly one JSON document:

```json
{ "ok": true, "data": { "name": "web", "provider": "e2b", "status": "created" } }
```

```json
{
  "ok": false,
  "error": {
    "code": "OUTCOME_UNKNOWN",
    "message": "...",
    "retryable": false,
    "outcome": "unknown",
    "hint": "...",
    "known": { "sandbox": "web" }
  }
}
```

`outcome` says whether anything happened: `rejected` means nothing did, `unknown` means it might have, and `partial` means some steps did. **Never repeat a create after `unknown` (exit 6).** Run `sandbar ls` first: the CLI keeps the name so you can inspect or remove whatever was created.

The [command reference](/docs/cli/reference/) lists every exit code, and `sandbar schema` prints all commands, flags and exit codes as JSON.

## Cleaning up

`rm` destroys a sandbox and forgets it. It only destroys sandboxes this CLI created; add `--force` for others. `rm --all` removes everything the CLI created and reports what it skipped. If some removals fail, `rm` keeps going and exits 8 with a list of what was removed, skipped and failed.

Sandboxes cost money while they run. `run` and `rm` are the tools for keeping that bounded; `sandbar ls` shows anything left behind.
