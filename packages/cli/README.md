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

The adapter package must be installed where the CLI can find it: in `~/.config/sandbar/adapters` (`cd ~/.config/sandbar/adapters && npm install @sandbar-sdk/e2b`) or next to the CLI itself. Adapters receive your credentials, so the current project's `node_modules` is searched only when you opt in with `"adapters": { "searchProject": true }` or `SANDBAR_PROJECT_ADAPTERS=1`. `sandbar providers` shows what is installed and which credentials are set.

## Commands

| Command | What it does |
| --- | --- |
| `create [--name] [--image <oci-ref> \| --prepared <id>] [--network] [--label k=v] [--if-not-exists]` | Create a sandbox, print its name |
| `ls [--offline]` | List store records with live state (`running`, `gone`, `unreachable`, ...) |
| `inspect <sandbox>` | State, expiry and reference |
| `rm <sandbox>... \| --all [--force]` | Destroy and forget; only sandboxes this CLI created unless `--force`. `--all` skips the others and reports them |
| `exec <sandbox> [--cwd] [--env K=V] [--stdin \| --stdin-file] [--timeout] [--max-output] -- cmd...` | Run argv; exit code passes through |
| `sh <sandbox> '<script>'` (or `-- '<script>'`) | Run a shell script; same flags as exec |
| `run [create and exec flags] [--keep] -- cmd...` | Create, run one command, destroy |
| `cp <src> <dst>` | Copy one file; one side is `<sandbox>:/path` |
| `cat <sandbox>:/path` | Print a file |
| `doctor` | Check config, credentials and the connection; creates nothing |
| `providers` | Official providers, install state and missing credentials |
| `schema` | Machine-readable description of every command, flag and exit code |
| `skill [install [--project]]` | Print the agent skill for this CLI, or install it for your coding agents |

A `<sandbox>` is a store name, a native id held in the store, or `@file.json` holding a saved sandbox reference.

## Output and exit codes

With `--json` (or `SANDBAR_JSON=1`) stdout holds exactly one document: `{"ok":true,"data":...}` or `{"ok":false,"error":{"code","message","retryable","outcome","hint?","known?","details?"}}`. Diagnostics go to stderr. When `rm` stops partway, `error.details` lists what was `removed`, `skipped` and `failed`.

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | other failure (including a taken `--name` or an existing `cp --no-clobber` target) |
| 2 | usage error |
| 3 | not found |
| 4 | unsupported, adapter or password-manager CLI not installed, or `limits.maxSandboxes` reached |
| 5 | authentication or permission, including a password-manager secret that cannot be read |
| 6 | outcome unknown: an effect may have happened, inspect before retrying |
| 7 | retryable before any effect (rate limit, capacity, unavailable) |
| 8 | partial: some steps confirmed, see `error.known` |

`exec`, `sh` and `run` exit with the remote command's exit code. Their own failures always use 125, so they never look like a command's result; providers report deadlines differently, so there is no separate deadline code. A missing exit status is 125 with `OUTCOME_UNKNOWN` and the captured output in `error.known.exec`, never 0. If `run` cannot destroy its sandbox it exits 125 with `CLEANUP_FAILED`, and the command's result is inside that one error document.

SIGINT, SIGTERM and SIGHUP all stop local waiting and let `run` clean up; a second signal exits at once.

## Agent skill

The CLI carries an agent skill that matches its own version. `sandbar skill` prints it; `sandbar skill install` writes it to `~/.agents/skills/sandbar-cli/` and, when `~/.claude` exists, to `~/.claude/skills/sandbar-cli/`. Add `--project` to install into the current folder instead. Rerunning updates a copy it wrote; a copy installed another way is left alone.

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
- Credentials can be written in the profile directly, as `env:NAME` references, or as password-manager references (below). Keep the file private (`chmod 600`) if it holds keys. Env-only providers read `DAYTONA_API_KEY` and `DAYTONA_TARGET`; `E2B_API_KEY`; `BOXD_API_KEY` and `BOXD_ORG`; `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`; `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `MODAL_APP_NAME` and `MODAL_ENVIRONMENT`.
- `limits.maxSandboxes` (or `SANDBAR_MAX_SANDBOXES`) caps how many sandboxes the store may hold. Unset means uncapped.

## Password managers

Any `config` or `credentials` value (including one that comes from a provider's environment variable) can name a secret in a password manager. The CLI reads it with the manager's own command-line tool, using that tool's sign-in, only when the profile connects. It never writes the value anywhere.

| Reference | Read with | Sign-in |
| --- | --- | --- |
| `op://vault/item/field` | `op read` (1Password CLI) | desktop app integration, `op signin` or `OP_SERVICE_ACCOUNT_TOKEN` |
| `bws://<secret-id>` | `bws secret get` (Bitwarden Secrets Manager CLI) | `BWS_ACCESS_TOKEN` |
| `pass://path/to/entry` | `pass show` (first line of the entry) | your GPG agent |

```json
{ "profiles": { "e2b": { "provider": "e2b", "credentials": { "apiKey": "op://Dev/E2B/credential" } } } }
```

If the tool is not installed the command exits 4 (`SECRET_TOOL_MISSING`); if it cannot read the secret it exits 5 (`SECRET_UNAVAILABLE`) with the tool's own message. Each reference is read at most once per command.

## State store

Sandbox references are kept as one JSON file per sandbox in `~/.config/sandbar/state/sandboxes/<name>.json` (override with `--state-dir` or `SANDBAR_STATE_DIR`, relative to the working directory, or `state.dir`, relative to the config file). Records hold references only, never credentials. A name is claimed before the provider call, so a crash or uncertain create leaves a record that `ls` shows and `rm --force` can drop. Records are written whole (a temporary file linked or renamed into place) and updates take a short per-record lock, so concurrent CLI processes on one machine never see half-written files; `ls` skips an unreadable record with a warning. The `maxSandboxes` check is best effort under concurrent creates. The store sits behind a small per-record interface (create-if-absent, compare-and-swap update, paged list) so object storage can back it later.

## Not yet

Planned for later steps: `--lifetime`/`--idle`/`--port` create flags, recursive `cp`, detached processes and logs, preview URLs, suspend/resume/renew, `gc`, image builds and records, snapshots and volumes, `sandbar adapter add`, an S3-compatible store, KeePassXC and system-keyring references, and MCP mode. `--image` is passed to the adapter as an OCI image; providers that need a build first reject it before creating anything.

## Development

Tests run the real CLI as a subprocess against the fake provider; they make no provider calls:

```sh
bun test packages/cli
```
