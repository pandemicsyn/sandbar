---
"@sandbar-sdk/cli": patch
---

`sandbar exec`, `sh` and `run` also stream on adapters whose processes stream text but not bytes, instead of falling back to buffered output.
