---
title: Sandboxes and execution
description: Create sandboxes, run commands, inspect state, and release compute.
---

Connect to [E2B](/docs/providers/e2b/) or [Daytona](/docs/providers/daytona/) first. The examples below use an E2B connection named `sandbar`.

## Create and clean up

```ts
const text = await sandbar.sandboxes.with(
  { environment: Image.prepared("base"), networkPolicy: "blocked" },
  async (box) => {
    console.log(box.id, (await box.inspect()).state);
    return (await box.exec(["printf", "hello"])).stdoutText();
  },
);
console.log(text); // Returned after compute cleanup is confirmed.
```

`with(input, callback, options)` owns exactly the sandbox it creates. It attempts destruction after callback success, failure or cancellation, without closing your client or deleting retained snapshots/volumes. Manual `create()`/`destroy()` remain available; `get()` never transfers cleanup ownership. Close the caller connection in an outer `finally` after the scope settles. `close()` releases local client state and waiting; it does not destroy remote compute or retained storage.

Options are `signal`, `cleanupTimeoutMs` (positive integer milliseconds, default 30,000, maximum 300,000) and the existing `storage` policy override. Cleanup uses a fresh bounded budget independent of the work signal, honoring the connection's configured storage policy when no override is supplied. Pass the work signal to operations inside the callback as well. Abort stops local callback waiting and starts cleanup; a callback that ignores the signal can continue running, and abort alone does not prove remote termination.

If cleanup succeeds, the callback value or original failure is preserved. If cleanup fails, catch exported `SandboxCleanupError`: `callbackOutcome` retains either the completed value or original thrown value, `cleanupError` retains the destruction failure, and `sandboxId`, `sandboxReference`, `cleanupOperation` and `cleanupReference` preserve available recovery evidence. Its inherited `outcome` retains any partial cleanup confirmation. Save both work and cleanup recovery references when present, and investigate without replaying work. An uncertain create propagates its original recoverable error, never calls the callback and never destroys a guessed identity. The [runnable examples](/docs/guides/runnable-agent-examples/) demonstrate scope cleanup and recovery reporting.

## Reopen and manage lifetime

Save the complete `box.reference` in your application's trusted store before releasing the connection. Built-ins issue verified references; a legacy custom adapter can return `null`. Reopen with current credentials and the original provider/scope:

```ts
const box = await freshClient.sandboxes.get(savedReference);
const info = await box.inspect();
if (info.expires.status === "known") console.log(info.expires.at, info.expires.scope);
```

`get()` and `inspect()` are reads. They never create a replacement, resume inactive compute or renew its lifetime. Guest execution and file access require running compute. Missing or deleted resources reject with `NOT_FOUND`; a saved ID does not migrate between providers. For E2B credential rotation, configure the verified `teamId` when establishing the original connection.

Set `lifecycle: { lifetimeSeconds: 600 }` in adapter setup for initial lifetime and the default renewal window. It is mutually exclusive with E2B `timeoutSeconds` or Daytona `ttlMinutes`. Once the sandbox is running:

```ts
const renewed = await box.renew(); // Uses this connection's configured window.
await box.renew({ forSeconds: 61 });
console.log(renewed.requested.forSeconds, renewed.observation?.expires);
```

Renewal resets a native deadline from provider processing; it is not additive and may shorten an existing longer deadline. E2B rounds small positive requests up to 60 seconds and permits at most 3,600 seconds. Daytona rounds up to minutes (61 becomes 120) and permits at most 86,400 seconds. Account limits can be tighter. `acknowledged: true` confirms acceptance even if the subsequent detail read fails and `observation` is `null`. A lost acknowledgement remains uncertain: recover the operation instead of automatically renewing again.

Use `suspend()` to retain the same inactive compute resource and `resume()` to explicitly reactivate it:

