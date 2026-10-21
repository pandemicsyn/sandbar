---
"@sandbar-sdk/modal": minor
---

Stream command output on Modal. `box.processes.start({ output: { mode: "stream" } })` delivers stdout and stderr as the command writes them, as text or exact bytes, accepts piped stdin, and supports `signal("SIGTERM" | "SIGKILL")` and `terminate()`. `box.exec(input, { onOutput })` now works on Modal too. Signals reach the launched process through a PID recorded in `/tmp`, so the image needs `/bin/sh`, `cat` and `kill`. Terminals, status checks and process reopening are not supported.
