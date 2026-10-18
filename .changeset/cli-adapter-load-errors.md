---
"@sandbar-sdk/cli": patch
---

Report an installed adapter that fails to load as `ADAPTER_LOAD_FAILED` (exit 4) with the adapter's own error, instead of calling it not installed, and resolve adapter packages whose `exports` use nested conditions.
