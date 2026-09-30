---
"sandbar-sdk": minor
"sandbar-adapter": minor
---

Expose provider and native ID on snapshot/volume handles, preserve immutable saved resource identities, and expose confirmed partial captures and retained volume references directly on existing errors. Narrow recovered native operation result types without changing saved operation formats. Applications persist ordinary returned resource references themselves; no expanded journal, persistence hook or continuation-advice framework is required.
