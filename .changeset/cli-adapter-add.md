---
"@sandbar-sdk/cli": minor
---

Add `sandbar adapter add`, `adapter ls` and `adapter rm` to install, list and remove the adapters the CLI loads from `~/.config/sandbar/adapters`. Official adapters are pinned to the CLI's version and every install is checked for its adapter export; reruns with nothing to change skip npm.
