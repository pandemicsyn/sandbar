---
"@sandbar-sdk/daytona": minor
---

Daytona Linux VM sandboxes now support `snapshot()` (cold, filesystem-only capture, restored as a new Linux VM) and `suspend()`/`resume()` through native pause, which keeps files, memory and running processes. Containers are unchanged. `lifecycle.suspension.preserve: "filesystem+memory"` no longer rejects at connect: it pauses Linux VMs and rejects containers before any change, while `"filesystem"` stops Linux VMs instead of pausing them. `inspect().idleStop` reports Daytona's native Linux VM auto-pause.
