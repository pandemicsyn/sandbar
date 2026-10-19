---
"@sandbar-sdk/cli": minor
---

Add `sandbar ls --remote`, which lists the selected profile's sandboxes from the provider and matches them to store names, and `sandbar adopt <id> [--name <name>]`, which records a listed sandbox so other commands can reach it. Adopted sandboxes are not treated as created by the CLI: `rm --all` skips them and `rm <name>` needs `--force`.
