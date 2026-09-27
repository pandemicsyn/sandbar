---
title: Adapter capability checklist
description: Declare only native guarantees that the adapter can actually enforce.
---

| Capability | Provider obligation |
| --- | --- |
| Create | Verify image/account/region and network isolation before one native submission. Correlate the returned sandbox to the attempt. |
| Destroy | Attempt native compute cleanup; report `computeStopped: true` only after confirmation. |
| Scope | Authenticate authority and include every routing partition that changes native resource identity. Check it on every read and mutation. |
| Exec | Declare `argv` and/or `shell` accurately. Preserve binary stdout/stderr and apply the combined output bound. Disable hidden retries. |
| Files | Enforce byte bounds. Offer `overwrite: false` only with native atomic no-clobber semantics. |
| Inventory | Paginate and verify listed resource ownership, including detail reads when list payloads omit scope. |
| Recovery | Observe a previous submission without starting it again. Validate token version and native resource/operation correlation. |
| Close | Release owned local clients exactly once. Never imply that close or abort destroyed remote compute. |

`adapterSuite` from `@sandbar/adapter/testing` exercises required managed-compute scenarios and reports which ran. The built-in fake, Daytona, and Modal adapters run this suite against deterministic native boundaries. The suite does not certify an external provider's behavior by itself; its fixture must demonstrate that the native transport makes one outbound mutation attempt.
