---
"@sandbar-sdk/adapter": minor
"sandbar-sdk": minor
"@sandbar-sdk/daytona": minor
"@sandbar-sdk/e2b": minor
"@sandbar-sdk/boxd": minor
"@sandbar-sdk/boat": minor
"@sandbar-sdk/runloop": minor
"@sandbar-sdk/modal": minor
"@sandbar-sdk/vercel": minor
"@sandbar-sdk/cli": minor
---

Set the sandbox lifetime the same way everywhere. Every adapter now takes `lifecycle: { lifetimeSeconds }` in setup, defaulting to 900 seconds; E2B, Vercel and Modal `timeoutSeconds`, Daytona `ttlMinutes` and boxd's top-level `lifetimeSeconds` still work but are deprecated. `create({ lifecycle: { lifetimeSeconds } })` overrides it for one sandbox, and `capabilities().lifetime` reports the accepted range. The CLI adds `create --ttl` and `run --ttl`.
