---
title: Sandbar SDK
description: Create sandboxes, run code, and move files with one TypeScript SDK for Daytona and E2B.
---

Sandbar is a server-side TypeScript SDK for creating sandboxes, running commands, and moving files across providers. **Daytona and E2B are built in.** Other providers can integrate through the public adapter API.

Start with [Getting started](/docs/direct-quickstart/) to run your first command and clean up the sandbox. This site documents the current source build; packages are not yet published.

## Build with an agent

Copy a prompt to give your coding agent the right imports, examples, and constraints:

- [Build an application with Sandbar](/docs/agents/build-with-sdk/)
- [Build a provider integration for Sandbar](/docs/agents/build-a-provider/)

## Use the SDK

| Task                                 | Guide                                                        |
| ------------------------------------ | ------------------------------------------------------------ |
| Create a sandbox and run commands    | [Sandboxes and execution](/docs/guides/resources/)           |
| Read and write files, capture output | [Files and output](/docs/guides/files-and-output/)           |
| Choose an image or build one         | [Images and networking](/docs/guides/images-and-networking/) |
| Save snapshots or reuse volumes      | [Snapshots and volumes](/docs/guides/snapshots-and-volumes/) |
| Handle a timeout or lost response    | [Errors and recovery](/docs/guides/recovery/)                |
| Fix common setup issues              | [Troubleshooting](/docs/guides/troubleshooting/)             |

## Choose a provider

The [Tested provider support](/docs/providers/support/) matrix shows which operations have been exercised against real providers, along with the tested configuration and limits. See the [Daytona](/docs/providers/daytona/) and [E2B](/docs/providers/e2b/) guides for connection settings.

For API details, use the [TypeScript reference](/docs/reference/typescript/). To add a provider, start with [Write an adapter](/docs/guides/write-an-adapter/).
