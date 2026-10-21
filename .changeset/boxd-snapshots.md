---
"@sandbar-sdk/boxd": minor
---

boxd now supports snapshots: `box.snapshot()` captures memory and disk with a brief pause while the machine keeps running, `snapshot.restore()` resumes the captured processes in a new machine, and snapshots can be inspected, listed and deleted. Each capture gets its own boxd snapshot name and the reference pins the captured version, so a snapshot saved again outside Sandbar fails with `CONFLICT` instead of restoring or deleting a different version. Machines with mounted disks cannot be captured, and restores keep the captured size and attach no disks.
