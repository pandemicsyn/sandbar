---
"@sandbar-sdk/cli": minor
---

`sandbar create --env K=V` and `--env-file <path>` set environment variables for every command in the sandbox. `exec`, `sh` and `run` accept `--env-file` for one command, and `--env NAME` without a value copies `NAME` from the calling environment. Values are never written to the store, `--json` output or messages.
