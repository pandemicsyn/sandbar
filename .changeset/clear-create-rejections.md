---
"@sandbar-sdk/daytona": patch
"@sandbar-sdk/e2b": patch
"@sandbar-sdk/boxd": patch
"@sandbar-sdk/vercel": patch
---

When a provider refuses to create a sandbox (quota, permission, invalid request, rate limit), `create()` now rejects with a matching error code such as `FORBIDDEN` or `CAPACITY` and includes the provider's own reason, instead of reporting an unknown outcome. Server errors, lost responses and refusals after an image was already built still report an unknown outcome.
