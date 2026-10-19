---
"@sandbar-sdk/runloop": minor
"@sandbar-sdk/cli": minor
---

Add the experimental `@sandbar-sdk/runloop` adapter for Runloop Devboxes: blocked egress by default through a managed deny-all network policy, argv/shell exec with exact output bytes and finite stdin, binary files, suspend/resume, disk snapshots with restore, authenticated or public previews, and portable `resources` sizing. The CLI recognizes `--provider runloop` with `RUNLOOP_API_KEY` and optional `RUNLOOP_NETWORK=internet`.
