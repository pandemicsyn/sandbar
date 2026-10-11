---
"sandbar-sdk": patch
---

Validate callback exec deadlines and advertised capture limits before dispatch, preserve original observation failures as causes, and clarify the explicit sustained-output profile. E2B bounded execution now retains validated exit status and available bytes when output retrieval fails, reporting incomplete capture rather than an unknown execution outcome. Callback deadlines remain unsupported on the current native process paths; local cancellation does not guarantee remote termination.
