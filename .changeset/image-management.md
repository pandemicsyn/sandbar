---
"sandbar-sdk": minor
"@sandbar-sdk/adapter": minor
---

Add `client.images.get()`, `client.images.list()` and image handles with `inspect()`, `delete()` and `submitDelete()`. `images.build()` results now include `reference`, an image resource reference whose ownership is `verified-created` only when the adapter proved the build created it. Adapters opt in with the `imageInspect`, `imageList`/`imageListCoverage` and `imageDelete` hooks, and `capabilities().imageManagement` reports what a connection supports; a missing hook rejects with `UNSUPPORTED`. Image deletion follows the snapshot deletion rules: scope checks, no deletion of borrowed images as a side effect, `OUTCOME_UNKNOWN` on an unconfirmed result and no replay.
