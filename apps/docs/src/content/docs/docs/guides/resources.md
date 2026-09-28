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

Use the sandbox handle for execution, files, inspection, and destruction. Call `sandbar.close()` in an outer `finally` when you're done with the connection, as in [Getting started](/docs/direct-quickstart/). Each sandbox needs its own explicit cleanup.

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

The image must contain the executable and working directory. The default execution deadline is 300 seconds; the default combined output limit is 1 MiB.

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

`box.submitExec(input)` and `sandbar.sandboxes.submitCreate(input)` return an operation handle with `reference`, `observe()`, and `wait()`. Use them when your application needs to save a reference or manage waiting explicitly. Ordinary `exec()` and `create()` submit and wait for you.
