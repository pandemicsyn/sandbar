---
"sandbar-sdk": patch
---

Honor E2B's fixed trusted guest-routing default when native sandbox details omit the domain or return null. Preserve running-state, token, version and auto-resume checks; reject foreign routing without calling mutating connect.
