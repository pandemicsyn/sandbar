---
title: Sandboxes and execution
description: Create sandboxes, run commands, inspect state, and release compute.
---

A sandbox is a remote environment where you can run commands and work with files. The examples below use a Sandbar client named `sandbar`, created with your chosen adapter as shown in [Getting started](/docs/direct-quickstart/).

Adapter setup supplies the defaults for sandbox creation. Available operations and lifecycle behavior depend on the adapter; provider differences are called out below.

## Create and clean up

Use `sandboxes.with()` for a task that needs a sandbox only while it runs:

```ts
try {
  const text = await sandbar.sandboxes.with(
    {}, // Uses the configured adapter defaults.
    async (box) => {
      console.log(box.id, (await box.inspect()).state);
      return (await box.exec(["printf", "hello"])).stdoutText();
    },
  );
  console.log(text); // Returned after sandbox cleanup is confirmed.
} finally {
  await sandbar.close();
}
```

`with()` creates one sandbox, passes it to your callback, and attempts to destroy it when the callback finishes, throws, or is cancelled. It does not delete retained snapshots or volumes. After cleanup succeeds, it returns the callback's value or rethrows the callback's error.

Use `sandboxes.create()` and `box.destroy()` when you need to manage the sandbox's lifetime yourself. Reopening an existing sandbox with `sandboxes.get()` does not arrange automatic cleanup.

**`close()` does not destroy a sandbox.** It releases local client resources. Destroy compute you no longer need, and close the client after your work and cleanup finish.

### Cleanup options and failures

The third argument to `with(input, callback, options)` accepts:

