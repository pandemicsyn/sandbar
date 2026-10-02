---
"sandbar-sdk": minor
"sandbar-adapter": minor
---

Add `box.preview(port, { signal? })` with ephemeral public or protected HTTP access information. Daytona supports private header authentication; E2B supports explicit public setup and now disables inbound public traffic by default during creation/restore. Unsupported protected E2B token lookup and sandbox-wide Daytona public publication remain explicit, without hidden resume, server start or outbound policy changes.
