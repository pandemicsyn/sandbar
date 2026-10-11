---
"sandbar-sdk": minor
"@sandbar-sdk/adapter": minor
---

Add canonical ConnectOptions and CloseOptions with setup cancellation and bounded local waits. Compatibility change: connect defaults to 30 seconds and each close wait defaults to 5 seconds. An abandoned setup releases local resources, including late registrations, without deleting remote resources. Close starts cleanup once; later calls can wait on the same attempt after a timeout or abort. Adapter host cleanup diagnostics cannot replace initiating failures.
