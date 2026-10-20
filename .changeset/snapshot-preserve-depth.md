---
"@sandbar-sdk/adapter": minor
"sandbar-sdk": minor
"@sandbar-sdk/e2b": minor
---

Add `Preserve` constants (`Preserve.FILESYSTEM`, `Preserve.FILESYSTEM_AND_MEMORY`) for choosing what snapshots and suspension keep. E2B accepts `snapshots: { preserve }` for filesystem-only captures, and `lifecycle.suspension.preserve` is now an exact choice: `Preserve.FILESYSTEM` pauses without memory, so resume cold-boots. Previously a filesystem setting on E2B still kept memory. E2B snapshots listed without Sandbar history now report unknown preservation instead of assuming memory.
