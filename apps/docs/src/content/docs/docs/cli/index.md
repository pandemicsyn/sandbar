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

To test a checkout in a throwaway sandbox, send it with `run --push`, and copy results out with `cp -r`:

```sh
sandbar run --push . --timeout 15m -- sh -c 'npm ci && npm test'

sandbar create --name ci --ttl 30m
sandbar push ci                                  # prints /home/user/work
sandbar exec ci --cwd /home/user/work -- npm test
sandbar cp -r ci:/home/user/work/coverage ./coverage
sandbar rm ci
```

For one command in a throwaway sandbox, `run` creates it, runs the command and always destroys it, even when the command fails or you press Ctrl-C (it then exits 130):

```sh
sandbar run -- python3 -c 'print(2 + 2)'
```

To keep provider settings in one place instead of environment variables, see [Configuration](/docs/cli/configuration/). To run CI jobs in sandboxes, see [Run CI jobs](/docs/cli/ci/).

## Naming sandboxes

`create` prints the sandbox's name: the `--name` you gave, or a generated one such as `sb-1a2b3`. Every other command takes that name. The CLI also accepts a provider's own sandbox ID if the sandbox is in its list, or `@file.json` for a file holding a saved sandbox reference (the `reference` field of `sandbar inspect --json`).

`sandbar ls` shows every sandbox the CLI knows about with its live state (`running`, `gone`, `unreachable` and so on). `sandbar ls --offline` skips the provider calls.

`sandbar ls --remote` asks the selected profile's provider instead, so it also shows sandboxes created elsewhere. It prints whether the provider listed every sandbox in the account scope or only ones created through Sandbar. The `NAME` column shows the store name for sandboxes the CLI already knows. To work with a listed sandbox by name, record it with `sandbar adopt <id> --name <name>`; adopt reopens it first and fails if the provider cannot give a verifiable reference. The CLI did not create adopted sandboxes, so `rm --all` skips them and `rm <name>` needs `--force`.

## Commands and arguments

- `exec` passes the command after `--` as separate arguments, with no shell. Use `sh` when you need pipes, redirects or `&&`.
- `exec`, `sh` and `run` exit with the remote command's own exit code, so `sandbar exec web -- test -f /x && echo yes` works as expected. Failures of the CLI itself exit 125.
- `exec`, `sh` and `run` print output as it arrives on every provider, so long builds and test runs show progress. Boat and Runloop stream it as UTF-8 text; the others pass the exact bytes through. With `--json` or `--no-stream`, the output is printed when the command ends; `--max-output` limits only that captured output. `--timeout` (default 5 minutes) applies either way: a streaming command that runs past it, or that you stop with Ctrl-C, is asked to terminate before the CLI exits.
- `create --env K=V` (repeatable) and `--env-file <path>` set environment variables for every command in the sandbox; `exec --env` overrides a name for one command. `--env NAME` without a value copies `NAME` from your shell, which keeps secrets out of history. `.env` files hold `NAME=VALUE` lines; `#` comments (also after a value, following a space), blank lines and `export` are allowed. Unquoted values are trimmed; `"..."` values understand `\n`, `\"` and `\\`, and `'...'` values are literal. Multi-line values are not supported. Values are never written to the store, `--json` output or messages. Providers without sandbox-wide variables (boxd) reject `--env` on `create` before creating anything. On `exec`, `sh` and `run`, the same flags apply to that one command.
- `cp` copies a file in either direction; the sandbox side is written `<name>:/absolute/path`. `cat <name>:/path` prints a file. With `-r` it copies a directory too, like `cp -r`: an existing destination folder receives a child of the same name. `--exclude <glob>` (repeatable) skips matching paths; a pattern without `/`, such as `node_modules` or `*.log`, matches a name at any depth.
- `push <name>[:/dir] [path]` sends a local folder (default `.`) into the sandbox, by default to `work` under the sandbox user's home, and prints where it landed. In a git work tree it sends what git would: tracked files plus untracked files that are not ignored, so `.git`, `node_modules` and build output stay behind. `--include-ignored` sends every file. `run --push <path>` does the same in its new sandbox and runs the command in that folder unless you pass `--cwd`.
- Directory copies keep file modes and symlinks. They move one tar archive and unpack it with one command, so the sandbox needs `tar` (without it they fail with exit 4 and `UNSUPPORTED` before anything is sent). Copying out never writes through a symlink, never leaves the destination folder, and drops setuid bits. Files deleted locally are not deleted from an earlier copy in the sandbox.
- `--image <oci-ref>` boots an OCI image on boxd and Modal. E2B and Daytona need it built once with `sandbar image build <oci-ref>`; until then `--image` fails before creating anything, and `--build` builds it during the command instead. `--prepared <id>` picks a provider template or snapshot. `sandbar image ls`, `inspect`, `rm` and `forget` manage the recorded builds: `rm` deletes the template or snapshot on the provider and drops the record (only builds this CLI created, unless you pass `--force`), while `forget` only drops the record and lists what the provider still holds. `sandbar image ls --remote` lists the provider's own images. If `image rm` exits 6, the outcome is unknown; running it again asks the provider how the delete ended without resending it.

## Snapshots

A snapshot saves a sandbox's state so new sandboxes can start from it, for example a checkout with its dependencies already installed:

```sh
sandbar create --name base --network internet
sandbar sh base 'git clone https://github.com/acme/app /work/app && cd /work/app && npm ci'
sandbar snapshot create base --name deps
sandbar rm base

sandbar run --snapshot deps --cwd /work/app -- npm test
```

`snapshot create <sandbox>` captures a sandbox from the store and records the snapshot under `--name` (default `<sandbox>-snap`). What it keeps, files only or memory too, and whether the source pauses during capture depend on the provider and the profile's `snapshots.preserve`; the command prints both. A provider that cannot capture fails with exit 4 before anything happens.

`create --snapshot <name>` and `run --snapshot <name>` start a sandbox from a recorded snapshot, on the profile that captured it. The snapshot fixes the image, so `--image`, `--prepared` and `--build` do not apply. `--env`, `--label` and `--ttl` work as on any create, for example to pass a CI job its secrets. A provider that can't apply one of them on restore fails with exit 4 before anything is created: Boat and boxd take only `--ttl`, Runloop takes `--env` and `--ttl`, and Daytona and E2B take `--env` only for filesystem snapshots, because a memory snapshot resumes its processes with the environment they had.

To refresh a snapshot, capture it again with `snapshot create <sandbox> --name <name> --replace`. The record keeps the old snapshot until the new one exists, then the old one is deleted. A snapshot still in use by a running sandbox can't be deleted; the command says so and leaves it on the provider.

`snapshot ls` lists the recorded snapshots and `snapshot ls --remote` the provider's own. `snapshot inspect <name>` shows a snapshot's state. `snapshot rm <name>` deletes it on the provider and drops the record (only snapshots this CLI captured, unless you pass `--force`), while `snapshot forget <name>` only drops the record. Snapshots are kept until you delete them, and some providers charge for storage. If `snapshot create` or `snapshot rm` exits 6, the outcome is unknown: `snapshot inspect` or running `snapshot rm` again checks how it ended without sending it twice.

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

As a backstop for a job that is killed before it can clean up, `create --ttl <duration>` and `run --ttl <duration>` (like `30m` or `2h`) set how long the provider keeps that sandbox before removing it. Without `--ttl`, the profile's `lifecycle.lifetimeSeconds` applies, 15 minutes by default. Keep it longer than `--timeout` for long commands. A provider that cannot apply the value rejects it before creating anything.
