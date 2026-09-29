---
"sandbar-adapter": minor
"sandbar-sdk": minor
---

Add scoped direct SDK snapshot capture, inspect, restore, inventory and owned deletion, plus retained volumes and verified create-time mounts. Use no-argument provider-native defaults: Daytona stop/capture/restart with fresh execution and E2B filesystem/RAM capture with native resumed-process semantics. E2B restore and create-time mounts are unsupported because its pinned native API cannot bind immutable build and volume identities; capture and owned artifact management remain independent. Optional requirements validate the configured default; results and inspected artifacts report preservation and restored execution. Map distinct native profiles with no-replay recovery and explicit unconfirmed writable-mount durability. Keep service state operations unsupported.
