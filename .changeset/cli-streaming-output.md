---
"@sandbar-sdk/cli": minor
---

`sandbar exec`, `sh` and `run` now print output as it arrives on providers that stream process bytes (Daytona, E2B and Vercel). The CLI enforces `--timeout` for streaming commands and asks the provider to terminate them on timeout or Ctrl-C. Other providers, `--json` and the new `--no-stream` flag keep the buffered output.