| Option             | Purpose                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`           | Stop waiting for the callback and begin cleanup when cancelled. Pass the same signal to operations inside the callback too.                  |
| `cleanupTimeoutMs` | Give cleanup its own time limit, independent of the work signal. Defaults to 30,000 ms; accepts integers from 1 to 300,000.                  |
| `storage`          | Override the connection's storage cleanup policy with `"require-durable"` or `"allow-unconfirmed"`. Neither option deletes retained storage. |

Cancellation cannot force JavaScript in your callback to stop. A callback that ignores the signal can keep running while cleanup starts. Stopping local waiting also does not prove that a remote command stopped.

If destruction fails or cannot be confirmed, `with()` throws `SandboxCleanupError`. It keeps both the work result and the cleanup failure:

- `callbackOutcome`: the callback's completed value, thrown error, or local cancellation error.
- `cleanupError`: the destruction error.
- `sandboxId` and `sandboxReference`: the sandbox's available identity.
- `cleanupOperation` and `cleanupReference`: available cleanup recovery information.
- `outcome`: any confirmed partial cleanup result.

Save recovery references from both work and cleanup errors when present. [Recover the original operation](/docs/guides/recovery/) before deciding what to do next. The [runnable examples](/docs/guides/runnable-agent-examples/) show how to report these failures.

If creation itself has an uncertain outcome, `with()` throws the original error. It does not run your callback or try to destroy a sandbox whose identity is unknown.

## Reopen and manage lifetime

Save the complete `box.reference` in storage your application controls. Later, use a new client with current credentials for the same provider and scope, such as the original team, project, organization, and region:

```ts
const box = await freshClient.sandboxes.get(savedReference);
const info = await box.inspect();
if (info.expires.status === "known") console.log(info.expires.at, info.expires.scope);
```

`get()` reopens the same sandbox. It does not create a replacement, resume it, or extend its lifetime. `inspect()` reads its current state. Commands and file access require a running sandbox.

A missing or deleted sandbox returns `NOT_FOUND`. Other problems, such as denied access or a scope mismatch, have their own errors. A saved reference cannot move a sandbox to another provider.

`box.reference` can be `null`, including when an adapter cannot verify identity during creation. Try `inspect()` and check its returned `reference`; do not construct one from `box.id`. For E2B credential rotation, configure the verified `teamId` when establishing the original connection. See the [reopening example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-reopen.ts).

Inspection reports state, provider state, observation time, expiry, idle-stop policy, retention policy, and execution identity when known. Unknown expiry does not mean unlimited lifetime. A past expiry time alone does not prove that the sandbox was deleted.

### Renew lifetime

On E2B and Daytona, set `lifecycle: { lifetimeSeconds: 600 }` in adapter setup for the initial lifetime and the default `renew()` window. Supply this option instead of E2B's `timeoutSeconds` or Daytona's `ttlMinutes`, not alongside it.

While the sandbox is running:

```ts
const renewed = await box.renew(); // Uses this connection's configured window.
console.log(renewed.requested.forSeconds, renewed.observation?.expires);
await box.renew({ forSeconds: 61 }); // Requests a different window.
```

Renewal sets a new expiry window from when the provider processes the request. It does **not** add time to the old deadline, and can shorten a longer lifetime.

| Adapter                                                         | Renewal window                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [E2B](/docs/providers/e2b/#configured-lifetime-renewal)         | Positive integer seconds, raised to at least 60 seconds; maximum 3,600 seconds.                |
| [Daytona](/docs/providers/daytona/#configured-lifetime-renewal) | Positive integer seconds, rounded up to whole minutes: 61 becomes 120. Maximum 86,400 seconds. |

Provider account limits can be tighter. `renewed.requested.forSeconds` reports the resolved setting. `acknowledged: true` means the provider accepted the request, even if the follow-up read failed and `observation` is `null`. If the acknowledgement is lost, recover the operation instead of automatically renewing again.

The experimental [boxd adapter](/docs/providers/boxd/) also supports renewal and uses its own `lifetimeSeconds` configuration. [Vercel Sandbox](/docs/providers/vercel/) does not support renewal. See the [renewal example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-renew.ts) for saving and reopening a sandbox before renewal.

### Suspend and resume

On adapters that support it, `suspend()` pauses a sandbox and `resume()` starts it again under the same identity:

```ts
const suspended = await box.suspend();
console.log(suspended.preserve, suspended.processes);
// Save box.reference if you need to reopen it later.
const resumed = await box.resume();
console.log(resumed.execution);
```

What survives suspension depends on the provider:

| Adapter                                                  | What to expect                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Daytona](/docs/providers/daytona/#suspend-and-resume)   | Preserves private files and ends processes. Resume starts fresh processes under the same sandbox ID. Requires a known container with no mounts and deletion after stopping disabled. The sandbox's expiry clock keeps running while inactive; resume does not reset it.                                                                                     |
| [E2B](/docs/providers/e2b/#suspend-and-resume)           | Preserves private files and memory, and drops connections. Requires a verified kill-on-timeout policy with automatic resume disabled; known native mounts are unsupported. Resume uses the current connection's configured lifetime. `execution: "unknown"` means Sandbar cannot verify that the original processes survived intervening lifecycle changes. |
| [boxd (experimental)](/docs/providers/boxd/)             | Maps native pause and wake with memory, processes, and sockets preserved. Inbound traffic can also wake sleeping machines. This lifecycle mapping has not been live-qualified.                                                                                                                                                                              |
| [Vercel Sandbox (experimental)](/docs/providers/vercel/) | Suspension and resumption are unsupported.                                                                                                                                                                                                                                                                                                                  |

E2B's paused state has no active-session expiry and needs explicit cleanup. It is saved compute, not a reusable snapshot. Neither E2B nor Daytona promises external-storage durability or connection continuity through suspension.

For E2B and Daytona, configure `lifecycle: { suspension: { preserve: "filesystem" } }` to require at least filesystem preservation. `"filesystem+memory"` requires memory too; E2B supports it and Daytona rejects it. These operations require a verified sandbox reference and eligible native lifecycle settings.

On E2B and Daytona, suspending an already inactive sandbox or resuming a running one returns `CONFLICT`. Avoid concurrent lifecycle changes from your application or other controllers. Recover uncertain operations using their saved references; cancellation does not undo a submitted change. Destroy the sandbox when you no longer need its saved state.

`submitSuspend()`, `submitResume()`, and `submitRenew()` let you separate submission from waiting. See the [suspend/resume example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-suspend-resume.ts).

## Pass arguments literally

Pass an argument array to run a command without shell expansion. Characters such as `$`, `;`, and `*` are passed literally. Use the object form to set a working directory, environment variables, deadline, or output limit:

```ts
const output = await box.exec({
  command: { kind: "argv", argv: ["python3", "-c", "print('hello')"] },
  cwd: "/home/user",
  env: { APP_MODE: "example" },
  deadlineSeconds: 30,
  maxOutputBytes: 65_536,
});
console.log(output.stdoutText());
```

The sandbox image must contain the executable and working directory. `deadlineSeconds` defaults to 300 and accepts integers from 1 to 3,600. The default combined stdout/stderr capture limit is 1 MiB. Inspect `output.truncated` to check whether output was cut short.

A command deadline does not extend sandbox lifetime or provide a total time limit for the SDK call. Setup and output retrieval can take additional time, and adapters apply the deadline differently.

## Execution and waiting timeouts

There are separate limits for how long your application waits, how long a command runs, and how long its sandbox exists:

| Limit                     | Meaning                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Caller `signal`           | Stops local waiting. After submission, `WAIT_ABORTED` keeps an operation reference for recovery. The remote command may continue.                                        |
| Provider request timeout  | Limits a network request or response wait. A failed request does not prove that the command stopped.                                                                     |
| Command `deadlineSeconds` | Sets the adapter's execution or observation deadline. See the provider differences below.                                                                                |
| Sandbox lifetime          | Controls the sandbox's expiry independently of commands. Expiry can interrupt work; it is not confirmation of cleanup and does not expire retained snapshots or volumes. |

Use a signal to limit how long your application waits:

```ts
const result = await box.exec(
  { command: { kind: "argv", argv: ["node", "job.js"] }, deadlineSeconds: 10 },
  { signal: AbortSignal.timeout(15_000) },
);
```

The signal stops local waiting after 15 seconds. It does not kill remote compute. The 10-second command deadline has the adapter-specific behavior below. If the result is uncertain, [recover the original execution](/docs/guides/recovery/) rather than automatically running the command again.

| Adapter                                                         | How the command deadline is used                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [E2B](/docs/providers/e2b/#bounded-execution-deadlines)         | Sets the native command RPC and initial connection timeout. A timeout does not confirm remote termination. Later polling and output reads can take longer than the deadline.                                                                           |
| [Daytona](/docs/providers/daytona/#bounded-execution-deadlines) | Sets the native command timeout, plus separate local request and result-observation windows. Daytona documents command termination, but Sandbar has not live-verified cleanup of its command wrapper or child processes at timeout.                    |
| [boxd (experimental)](/docs/providers/boxd/)                    | Sets a deadline for the buffered execution transport. Local cancellation is not confirmation that the guest command stopped.                                                                                                                           |
| [Vercel Sandbox (experimental)](/docs/providers/vercel/)        | A guest Node helper attempts to kill the command's process group at the deadline. Separate request timeouts cover launch and observation. This behavior has fixture coverage but no live verification.                                                 |
| Modal (experimental)                                            | Sets the native command timeout. Initial lookup and result observation share a local window of the deadline plus 5 seconds. Modal documents a process runtime limit; Sandbar has not live-verified the private transport or child-process termination. |

These mappings describe implementation and provider documentation, not a guarantee that every remote process has stopped. The [E2B client artifact](https://unpkg.com/e2b@2.51.0/dist/index.mjs), [Daytona process reference](https://www.daytona.io/docs/en/typescript-sdk/process/), and [Modal command guide](https://modal.com/docs/guide/sandbox-spawn) describe the underlying timers. Modal's separate sandbox lifetime is described in its [sandbox guide](https://modal.com/docs/guide/sandboxes).

Local timeout handling does not automatically kill or destroy a sandbox, or replay the command. A confirmed exit and complete output are separate facts: E2B can return a known exit with partial output and `truncated: true`; other failures can leave the result uncertain. Follow the error's recovery information.

## Use a shell explicitly

Use the shell form when you need pipes, redirection, or shell expansion:

```ts
const output = await box.exec({
  command: { kind: "shell", script: "printf hello | wc -c" },
  deadlineSeconds: 30,
});
```

Avoid inserting untrusted text into shell scripts. Use argument arrays when you do not need shell syntax.

## Handle command failures

`exec()` returns output when the command exits with code zero. A confirmed nonzero exit throws `NonzeroExitError`, which includes the command's result:

```ts
import { NonzeroExitError } from "sandbar-sdk";

