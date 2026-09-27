---
title: TypeScript SDK reference
description: Public SDK constructors, resource handles, operation lifecycle, and errors.
---

The **unpublished** `sandbar-sdk` package has `sandbar-sdk/direct` and `sandbar-sdk/remote` entry points. The direct entry point uses a trusted installed `defineAdapter` package in the same Node.js or Bun process. The remote entry point talks to the optional standalone Bun service. Both expose the same sandbox resource model.

## Construction

| Entry point | Signature | Requirements |
| --- | --- | --- |
| Direct | `await Sandbar.connect({ adapter, config, credentials, onReference? })` | Server-side Node.js or Bun; adapter verifies native scope. |
| Remote | `Sandbar.connect({ url, token, projectId })` | HTTPS service URL or loopback HTTP, Bearer token and project ID. |

`@sandbar/adapter` exports `defineAdapter`, `AdapterError`, operation result helpers, and the types for scoped create, destroy, exec, files, inventory, and observation. `@sandbar/adapter/testing` exports `adapterSuite`. An adapter with no host policy does not expose `withPolicy`; a policy-bearing definition validates and clones host policy synchronously.

## Resource methods

| API | Behavior |
| --- | --- |
| `Image.prepared(value)` | Existing prepared image ID. |
| `Image.oci(value)` | OCI input shape where an adapter explicitly supports it. |
| `sandboxes.create({ environment, networkPolicy?, region?, labels? }, { signal? })` | Submit and wait for a sandbox. |
| `sandboxes.submitCreate(input, options?)` | Return an operation with a serializable recovery reference. |
| `box.inspect()` | Read current sandbox state where supported. |
| `box.exec(input, { signal? })` | Return bounded binary output; nonzero exit throws. |
| `box.submitExec(input, options?)` | Return an execution operation handle. |
| `box.readFile(path)` | Return bounded `Uint8Array` where supported. |
| `box.writeFile(path, bytes, { overwrite?, signal? })` | Write binary bytes where supported. |
| `box.destroy({ signal? })` | Confirm compute stop. |
| `sandbar.recover(reference)` | Observe a prior mutation without resubmitting. |
| `sandbar.close()` | Release client resources without destroying compute. |

`exec` and `submitExec` accept `ExecInput | readonly string[]`. An array is shorthand for `{ command: { kind: "argv", argv } }`: each element is a literal argument, and the SDK copies the array before dispatch. Both forms share validation and defaults (300-second deadline and 1 MiB output bound); an empty array is invalid. Use the full object for `cwd`, `env`, `deadlineSeconds`, `maxOutputBytes`, or an explicit `{ kind: "shell", script }` command.

`ExecOutput` contains byte-array `stdout` and `stderr`, `exitCode`, `truncated`, and bounded `stdoutText(maxBytes?)` / `stderrText(maxBytes?)` helpers. `OperationHandle<T>` has `reference`, `durability`, `observe()` and `wait({ signal?, pollMs? })`. Poll intervals must be between 50 and 60,000 milliseconds. A direct operation has process lifetime; a remote operation is backed by service admission. Unsupported optional methods fail locally.

## Optional durable lifecycle

The direct client's `operations` property lets an application integrate its own durable ledger without importing the service:

```ts
const prepared = await client.operations.prepare("create", nativeCreateInput);
const result = await prepared.submit(identity, {
  beforeSubmit: async () => {
    await persistSubmissionMarker(identity);
    return true;
  },
});
```

A prepared attempt is single-use, including concurrent calls. `beforeSubmit` must commit before provider IO; returning false or throwing prevents dispatch. Persist a returned pending token with its version. After restart, `client.operations.observe({ scope, kind, operationId, submissionId, token, tokenVersion })` reads provider evidence without preparing or submitting again. This API exposes no SQL types or persistence framework. See [asynchronous adapter recovery](/docs/guides/adapter-recovery/).

## Errors and uncertainty

`SandbarError` exposes `code` and `effect`. `OutcomeUnknownError` and `WaitAbortedError` carry a recovery reference. A thrown provider error, transport timeout, abort, or close after submission does not prove the native effect failed. `NonzeroExitError` carries completed execution output; `NoExitCodeError` means a completed execution has no confirmed exit code. See [Recovery](/docs/guides/recovery/) before retrying mutations.
