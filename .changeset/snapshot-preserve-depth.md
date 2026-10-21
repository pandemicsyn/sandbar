---
"@sandbar-sdk/adapter": minor
"sandbar-sdk": minor
"@sandbar-sdk/e2b": minor
---

Add `Preserve` constants (`Preserve.FILESYSTEM`, `Preserve.FILESYSTEM_AND_MEMORY`) for choosing what snapshots and suspension keep. E2B accepts `snapshots: { preserve }` for filesystem-only captures, and `lifecycle.suspension.preserve` is now an exact choice: `Preserve.FILESYSTEM` pauses without memory, and resumes from disk only, so `resume()` reports fresh execution. Previously a filesystem setting on E2B still kept memory. E2B snapshots listed without Sandbar history now report unknown preservation instead of assuming memory. `snapshots.list()`, `volumes.list()` and `images.list()` now default to a page of 50 when called without a `limit`.
