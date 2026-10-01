---
"sandbar-sdk": minor
"sandbar-adapter": minor
---

Add finite E2B text streaming through sandbox.processes.start with bounded separate stdout/stderr, ordinary confirmed exit results and prompt local wait/output cancellation and detach. Other adapters and requested runtime deadlines reject before dispatch. Preserve bounded exec binary capture; no process reopening, stdin or remote kill is added.
