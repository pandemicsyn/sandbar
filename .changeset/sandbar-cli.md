---
"@sandbar-sdk/cli": minor
---

Add `@sandbar-sdk/cli`, the agent-first `sandbar` command line. It creates, lists, inspects and removes sandboxes on any installed adapter, runs commands with `exec`, `sh` and `run`, copies files with `cp`, and reports setup problems with `doctor`. Every command has a stable `--json` envelope and documented exit codes. Adapters are installed separately with `sandbar adapter add`, credentials can come from 1Password, Bitwarden Secrets Manager or `pass`, and the CLI ships its own agent skill and shell completion.