try {
  await box.exec(["sh", "-c", "exit 1"]);
} catch (error) {
  if (error instanceof NonzeroExitError) {
    console.error(error.result.exitCode, error.result.stderrText());
  } else {
    throw error;
  }
}
```

`NoExitCodeError` means execution completed without a confirmed exit code. A network failure or missing result can instead leave the outcome uncertain. See [Errors and recovery](/docs/guides/recovery/) before retrying work that may already have run.

## Submit and wait separately

Most code can use `exec()` and `create()`, which submit the operation and wait for the result.

Use `box.submitExec(input)` or `sandbar.sandboxes.submitCreate(input)` when you need to save a recovery reference or control waiting yourself. They return a handle with `reference`, `observe()`, and `wait()`.

Cancelling `wait({ signal })` stops local waiting. It does not terminate the command or undo creation. Save the reference and recover the submitted operation before deciding whether to retry.

For ongoing output and explicit process control, use [processes and streaming](/docs/guides/text-streaming/). Signal and termination support depends on the adapter and process handle; an operation handle is not a process handle.

## Serializable resource identity

A `ResourceReference` is a serializable description of a sandbox or stored resource. It records the provider, scope, native ID, ownership evidence, and generation when needed to distinguish reused IDs. Save the full reference rather than only the ID. It contains no credentials and does not grant access; reopening still needs valid credentials.

For applications that validate stored references:

- `validateResourceReference()` checks the format and returns a detached copy.
- `assertResourceScope()` checks the provider and full scope.
- `assertResourceIdentity()` also checks the resource kind, native ID, and generation. When one reference has a generation, the other must have the same generation.

These checks do not contact the provider or prove that a resource still exists. See [Snapshots and volumes](/docs/guides/snapshots-and-volumes/) for opening and managing stored resources.

A **resource reference** identifies a resource. An **operation recovery reference** identifies a submitted operation. Recovering an operation observes the original attempt; it does not automatically submit it again.
