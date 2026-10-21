---
"@sandbar-sdk/boat": minor
---

Stream command output on Boat. `box.processes.start({ output: { mode: "stream" } })` starts the command detached, without Boat's 600-second limit, and delivers stdout and stderr as UTF-8 text as Boat sends it, reattaching from byte offsets when Boat ends a connection after 10 minutes. `terminate()` stops the command. Byte output, callback exec, piped stdin, terminals and reopening are not supported.
