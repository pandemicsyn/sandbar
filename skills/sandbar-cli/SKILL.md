---
name: sandbar-cli
description: Create, use and clean up cloud sandboxes from the shell with the `sandbar` CLI (Daytona, E2B, boxd, Boat, Runloop, Vercel, Modal). Use when you need an isolated machine to run untrusted or generated code, try a build or test in a clean environment, or manage sandboxes someone created with sandbar; prefer it over provider-specific CLIs.
---

# Use sandboxes with the sandbar CLI

`sandbar` creates and manages sandboxes on any Sandbar provider. It is built for agents: it never prompts, every command has a stable `--json` form, and exit codes tell you what to do next.

## Check the setup first

```sh
sandbar doctor --json      # config, credentials, provider connection; creates nothing
sandbar providers --json   # which adapters are installed and which credentials are missing
```

- If `sandbar` is not on PATH, stop and tell the user; do not install anything yourself.
- The provider comes from `--profile`, `SANDBAR_PROFILE`, `--provider`, `SANDBAR_PROVIDER`, then `default` in `~/.config/sandbar/sandbar.json`. Do not edit that file or credentials unless the user asks.
- A missing adapter (exit 4, `ADAPTER_NOT_INSTALLED`; the user installs it with `sandbar adapter add <provider>`), an installed adapter that fails to load (exit 4, `ADAPTER_LOAD_FAILED`) or a missing credential (exit 2) is the user's to fix. Report the `hint` from the error.

**Sandboxes cost money.** Create only what the task needs and destroy it when done.

## Always use JSON

Pass `--json` (or set `SANDBAR_JSON=1`). stdout then holds exactly one document:

```json
{"ok": true, "data": {...}}
{"ok": false, "error": {"code": "...", "message": "...", "retryable": false, "outcome": "rejected", "hint": "...", "known": {...}}}
```

Diagnostics go to stderr. Read `error.hint` before deciding what to do.

## One-shot work: `run`

`run` creates a sandbox, runs one command and always destroys it. Prefer it whenever you do not need the sandbox afterwards.

```sh
sandbar run --json -- python3 -c 'print(2 + 2)'
sandbar run --json --prepared base --timeout 5m -- sh -c 'pip install -q requests && python3 app.py'
```

Pass the command after `--` as separate arguments. Its data is `{exitCode, stdout, stderr, truncated, sandbox}`, where `sandbox` names the sandbox it created and destroyed.

## Longer work: create, use, remove

```sh
sandbar create --json --name job-1 --prepared base   # prints the name; reuse it everywhere
sandbar cp ./app.py job-1:/home/user/app.py
sandbar exec --json job-1 --cwd /home/user -- python3 app.py
sandbar sh --json job-1 'cd /home/user && ls -la | head'
sandbar cat job-1:/home/user/out.txt
sandbar rm --json job-1
```

