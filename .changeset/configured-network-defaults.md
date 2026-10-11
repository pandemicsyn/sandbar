---
"sandbar-sdk": minor
"sandbar-adapter": minor
"sandbar-daytona": minor
"sandbar-e2b": minor
---

Resolve omitted create and restore network policies from adapter setup, with blocked as the fallback for existing adapters. Daytona uses its configured policy; E2B accepts a blocked/internet setup default. SDK snapshot restore now accepts omitted input while native requests remain fully resolved. New recovery references retain the effective policy.
