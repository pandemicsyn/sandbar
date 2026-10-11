---
"sandbar-sdk": patch
---

Stop buffered process lines and final partial lines promptly when their observation signal is aborted. Report pre-aborted process signals with no possible remote effect, without dispatching or consuming the shared signal request.
