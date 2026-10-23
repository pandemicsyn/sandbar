---
"@sandbar-sdk/cli": minor
---

Add `create --retry <duration>` and `run --retry <duration>`: keep retrying, with growing waits, while the provider refuses a create before any effect (rate limit, capacity, unavailable). Unknown outcomes are never retried.
