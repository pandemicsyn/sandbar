---
"@sandbar-sdk/boxd": minor
---

boxd accepts `snapshots: { preserve }` and `lifecycle: { suspension: { preserve } }` in setup. boxd snapshots and pauses always keep memory, so `Preserve.FILESYSTEM_AND_MEMORY` is accepted and `Preserve.FILESYSTEM` fails with `UNSUPPORTED` at connect, before any provider call.
