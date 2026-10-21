---
"@sandbar-sdk/vercel": minor
"@sandbar-sdk/runloop": minor
---

Accept the `snapshots: { preserve }` setup option on the Vercel and Runloop adapters, so the same setting works on every adapter with snapshots. `Preserve.FILESYSTEM` matches their filesystem-only snapshots; `Preserve.FILESYSTEM_AND_MEMORY` rejects at connect with `UNSUPPORTED` before any provider call.
