---
"@sandbar-sdk/daytona": patch
"@sandbar-sdk/e2b": patch
---

`daytona({...})` and `e2b({...})` now accept `resources: { vcpus, memoryMiB }`, matching the adapter configuration. The `daytona()` network setting's documentation now names `daytona-default` as the default.