```ts
const suspended = await box.suspend();
console.log(suspended.preserve, suspended.processes);
// Keep box.reference in your trusted store; close() leaves saved compute intact.
const resumed = await box.resume();
console.log(resumed.execution);
```

Daytona container suspension preserves private filesystem and ends processes; resume starts fresh processes under the same sandbox ID. It requires known empty mounts and deletion-on-stop disabled. Its hard TTL continues while stopped or archived; resume does not reset it. E2B suspension preserves filesystem and memory and drops connections. Resume starts a new active session using the connection's configured lifetime, but returns `execution: "unknown"` because current native evidence cannot certify process continuity after external lifecycle changes. Paused E2B state has no active-session expiry; this does not make it a reusable snapshot.

Configure a minimum with `lifecycle: { suspension: { preserve: "filesystem" } }`; memory preservation also satisfies that minimum. Daytona rejects a memory requirement. Mounted suspension remains unsupported; neither provider promises external-storage durability or socket continuity. Already inactive `suspend()` and already running `resume()` reject with `CONFLICT`. Serialize lifecycle changes per sandbox and reconcile uncertain outcomes through their operation reference. `submitSuspend()`, `submitResume()` and `submitRenew()` separate submission from waiting. Cancellation stops local waiting, and no automatic inverse action runs. Destroy owned compute explicitly when its saved state is no longer needed.

The compiled [reopening](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-reopen.ts), [renewal](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-renew.ts) and [suspend/resume](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-suspend-resume.ts) recipes show application persistence and cleanup. Inspections include `state`, `nativeState`, `observedAt`, `expires`, `idleStop`, `retention` and `execution`; unknown facts remain explicit. An observation is historical, and a locally calculated countdown does not prove deletion.

## Pass arguments literally

An argument array never invokes a shell. Characters such as `$`, `;`, and `*` stay literal arguments. Use the object form to set a working directory, environment, deadline, or output limit:

```ts
const output = await box.exec({
  command: { kind: "argv", argv: ["python3", "-c", "print('hello')"] },
  cwd: "/home/user",
  env: { APP_MODE: "example" },
  deadlineSeconds: 30,
  maxOutputBytes: 65_536,
});
```

The image must contain the executable and working directory. `deadlineSeconds` defaults to 300 and accepts integers from 1 to 3,600; the default combined output limit is 1 MiB. The deadline has provider-specific execution or observation semantics. It does not bound the total SDK call, including setup, polling and output retrieval, or set or extend sandbox lifetime.

## Execution and waiting timeouts

| Boundary       | What it limits                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caller waiting | A call's `signal` stops local waiting. After submission, `WAIT_ABORTED` preserves the execution reference and reports effect possible; compute may continue.                                                                          |
| Request/RPC    | A provider HTTP/RPC observation window can end without exit evidence. A timer error is not a termination receipt.                                                                                                                     |
| Remote process | Daytona and Modal document native command runtime bounds. E2B's pinned mapping establishes an RPC deadline; remote termination remains unverified. Descendant termination and deployed wrapper behavior are unverified for all three. |
| Sandbox expiry | E2B and Modal `timeoutSeconds` (default 300) and Daytona `ttlMinutes` (default 60) configure separate native compute lifetime. Expiry may interrupt command/output, does not confirm cleanup, and does not expire retained artifacts. |

Use a caller signal when you need to bound local waiting:

```ts
const result = await box.exec(
  { command: { kind: "argv", argv: ["node", "job.js"] }, deadlineSeconds: 10 },
  { signal: AbortSignal.timeout(15_000) },
);
```

The 15-second signal stops local waiting without killing remote compute. `deadlineSeconds: 10` retains the provider behavior described below. [Recover the original execution reference](/docs/guides/recovery/) to investigate uncertainty; do not automatically submit it again.

