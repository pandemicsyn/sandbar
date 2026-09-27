---
title: TypeScript SDK reference
description: Public entry points, resource handles and errors in the current unpublished SDK.
---

The **unpublished** `sandbar-sdk` package provides `sandbar-sdk/direct` and `sandbar-sdk/remote`. Both entry points export `Sandbar`, `Image`, `SandbarError`, `OutcomeUnknownError`, `WaitAbortedError`, `NonzeroExitError`, `NoExitCodeError`, `outputText` and the shared public resource types. The root entry point exports the common types and errors but not a constructor.

## Construction

| Entry point | Signature                                    | Requirements                                                                 |
| ----------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Direct      | `Sandbar.direct({ provider })`               | `provider` is a driver and verified native scope; server-side Node.js or Bun |
| Remote      | `Sandbar.connect({ url, token, projectId })` | HTTPS service URL or loopback HTTP, Bearer token and project ID              |

The direct export also includes `DirectClient`, `DirectOptions` and `DirectProvider`. The remote export includes `RemoteClient` and `RemoteOptions`. Import types from the matching entry point.

## Inputs and handles

| API                                                                                | Current behavior                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `Image.prepared(value)`                                                            | Prepared image input; `fake-starter` is the qualified fixture |
| `Image.oci(value)`                                                                 | OCI input shape exists; no real importer qualified            |
| `sandboxes.create({ environment, networkPolicy?, region?, labels? }, { signal? })` | Create and wait for a sandbox                                 |
| `sandboxes.submitCreate(input, options?)`                                          | Return an `OperationHandle<SandboxHandle>`                    |
| `box.inspect()`                                                                    | Return state and optional observation time                    |
| `box.exec(input, { signal? })`                                                     | Return `ExecOutput`; nonzero exit throws                      |
| `box.submitExec(input, options?)`                                                  | Return an `OperationHandle<ExecOutput>`                       |
| `box.readFile(path)`                                                               | Return `Uint8Array`, at most 1 MiB                            |
| `box.writeFile(path, bytes, { overwrite?, signal? })`                              | Buffered binary write, at most 1 MiB                          |
| `box.destroy({ signal? })`                                                         | Confirm compute stop                                          |
| `sandbar.recover(reference)`                                                       | Observe a prior mutation without resubmitting                 |
| `sandbar.close()`                                                                  | Release client state, without destroying sandboxes            |

`exec` and `submitExec` accept `ExecInput | readonly string[]`. An array is shorthand for `{ command: { kind: "argv", argv } }`: its elements are literal arguments, never shell syntax, and the SDK copies them before dispatch. Both forms share validation and defaults (300-second deadline and 1 MiB output bound); an empty array is invalid. Use the full object for `cwd`, `env`, `deadlineSeconds`, `maxOutputBytes`, or explicit `{ kind: "shell", script }` commands.

`ExecOutput` has `exitCode`, byte-array `stdout` and `stderr`, `truncated`, and bounded `stdoutText(maxBytes?)` / `stderrText(maxBytes?)`. `OperationHandle<T>` has `reference`, `durability`, `observe()` and `wait({ signal?, pollMs? })`. Poll intervals must be between 50 and 60,000 milliseconds. The public source of truth is [`packages/sdk/src/resource.ts`](https://github.com/pandemicsyn/sandbar/blob/3e9f8efbe6bd8932e6d719e292d3430e7eda4346/packages/sdk/src/resource.ts).

The recovery behavior in these guides applies to the resource methods above. The exported `RemoteClient` class also exposes lower-level `raw`, `request` and `throwResponse` helpers; they do not provide the resource methods' recovery guarantees. For an imported remote execution reference, the SDK applies its global output cap while the service retains the original requested cap.

## Errors

`SandbarError` exposes `code` and `effect` (`none`, `applied`, `partial`, `possible` or `unknown` in the wire error vocabulary). `OutcomeUnknownError` and `WaitAbortedError` carry a `reference`. `WaitAbortedError.cause` is the original abort reason. `NonzeroExitError` carries the completed execution result; `NoExitCodeError` indicates a completed execution without a confirmed exit code. See [Recovery](/docs/guides/recovery/) before retrying mutations.