- Give sandboxes a `--name` so you can find them again; names are lowercase letters, digits and dashes. `--if-not-exists` reuses a live sandbox with that name instead of failing.
- `exec` takes an argv after `--`; no shell runs. Use `sh` only when you need pipes, redirects or `&&`. For a script that starts with `-`, put it after `--`: `sandbar sh job-1 -- '-n ...'`.
- `--env K=V` (repeatable), `--env-file <path>`, `--cwd`, `--stdin` or `--stdin-file <path>`, `--timeout 30s|5m|1h`, `--max-output 1m`.
- Without `--json`, output streams live on providers that support it (Daytona, E2B, Vercel). With `--json` it is always captured into the one document, limited by `--max-output`.
- On `create`, `--env K=V` and `--env-file <path>` set variables for every later `exec`/`sh` in that sandbox; a command's own `--env` wins. For a secret, pass `--env NAME` (no value) to copy it from your environment instead of typing it. Values are never stored or printed. Providers that cannot keep sandbox variables (boxd) fail with exit 4 and `UNSUPPORTED` before creating anything; pass `--env` on each `exec` there. On `run`, `--env` applies to its one command and works everywhere.
- `cp` copies one file; one side is `<sandbox>:/absolute/path`. `--no-clobber` refuses to overwrite. `cp -r` copies a directory either way (`--exclude <glob>` skips paths); an existing destination folder gets a child of the same name.
- `sandbar push <sandbox>[:/dir] [path]` sends a local folder (default `.`) to `~/work` in the sandbox, or `/dir`, and prints the absolute path. In a git work tree it sends tracked and unignored files only; `--include-ignored` sends everything. `sandbar run --push . -- <cmd>` pushes, then runs the command in that folder. Directory copies need `tar` in the sandbox: exit 4 with `UNSUPPORTED` means it is missing.
- `--image <oci-ref>` boots an OCI image where the provider supports it; `--prepared <id>` uses a provider template or snapshot. On providers that need a build first (E2B, Daytona), `--image` fails with exit 4 and `UNSUPPORTED` before creating anything until `sandbar image build <oci-ref>` has run once for that profile; later creates reuse the build. Build once rather than passing `--build` in a loop: a build is slow, may cost money and leaves a provider-side resource. `sandbar image ls` shows the builds (`--remote` lists the provider's images instead); `sandbar image rm <name>` deletes a build on the provider and drops its record; `sandbar image forget <name>` only drops the record. Only `image rm` images you built for this task; it refuses builds this CLI did not verifiably create, and never pass `--force` unless the user asked. Exit 6 from `image rm` means the outcome is unknown: run `sandbar image rm <name>` again later to check, which never resends the delete.
- `sandbar ls --json` lists known sandboxes with their live state (`running`, `gone`, `unreachable`, ...). `sandbar inspect --json <name>` shows state, expiry and the saved reference.
- `sandbar ls --remote --json` asks the provider instead of the store. `data.coverage` says whether it shows every sandbox in the account scope (`provider-scope`) or only Sandbar-created ones (`sandbar-managed`); `name` is the store name, or null for sandboxes this store does not know. `sandbar adopt <id> [--name <name>]` records a listed sandbox so `exec`, `cp` and `inspect` can reach it. Adopted sandboxes are not the CLI's own: `rm --all` skips them and `rm <name>` needs `--force`. Do not adopt or remove sandboxes the user did not ask about.

Always `rm` what you created before finishing, even after failures. `rm` only destroys sandboxes this CLI created; never pass `--force` or `rm --all` unless the user asked.

## Exit codes

`exec`, `sh` and `run` exit with the **remote command's** exit code. Their own failures always exit **125**, with the error in the JSON document. A command that ran but reported no exit status is 125 with `OUTCOME_UNKNOWN`; its output is in `error.known.exec`. It is never success.

Other commands:

| Code | Meaning                                                           | What to do                                           |
| ---- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| 0    | success                                                           |                                                      |
| 1    | other failure, including a name already taken                     | read the message                                     |
| 2    | usage or local error                                              | fix the command; `sandbar <command> --help`          |
| 3    | not found                                                         | `sandbar ls`                                         |
| 4    | unsupported, adapter or tool not installed, limit reached         | tell the user; do not work around it                 |
| 5    | authentication, permission, or unreadable password-manager secret | tell the user                                        |
| 6    | **outcome unknown**: the effect may have happened                 | **do not retry**; run `sandbar ls` / `inspect` first |
| 7    | retryable (rate limit, capacity, unavailable) before any effect   | wait, then retry once or twice                       |
| 8    | partial: some steps happened                                      | read `error.known` and `error.details`               |

## When things go wrong

- **Never repeat a create after exit 6 or `outcome: "unknown"`.** The store keeps the name in status `unknown`; check `sandbar ls --json`. `sandbar rm <name>` first asks the provider how that create ended (never resending it) and destroys the sandbox if one exists. If it still exits 4 because the outcome is unknown, and the user agrees it is gone, `sandbar rm --force <name>` drops the record.
- **`run` exits 125 with `CLEANUP_FAILED`**: the command result is in `error.known.exec`, but the sandbox is still running. Tell the user and run the `rm` from the hint.
- **`rm` exits 8**: `error.details` lists what was `removed`, `skipped` and `failed`. Retry only the failed names once the cause is fixed.
- **`STORE_WRITE_FAILED`**: the sandbox exists but was not recorded. The reference is in `error.known.reference`; save it to a file and destroy with `sandbar rm @file.json`.
- Interrupting `run` (Ctrl-C, SIGTERM) still destroys its sandbox and exits 130 (143 for SIGTERM) with `INTERRUPTED`. A second signal exits immediately and may leave it running.

## Discover more

`sandbar schema` prints every command, flag and exit code as JSON. `sandbar <command> --help` shows usage and examples.
