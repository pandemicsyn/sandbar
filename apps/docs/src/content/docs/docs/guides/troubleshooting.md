---
title: Troubleshooting
description: Resolve package, connection, execution, file, and cleanup issues.
---

## Package or import not found

Install `sandbar-sdk` and your adapter package at `0.1.0` or later; `0.0.0` versions are empty placeholders. See [Getting started](/docs/direct-quickstart/). The unrelated `sandbar` npm package is not this SDK.

Import the SDK from `sandbar-sdk` and your adapter from its separate package:

- `@sandbar-sdk/daytona`
- `@sandbar-sdk/e2b`
- `@sandbar-sdk/boxd`
- `@sandbar-sdk/vercel`

The experimental Modal adapter is `@sandbar-sdk/modal`; `sandbar-sdk/modal` is not an export.

## Connection rejected

Check that credentials are available to the server process, then check the adapter's required setup:

| Provider | Check                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------- |
| E2B      | Pass an API key, commonly stored as `E2B_API_KEY`. `E2B_API_ID` is not an API key.                 |
| Daytona  | Pass `apiKey` and an available target region, such as `target: "us"`.                              |
| boxd     | Pass a member API key, your authenticated default organization ID/slug, and `network: "internet"`. |
| Vercel   | Pass a bearer token with access to the configured `teamId`, `projectId` and sandbox API.           |

`Sandbar.connect` verifies credentials and scope using provider reads. Connecting successfully does not guarantee access to every image, policy or operation. Follow the [provider setup guides](/docs/providers/support/) for account and configuration limits.

## Daytona creation reports unsupported networking

To use Daytona's organization-managed restrictions, set `network: "daytona-default"` in adapter setup (or `network: "internet"` on Tier 3 and above). Omitted create and restore policies inherit that value; you do not need to repeat it on each call.

Omitting the policy during setup selects strict `blocked`, which requires verified organization eligibility and can be unavailable. An explicit per-call policy must match the connection's policy. Sandbar does not silently relax it. See [Daytona networking](/docs/providers/daytona/#choose-the-policy-deliberately).

## A command cannot run

Check that the sandbox image contains the executable and required shell utilities. Argument arrays pass each argument literally. Use `{ command: { kind: "shell", script: "..." } }` when you need shell features such as pipes or redirection.

A confirmed nonzero exit throws `NonzeroExitError`. Its `result` contains the exit code and captured stderr; the command did run. If the sandbox is suspended, explicitly resume it before guest work. See [Sandbox and execution](/docs/guides/resources/).

## A file write fails

Use an absolute path whose parent directory exists and is writable. Buffered file operations default to **1 MiB**. The SDK accepts `maxBytes` up to **16 MiB**, but the adapter can enforce a lower limit: boxd and Vercel cap files at 1 MiB. For larger transfers on a supporting adapter, see [Files and output](/docs/guides/files-and-output/).

By default, writes must leave existing files untouched. Daytona and E2B support this on the private sandbox filesystem when the image has GNU-compatible `ln -T` and hard-link support. Use `/home/user` for the tested E2B workflow; other directories may have different permissions.

boxd, Vercel and Daytona's mounted volumes do not support atomic no-clobber writes. They require `{ overwrite: true }` even for a new destination. Use it only when your application accepts replacing any file already at that path. A completed write to mounted storage does not prove shutdown durability.

## A timeout leaves the outcome unknown

A request timeout does not prove a command exited, stopped or had no side effects. `deadlineSeconds` has provider-specific behavior and is not a timer for the whole SDK call. Pass a caller signal to limit local waiting; it does not kill compute. See [execution and waiting timeouts](/docs/guides/resources/#execution-and-waiting-timeouts).

Do not automatically submit the operation again. If the error includes a recovery reference, save it and use the same provider scope to observe the original attempt. Recovery can still be unable to establish the result, especially if a launch response was lost before the provider ID was known.

Output can also be incomplete even when an exit is known. E2B retains a validated exit marker and available bytes, marking the result `truncated: true` when a captured stream cannot be read. Inspect the result and error details rather than treating missing output as proof of failure or success. See [Results, errors and saved resources](/docs/guides/recovery/).

## A sandbox is still running after close

`close()` releases the client. It does not destroy sandboxes, and cancelling a wait does not stop provider compute. Call `box.destroy()` explicitly and confirm its outcome; if cleanup is uncertain, save its recovery reference instead of repeating deletion.

Built images, snapshots and volumes have separate lifecycles and may remain after sandbox destruction. Delete only resources your application intends to remove, following their ownership and dependency checks. See [Images and networking](/docs/guides/images-and-networking/) and [Snapshots and volumes](/docs/guides/snapshots-and-volumes/).
