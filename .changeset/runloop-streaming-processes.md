---
"@sandbar-sdk/runloop": minor
---

Stream command output on Runloop. `box.processes.start({ output: { mode: "stream" } })` delivers stdout and stderr as UTF-8 text from Runloop's server-sent log streams, reopening them from byte offsets, and `terminate()` kills the execution. Byte output, callback exec, piped stdin, terminals and reopening are not supported. Not yet tested against the live service.
