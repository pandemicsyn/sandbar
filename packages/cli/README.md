# @sandbar-sdk/cli

`sandbar` creates and manages sandboxes on any Sandbar provider from the command line. It is built for agents first: it never prompts, every command has a stable `--json` form, and exit codes say what to do next.

Status: first delivery step (private workspace package, not published). Adapters are installed separately.

## Quick start

```sh
export SANDBAR_PROVIDER=e2b E2B_API_KEY=...
sandbar create --name web
sandbar exec web -- uname -a
sandbar cp ./app.py web:/work/app.py
sandbar rm web

sandbar run -- python3 -c 'print(2 + 2)'   # create, run, always destroy
```

The adapter package must be installed where the CLI can find it: in the current project (`npm install @sandbar-sdk/e2b`), or in `~/.config/sandbar/adapters` (`cd ~/.config/sandbar/adapters && npm install @sandbar-sdk/e2b`). `sandbar providers` shows what is installed and which credentials are set.

## Commands

| Command | What it does |
| --- | --- |
| `create [--name] [--image <oci-ref> \| --prepared <id>] [--network] [--label k=v] [--if-not-exists]` | Create a sandbox, print its name |
| `ls [--offline]` | List store records with live state (`running`, `gone`, `unreachable`, ...) |
| `inspect <sandbox>` | State, expiry and reference |
| `rm <sandbox>... \| --all [--force]` | Destroy and forget; only sandboxes this CLI created unless `--force` |
| `exec <sandbox> [--cwd] [--env K=V] [--stdin \| --stdin-file] [--timeout] [--max-output] -- cmd...` | Run argv; exit code passes through |
| `sh <sandbox> '<script>'` | Run a shell script; same flags as exec |
| `run [create and exec flags] [--keep] -- cmd...` | Create, run one command, destroy |
| `cp <src> <dst>` | Copy one file; one side is `<sandbox>:/path` |
| `cat <sandbox>:/path` | Print a file |
| `doctor` | Check config, credentials and the connection; creates nothing |
| `providers` | Official providers, install state and missing credentials |
| `schema` | Machine-readable description of every command, flag and exit code |

A `<sandbox>` is a store name, a native id held in the store, or `@file.json` holding a saved sandbox reference.

## Output and exit codes

With `--json` (or `SANDBAR_JSON=1`) stdout holds exactly one document: `{"ok":true,"data":...}` or `{"ok":false,"error":{"code","message","retryable","outcome","hint?","known?"}}`. Diagnostics go to stderr.

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | other failure (including a taken `--name`) |
| 2 | usage error |
| 3 | not found |
| 4 | unsupported, adapter not installed, or `limits.maxSandboxes` reached |
| 5 | authentication or permission |
| 6 | outcome unknown: an effect may have happened, inspect before retrying |
| 7 | retryable before any effect (rate limit, capacity, unavailable) |
| 8 | partial: some steps confirmed, see `error.known` |

`exec`, `sh` and `run` exit with the remote command's exit code. Their own failures use 125 (124 for a deadline), so they never look like a command's result. A missing exit status is 125 with `OUTCOME_UNKNOWN`, never 0.

## Configuration

`~/.config/sandbar/sandbar.json` (`$XDG_CONFIG_HOME/sandbar`, or `--config` / `SANDBAR_CONFIG`):

```json
{
  "default": "e2b",
  "profiles": {
    "e2b": { "provider": "e2b", "credentials": { "apiKey": "env:E2B_API_KEY" }, "config": { "network": "internet" } },
    "local": { "module": "./my-adapter.js", "export": "myAdapter", "config": {}, "credentials": {} }
  },
  "state": { "kind": "fs", "dir": "~/.config/sandbar/state" },
  "limits": { "maxSandboxes": null }
}
```

- Profile selection: `--profile`, `SANDBAR_PROFILE`, `--provider`, `SANDBAR_PROVIDER`, then `default`.
- `provider` names an official adapter (`@sandbar-sdk/<provider>`); `config` and `credentials` are that adapter's own settings. `module` and `export` load any adapter, either a definition or a bound adapter.
- Credentials are only ever `env:NAME` references or environment variables. Env-only providers read `DAYTONA_API_KEY` and `DAYTONA_TARGET`; `E2B_API_KEY`; `BOXD_API_KEY` and `BOXD_ORG`; `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`; `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `MODAL_APP_NAME` and `MODAL_ENVIRONMENT`.
- `limits.maxSandboxes` (or `SANDBAR_MAX_SANDBOXES`) caps how many sandboxes the store may hold. Unset means uncapped.

## State store

Sandbox references are kept as one JSON file per sandbox in `~/.config/sandbar/state/sandboxes/<name>.json` (override with `--state-dir`, `SANDBAR_STATE_DIR` or `state.dir`). Records hold references only, never credentials. A name is claimed before the provider call, so a crash or uncertain create leaves a record that `ls` shows and `rm --force` can drop. The store sits behind a small per-record interface (create-if-absent, compare-and-swap update, paged list) so object storage can back it later.

## Not yet

Planned for later steps: `--lifetime`/`--idle`/`--port` create flags, recursive `cp`, detached processes and logs, preview URLs, suspend/resume/renew, `gc`, image builds and records, snapshots and volumes, `sandbar adapter add`, an S3-compatible store and MCP mode. `--image` is passed to the adapter as an OCI image; providers that need a build first reject it before creating anything.

## Development

Tests run the real CLI as a subprocess against the fake provider; they make no provider calls:

```sh
bun test packages/cli
```
