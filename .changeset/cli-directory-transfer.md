---
"@sandbar-sdk/cli": minor
---

Copy directories with `sandbar cp -r` in both directions, and send a local working tree into a sandbox with `sandbar push <sandbox>[:/dir] [path]` or `sandbar run --push <path>`. In a git work tree, `push` sends tracked and unignored files only (`--include-ignored` sends everything); `--exclude <glob>` skips paths. Transfers move one tar archive and unpack it with one command, so they keep modes and symlinks, need `tar` in the sandbox, and work on every provider with exec and file access. Copying out never writes through symlinks or outside the destination.
