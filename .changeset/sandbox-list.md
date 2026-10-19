---
"sandbar-sdk": minor
"@sandbar-sdk/adapter": minor
"@sandbar-sdk/daytona": minor
"@sandbar-sdk/e2b": minor
"@sandbar-sdk/boxd": minor
"@sandbar-sdk/vercel": minor
---

Add `sandboxes.list({ cursor?, limit? })`: a bounded page of sandboxes with `id`, `state` and a `reference` that `sandboxes.get()` reopens, plus `coverage` (`provider-scope` or `sandbar-managed`), matching `snapshots.list()` and `volumes.list()`. Adapters implement the optional `sandboxList` hook and return `reference: null` when native evidence cannot verify identity; listed references never claim ownership, generation or creation receipts the provider does not show. Daytona and E2B list Sandbar-created sandboxes with `verified-created` references; boxd and Vercel list with `unknown` ownership. `operations.inventory()` is unchanged and is derived from `sandboxList` when an adapter only implements the new hook.
