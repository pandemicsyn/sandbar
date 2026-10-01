---
title: Sandboxes and execution
description: Create sandboxes, run commands, inspect state, and release compute.
---

Connect to [E2B](/docs/providers/e2b/) or [Daytona](/docs/providers/daytona/) first. The examples below use an E2B connection named `sandbar`.

## Create and clean up

```ts
const box = await sandbar.sandboxes.create({
  environment: Image.prepared("base"),
  networkPolicy: "blocked",
});
try {
  const state = await box.inspect();
  console.log(box.id, state.state);
  const output = await box.exec(["printf", "hello"]);
  console.log(output.stdoutText());
} finally {
  await box.destroy();
}
```

Use the sandbox handle for execution, files, inspection, and destruction. Call `sandbar.close()` in an outer `finally` when you're done with the connection, as in [Getting started](/docs/direct-quickstart/). Each sandbox needs its own explicit cleanup. `close()` releases local client state and waiting; it does not destroy remote compute or retained storage.

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

Local timeout paths do not implicitly kill or destroy the sandbox and do not replay command submission. Completion and output are separate evidence: a successful command may still be publicly unconfirmed if E2B output-file reads, Daytona response/receipt retrieval, or Modal output streams fail. Current APIs return completion only after the required output evidence is available; they do not independently expose every known native exit through output failure.

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

`box.submitExec(input)` and `sandbar.sandboxes.submitCreate(input)` return an operation handle with `reference`, `observe()`, and `wait()`. Use them when your application needs to save a reference or manage waiting explicitly. Ordinary `exec()` and `create()` submit and wait for you. `wait({ signal })` cancellation stops local waiting and preserves an operation reference; it does not terminate the remote command. Use recovery to observe an already-submitted operation before deciding what to do next. The current SDK has no public per-command termination API.

## Serializable resource identity

The exported `ResourceReference` schema describes sandbox, image, snapshot, volume, volume-version, mount, and session identity. Version 1 records provider, verified scope, native ID, ownership evidence, and native generation when locators can be reused. It contains no credentials and grants no authorization.

`validateResourceReference` parses and detaches a reference; `assertResourceScope` checks its provider and complete binding; `assertResourceIdentity` additionally compares kind, locator, and generation. A missing or changed generation cannot match an expected known generation. Adapters supply generation and correlated ownership evidence; the SDK does not infer either from a name. Direct connections now expose snapshot and volume opening, inspection and mutation methods; see [Snapshots and volumes](/docs/guides/snapshots-and-volumes/). Validation alone does not establish that a native artifact still exists or is unexpired.

Resource references identify things. Operation recovery references identify submissions and retain the existing observation-only recovery contract.
