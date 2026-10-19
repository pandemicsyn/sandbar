---
"@sandbar-sdk/boxd": minor
"@sandbar-sdk/vercel": minor
"@sandbar-sdk/boat": minor
"@sandbar-sdk/daytona": minor
"@sandbar-sdk/e2b": minor
---

Accept `resources: { vcpus, memoryMiB }` minimums and report the real size on inspect. boxd, Vercel and Boat pick their smallest native size that meets them and reject at connect, before any provider request, when none does; the old `size`, `vcpus` and `machine` keys stay as deprecated aliases. Daytona and E2B build OCI snapshots and templates at that size and reject a prepared snapshot or template that is smaller or does not report its size, including E2B's `base` template.
