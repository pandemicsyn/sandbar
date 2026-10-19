---
"sandbar-sdk": minor
"@sandbar-sdk/adapter": minor
---

Add the portable `resources: { vcpus, memoryMiB }` adapter setting, given as minimums, and `inspect().resources`, which reports the size a sandbox actually has or `unknown`. Adapter authors get `ResourceMinimums`, `SandboxResources` and `smallestSize()`, which picks the smallest native size that meets the minimums and otherwise throws `UNSUPPORTED` naming the largest size. `SandboxInfo.resources` is optional for adapters; the SDK always fills it in.
