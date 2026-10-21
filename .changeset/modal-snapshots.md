---
"@sandbar-sdk/modal": minor
---

Add filesystem snapshots to the experimental Modal adapter. `box.snapshot()` captures the sandbox root filesystem as a Modal image with Modal's default 30-day retention, `snapshot.restore()` creates a new blocked-network sandbox from it, and `snapshots.get()`, `inspect()` and `delete()` work on saved references. Memory snapshots, directory snapshots and `snapshots.list()` are not supported: Modal has no snapshot listing API, so keep the returned references.
