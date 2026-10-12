---
title: Build with the SDK
description: A copyable prompt to get your coding agent building an application with Sandbar.
---

Replace the bracketed fields, then copy the prompt into your coding agent. Give it access to your project and the Sandbar documentation. Provider credentials belong in your environment, not in the prompt.

```text wrap title="Application prompt"
Build [describe the feature] in this project using the Sandbar TypeScript SDK.
Use [Daytona, E2B, boxd or Vercel] as the sandbox provider.
Read that provider's setup guide and supported operations before choosing a workflow.

Read these docs first:
- https://sandbarsdk.dev/docs/direct-quickstart/
- https://sandbarsdk.dev/docs/providers/support/
- https://sandbarsdk.dev/docs/reference/typescript/
- https://sandbarsdk.dev/docs/guides/recovery/
- https://sandbarsdk.dev/docs/guides/runnable-agent-examples/
- https://github.com/pandemicsyn/sandbar/blob/main/examples/README.md

Inspect the project and installed package versions before changing code.
Sandbar packages are currently unpublished. Use an available source
checkout or local packed artifacts; follow the checkout setup in the docs. Do not substitute the unrelated npm package
named "sandbar".

Use Sandbar and Image from "sandbar-sdk", with e2b from
"@sandbar-sdk/e2b", daytona from "@sandbar-sdk/daytona", boxdAdapter from
"@sandbar-sdk/boxd", or vercel from "@sandbar-sdk/vercel". Use the selected
provider guide's connection form; boxd and Vercel take definition/config/credentials.
Run the SDK on the server and read credentials from environment variables.

Start from an existing prepared image. E2B can use the "base" template;
use /home/user for E2B file examples. For Daytona, use an active Linux
snapshot in the verified region and configure "daytona-default" at connection
setup unless strict blocked networking is explicitly required and supported. Do not treat provider-default access as isolation.

Vercel defaults to disposable Node 24 in iad1 with vercel-deny-all. It supports
bounded byte output and overwrite-only files, without stdin, process streams,
snapshots or volumes; cleanup stops compute and retains named metadata.
boxd requires an explicit internet policy and also requires overwrite:true.
Neither provider inherits Daytona/E2B streaming or storage guarantees.

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
