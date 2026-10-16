---
"@sandbar-sdk/daytona": minor
---

Disable Daytona's native 15-minute idle auto-stop by default so sandboxes keep running, including quiet background processes, until their configured lifetime ends. Add `lifecycle.idleSeconds` to opt into idle stopping; seconds round up to whole minutes and `inspect()` reports the resulting idle-stop policy.
