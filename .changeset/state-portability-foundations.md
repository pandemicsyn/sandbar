---
"sandbar-adapter": minor
"sandbar-sdk": minor
---

Add scoped, versioned resource reference descriptors and read-only state capability/profile checks on SDK clients. Create requests can require exact future snapshot guarantees and reject unsupported or unknown evidence before native effects. Recovery remains observation-only. Public snapshot, volume, mount, and lifecycle mutations are deferred.

The direct capability getter is now asynchronous; await `client.capabilities()` and `box.capabilities()`.
