---
"sandbar-sdk": major
"sandbar-adapter": major
---

Use MountSpec arrays on restore, matching create and volume.at descriptors. Support explicit Daytona daytona-default cold filesystem restore with exact selected volume IDs. Preserve selected mounts and acknowledged compute in uncertain restore outcomes. Older hooks reject nonempty arrays unless they declare mountInput: specs. SDK runtime keeps the deprecated empty-object alias in this coordinated release R and R+1; record R when versioning runs and remove the alias at the subsequent API release. Nonempty legacy maps reject with migration guidance.
