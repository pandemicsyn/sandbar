---
"@sandbar-sdk/vercel": minor
"@sandbar-sdk/modal": minor
---

Add `snapshots: { retentionSeconds }` to the Vercel and Modal adapters to set how long snapshots are kept (`0` keeps them until deleted). Vercel sends native `expiration`, counted from last use, and accepts it in disposable mode only. Modal sends `ttlMs`, counted from capture. `snapshot({ retention: { minimumSeconds } })` is checked against the configured value.
