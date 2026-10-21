---
"@sandbar-sdk/daytona": minor
---

Accept `snapshots: { preserve }` on the Daytona adapter. `Preserve.FILESYSTEM_AND_MEMORY` takes hot snapshots of running Linux VMs (`includeMemory: true`): the VM keeps running and a restored VM resumes the captured processes. Containers and stopped VMs reject before any change. Omitted or `Preserve.FILESYSTEM` keeps today's cold capture.
