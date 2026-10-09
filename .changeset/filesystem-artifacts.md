---
"sandbar-sdk": minor
"sandbar-adapter": minor
---

Add portable directory browsing and metadata, incremental byte transfers, regular-file copy and same-filesystem move. Daytona and E2B implement the artifact workflow with bounded transfers and race-safe publication on compatible private Linux filesystems. Buffered file IO keeps its 1 MiB default and accepts explicit bounds up to 16 MiB. Transfer cancellation and failures retain known effects and staging paths. Add bounded directory traversal with explicit exclusions and incremental UTF-8 text lines with a maximum line length.
