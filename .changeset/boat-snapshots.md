---
"@sandbar-sdk/boat": minor
---

Boat snapshots: `box.snapshot()` saves the disk of a running or archived sandbox as a Boat named snapshot under a unique `sandbar-snapshot-*` name, and `client.snapshots` inspects, lists, restores and deletes them. References pin the captured artifact, so a name saved again outside Sandbar rejects with `CONFLICT` instead of restoring or deleting the new contents. Restores boot a fresh machine of the captured type. Setup accepts `snapshots: { preserve }` and `lifecycle: { suspension: { preserve } }`: Boat keeps the disk only, so `Preserve.FILESYSTEM` is accepted and `Preserve.FILESYSTEM_AND_MEMORY` fails with `UNSUPPORTED` at connect, before any provider call.
