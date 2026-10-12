---
title: Sandbar SDK
description: Create sandboxes, run code, and move files with one TypeScript SDK for Daytona, E2B, boxd and Vercel.
---

Sandbar is a server-side TypeScript SDK for creating sandboxes, running commands, and moving files across providers. **Daytona, E2B, boxd and Vercel are separately installed adapters.** Other providers can integrate through the public adapter API.

Start with [Getting started](/docs/direct-quickstart/) to run your first command and clean up the sandbox. This site documents the current source build; packages are not yet published.

Run OpenCode inside a sandbox with the [runnable agent examples](/docs/guides/runnable-agent-examples/): capture a response or upload a file, ask the agent to edit it, and read it back. The guide includes checkout setup for Daytona and E2B.

## Build with an agent

Copy a prompt to give your coding agent the right imports, examples, and constraints:

- [Build an application with Sandbar](/docs/agents/build-with-sdk/)
- [Build a provider integration for Sandbar](/docs/agents/build-a-provider/)

## Use the SDK

| Task                                  | Guide                                                        |
| ------------------------------------- | ------------------------------------------------------------ |
| Create a sandbox and run commands     | [Sandboxes and execution](/docs/guides/resources/)           |
| Read and write files, capture output  | [Files and output](/docs/guides/files-and-output/)           |
| Stream process text or use a terminal | [Processes and streaming](/docs/guides/text-streaming/)      |
| Access a sandbox HTTP service         | [HTTP previews](/docs/guides/preview-access/)                |
| Choose an image or build one          | [Images and networking](/docs/guides/images-and-networking/) |
| Save snapshots or reuse volumes       | [Snapshots and volumes](/docs/guides/snapshots-and-volumes/) |
| Handle a timeout or lost response     | [Errors and recovery](/docs/guides/recovery/)                |
| Fix common setup issues               | [Troubleshooting](/docs/guides/troubleshooting/)             |

## Choose a provider

The [Tested provider support](/docs/providers/support/) matrix shows which operations have been exercised against real providers, along with the tested configuration and limits. Choose setup and limits for your adapter:

| Adapter                                   | Current scope and evidence                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [Daytona](/docs/providers/daytona/)       | Execution, files, processes and native storage/lifecycle features; dated live evidence in the support matrix.                                  |
| [E2B](/docs/providers/e2b/)               | Execution, files, processes and native snapshots/lifecycle; measured blocked-network failure remains documented.                               |
| [boxd](/docs/providers/boxd/)             | Experimental microVM adapter with a live baseline for lifecycle, execution, files and reopening; broader features remain unqualified.          |
| [Vercel Sandbox](/docs/providers/vercel/) | Disposable Node 24 sessions, bounded binary execution and overwrite-only files; cleanup retains named metadata. Live qualification is not-run. |
| [Modal](/docs/direct-quickstart/)         | Experimental adapter with offline coverage; outside the initial release group.                                                                 |

For API details, use the [TypeScript reference](/docs/reference/typescript/). To add a provider, start with [Write an adapter](/docs/guides/write-an-adapter/).
