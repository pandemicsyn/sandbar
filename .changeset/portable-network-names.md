---
"sandbar-sdk": minor
"@sandbar-sdk/adapter": minor
"@sandbar-sdk/daytona": minor
"@sandbar-sdk/e2b": minor
"@sandbar-sdk/boxd": minor
"@sandbar-sdk/vercel": minor
---

Use the same network names on every adapter. Configure `network: "blocked" | "internet"` in adapter setup and, where needed, `create({ network })` or `restore({ network })`. Vercel accepts `blocked` and `internet` in place of `vercel-deny-all` and `vercel-allow-all`. Daytona adds `internet`, which requires an organization without limited sandbox egress and never falls back to the tier-dependent `daytona-default`. The `networkPolicy` option and Vercel's native names keep working and are deprecated. Adapters can declare `networkPolicyAliases` so the SDK resolves deprecated names before support checks.
