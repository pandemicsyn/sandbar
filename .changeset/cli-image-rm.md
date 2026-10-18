---
"@sandbar-sdk/cli": minor
---

`sandbar image rm <name>` deletes a built image on the provider and drops its record; an unknown outcome exits 6 and keeps the record so a later `image rm` checks how the delete ended without resending it. `sandbar image ls --remote` lists the provider's images for the profile.
