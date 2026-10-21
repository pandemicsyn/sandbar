---
"@sandbar-sdk/boxd": minor
---

Stream command output on boxd. `box.processes.start({ output: { mode: "stream" } })` now delivers stdout and stderr as the command writes them, as text or exact bytes (`format: "bytes"`), and `box.exec(input, { onOutput })` streams while returning the usual bounded capture. `terminate()` cancels the native exec call, which kills the command's process group. Incremental stdin, terminals, other signals, status checks and process reopening are not supported.
