---
"sandbar-sdk": patch
---

Streamed process text counts UTF-8 bytes without allocating per character, so large outputs no longer stall on CPU and garbage collection.
