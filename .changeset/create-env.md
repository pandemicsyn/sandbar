---
"sandbar-sdk": minor
"@sandbar-sdk/adapter": minor
"@sandbar-sdk/daytona": minor
"@sandbar-sdk/e2b": minor
"@sandbar-sdk/vercel": minor
---

`sandboxes.create({ env })` sets environment variables for every command, process and terminal in the sandbox, including after reopening; a per-call `env` overrides a name. Daytona, E2B and Vercel map it to their native create-time environment. Adapters opt in with `supports.createEnv`, reported as `capabilities().createEnv`; elsewhere (boxd) `create({ env })` rejects with `UnsupportedFeatureError` before allocating anything. Values are never saved in recovery references or tokens, and never appear in telemetry or error messages.
