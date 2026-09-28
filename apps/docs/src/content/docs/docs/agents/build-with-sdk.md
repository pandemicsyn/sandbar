---
title: Build with the SDK
description: A copyable prompt to get your coding agent building an application with Sandbar.
---

Replace the bracketed fields, then copy the prompt into your coding agent. Give it access to your project and the Sandbar documentation. Provider credentials belong in your environment, not in the prompt.

```text wrap title="Application prompt"
Build [describe the feature] in this project using the Sandbar TypeScript SDK.
Use [E2B or Daytona] as the sandbox provider.

Read these docs first:
- https://sandbarsdk.dev/docs/direct-quickstart/
- https://sandbarsdk.dev/docs/providers/support/
- https://sandbarsdk.dev/docs/reference/typescript/
- https://sandbarsdk.dev/docs/guides/recovery/

Inspect the project and installed package versions before changing code.
If packages are not published yet, use an available source checkout or
local packed artifacts. Do not substitute the unrelated npm package
named "sandbar".

Use Sandbar and Image from "sandbar-sdk", with e2b from
"sandbar-sdk/e2b" or daytona from "sandbar-sdk/daytona".
Run the SDK on the server and read credentials from environment variables.

Start from an existing prepared image. E2B can use the "base" template;
use /home/user for E2B file examples. For Daytona, use an active Linux
snapshot in the verified region and select "daytona-default" on both
connection and create unless strict blocked networking is explicitly
required and supported. Do not treat provider-default access as isolation.

Use argument arrays for commands. Use the explicit shell form only when
shell syntax is needed. Preserve byte output, check truncation, and handle
nonzero exits. Keep files and captured output within the documented bounds.

Destroy each owned sandbox in a finally block and close the client in an
outer finally block. Closing a client or aborting a wait does not stop
compute. Save recovery references for uncertain operations and observe
them without resubmitting the mutation.

Implement the feature with focused tests using deterministic fixtures.
Before live provider calls or image builds, get approval for the exact
resource budget and cleanup plan. Never log keys or recovery references.

Finish by explaining what changed, how to run it, which checks passed,
and any provider limitations or behavior that remains untested.
```

Need a new provider rather than an application? Use the [provider integration prompt](/docs/agents/build-a-provider/).
