---
"sandbar-sdk": minor
---

Add opt-in `client.sandboxes.with(input, callback, options)` for one owned sandbox with bounded cleanup independent of work cancellation. Export `SandboxCleanupError` with callback outcome, cleanup failure and owned-resource/operation recovery evidence. Manual lifecycle APIs and retained storage remain unchanged.
