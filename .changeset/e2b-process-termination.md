---
"sandbar-sdk": minor
"sandbar-adapter": minor
---

Add E2B process-handle termination with one bounded native SIGKILL request, independently cancellable shared waits and cached outcomes without redispatch. Document PID reuse and descendant limits, preserve native terminal integers, and keep output/wait/detach behavior separate from remote termination. Unsupported or inactive handles reject before a new request.
