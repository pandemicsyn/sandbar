---
"sandbar-sdk": minor
---

Configure writable-volume cleanup once with `Sandbar.connect(adapter, { cleanup: { storage: "allow-unconfirmed" } })`. Explicit destroy/submitDestroy options override the connection policy; unconfigured connections retain the require-durable default. Compute cleanup retains volumes and reports actual durability without claiming flushed writes.