| Provider                                         | Current bounded-exec mapping                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2B (`e2b@2.51.0`)                               | `deadlineSeconds * 1000` becomes foreground `commands.run` RPC `timeoutMs` and handshake `requestTimeoutMs`. The handshake timer clears at PID acknowledgement. RPC failure does not establish remote termination; status/output files can be observed later. No automatic total SDK wait timer follows from this deadline.                                            |
| Daytona (direct REST; fixtures based on 0.218.0) | `/process/execute` receives `timeout: deadlineSeconds`; HTTP waiting is separately bounded by `(deadlineSeconds + 10) * 1000`, after preflight. Daytona documents server command termination. Sandbar's capture wrapper, descendants and forced-termination receipt behavior remain unverified live. The same post-submission receipt window guides later observation. |
| Modal (experimental, `modal@0.10.1`)             | Native `TaskExecStart.timeoutSecs` is distinct from sandbox lifetime. Start lookup and initial result observation share a local `(deadlineSeconds + 5) * 1000` window; later observations use fresh context deadlines. Modal documents a process runtime bound; deployed private-router and descendant termination remain unverified live.                             |

The E2B timer distinction follows the exact [2.51.0 client artifact](https://unpkg.com/e2b@2.51.0/dist/index.mjs), rather than older descriptive SDK references. Native runtime intent comes from Daytona’s [process reference](https://www.daytona.io/docs/en/typescript-sdk/process/) and Modal’s [command guide](https://modal.com/docs/guide/sandbox-spawn). Modal’s [sandbox lifetime guide](https://modal.com/docs/guide/sandboxes) describes the separate expiry boundary. These sources establish client wiring or documented intent; offline fixtures do not establish deployed termination.

Local timeout paths do not implicitly kill or destroy the sandbox and do not replay command submission. Once E2B validates its command status marker, unavailable stdout/stderr preserves that exit and any available bytes with `truncated: true`; it never replays the command. Missing or invalid status, unavailable Daytona receipts, and Modal output/router failures can still leave completion unconfirmed. Local cancellation does not prove remote termination.

## Use a shell explicitly

```ts
const output = await box.exec({
  command: { kind: "shell", script: "printf hello | wc -c" },
  deadlineSeconds: 30,
});
```

Avoid interpolating untrusted input into shell scripts. Use argument arrays when you do not need shell syntax.

## Handle command failures

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

A nonzero exit is a completed command. `NoExitCodeError` means execution completed without a confirmed exit code. Transport failures and uncertain effects have different errors; see [Errors and recovery](/docs/guides/recovery/).

## Submit and wait separately

`box.submitExec(input)` and `sandbar.sandboxes.submitCreate(input)` return an operation handle with `reference`, `observe()`, and `wait()`. Use them when your application needs to save a reference or manage waiting explicitly. Ordinary `exec()` and `create()` submit and wait for you. `wait({ signal })` cancellation stops local waiting and preserves an operation reference; it does not terminate the remote command. Use recovery to observe an already-submitted operation before deciding what to do next. Streaming process handles provide explicit signals and termination on both official adapters; this operation-handle API does not terminate commands. See [streaming and interactive processes](/docs/guides/text-streaming/) for targeting limits.

## Serializable resource identity

The exported `ResourceReference` schema describes sandbox, image, snapshot, volume, volume-version, mount, and session identity. Version 1 records provider, verified scope, native ID, ownership evidence, and native generation when locators can be reused. It contains no credentials and grants no authorization.

`validateResourceReference` parses and detaches a reference; `assertResourceScope` checks its provider and complete binding; `assertResourceIdentity` additionally compares kind, locator, and generation. A missing or changed generation cannot match an expected known generation. Adapters supply generation and correlated ownership evidence; the SDK does not infer either from a name. Direct connections now expose snapshot and volume opening, inspection and mutation methods; see [Snapshots and volumes](/docs/guides/snapshots-and-volumes/). Validation alone does not establish that a native artifact still exists or is unexpired.

Resource references identify things. Operation recovery references identify submissions and retain the existing observation-only recovery contract.
