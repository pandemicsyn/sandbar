---
title: Troubleshooting
description: Resolve package, connection, execution, file, and cleanup issues.
---

## Package or import not found

The current packages are unpublished, so registry installs will not work until release. The [getting started guide](/docs/direct-quickstart/) shows the upcoming consumer installation flow. If working from a source checkout, use its workspace packages or packed artifacts. Do not install the unrelated `sandbar` npm package.

Built-ins import from `sandbar-sdk/daytona` and `sandbar-sdk/e2b`. The experimental Modal adapter is a separate `sandbar-modal` package; `sandbar-sdk/modal` is not an export.

## Connection rejected

Check that the API key is available to the server process. E2B needs `E2B_API_KEY`, not `E2B_API_ID`. Daytona also needs a target matching an available native region, such as `us`.

`Sandbar.connect` verifies credentials and scope with authenticated reads. A successful connection does not guarantee every image, policy, or operation is available. Read the relevant [provider setup guide](/docs/providers/support/).

## Daytona creation reports unsupported networking

For Daytona's default restrictions, set `networkPolicy: "daytona-default"` on **both** the connection and create request. Omitting the policy selects strict `blocked`, which requires separate eligibility verification and can be unavailable. Sandbar does not silently relax the policy.

## A command cannot run

Check the prepared image contains the executable and any required shell utilities. Argument arrays are literal; use `{ command: { kind: "shell", script: "..." } }` for pipes or redirection. Handle `NonzeroExitError` to inspect a completed command's exit code and stderr.

## A file write fails

Use an absolute path in an existing writable directory, keep the payload at or below 1 MiB, and set `overwrite: true` only when replacing an existing file is intended. Use `/home/user` for E2B examples. No-clobber writes need compatible hard-link support and `ln -T`.

## A timeout leaves the outcome unknown

A request/RPC timeout does not prove a command exited or stopped. E2B’s pinned command timeout is an RPC observation limit; Daytona and Modal document native process bounds with deployed wrapper/descendant limits unverified. `deadlineSeconds` is not a total SDK wait timer. Provide a caller signal for a local waiting budget; it does not kill compute. See [execution and waiting timeouts](/docs/guides/resources/#execution-and-waiting-timeouts).

Do not submit the same operation again automatically. Successful command status with unavailable output can still leave the public outcome unconfirmed. Save the recovery reference, reconnect in the same scope if needed, and observe the original attempt. See [Errors and recovery](/docs/guides/recovery/).

## A sandbox is still running after close

`close()` releases the client. It does not destroy sandboxes, and aborting a wait does not stop provider compute. Call `box.destroy()` explicitly and confirm its outcome. Built images can remain after sandbox destruction and require separate owned-artifact cleanup.
