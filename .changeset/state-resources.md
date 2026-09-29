---
"sandbar-adapter": minor
"sandbar-sdk": minor
---

Add scoped direct SDK snapshot capture, inspect, restore, inventory and explicit deletion, plus retained volumes and verified create-time mounts. Use no-argument provider-native defaults: Daytona stop/capture/restart with fresh execution and E2B filesystem/RAM capture with native resumed-process semantics. E2B restore uses the immutable captured template/build UUID selector and verifies its containing template for snapshot deletion; create-time mounts remain unsupported. Explicit snapshot and volume deletion accept caller-selected artifacts after native identity, scope and dependency checks, while automatic cleanup requires correlated creation evidence. E2B containing-template deletion has no native transactional generation precondition, so concurrent external mutation remains a native limitation. Optional requirements validate the configured default; results and inspected artifacts report preservation and restored execution. Map distinct native profiles with no-replay recovery and explicit unconfirmed writable-mount durability. Keep service state operations unsupported.
