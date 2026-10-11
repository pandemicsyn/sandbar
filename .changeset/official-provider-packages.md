---
"@sandbar-sdk/adapter": minor
"sandbar-sdk": minor
"@sandbar-sdk/daytona": minor
"@sandbar-sdk/e2b": minor
---

Distribute the official Daytona and E2B integrations as separately installed @sandbar-sdk/daytona and @sandbar-sdk/e2b packages. Move the shared binding helper and portable image input types into @sandbar-sdk/adapter. Remove unpublished SDK provider subpaths and native E2B dependencies from core; update imports and install the selected adapter. Preserve provider IDs, defaults, lifecycle and recovery behavior, and coordinate all four packages in the initial lockstep release group.
