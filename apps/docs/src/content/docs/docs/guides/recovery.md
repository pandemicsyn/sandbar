---
title: Errors and recovery
description: Observe submitted operations without replaying possibly applied mutations.
---

Mutations can complete even if a response is lost. `submitCreate()` and `box.submitExec()` return an `OperationHandle` with a serializable `reference`, `observe()` and `wait({ signal, pollMs })`. Normal `create()` and `exec()` submit and wait in one call.

For an E2B connection using the `base` template:

```ts
const pending = await sandbar.sandboxes.submitCreate({
  environment: Image.prepared("base"),
});
await saveReference(pending.reference);
const box = await pending.wait();
```

`observe()` returns `null` while pending. A `WaitAbortedError` after submission carries a reference and the original abort reason. Aborting a wait **does not cancel provider compute**. An `OutcomeUnknownError` also carries a reference. Save either reference and call `recover(reference)` from a client configured with the same verified provider scope. Recovery only observes; it never resubmits the mutation.

SDK operation handles have `durability: 'process'`. A new caller can import a saved reference only if the provider retains matching native evidence and the caller reconfigures credentials and scope. A crash after submission but before saving the reference may lose the pointer. Never blindly retry an unknown effect.

`close()` stops client-owned waiting and never destroys a sandbox. Call `destroy()` explicitly and preserve a reference if destruction becomes uncertain. If native discovery is unavailable, an unknown result stays unknown.

An adapter may register a release hook for a transport it owns. `close()` invokes that hook once and stops SDK-owned waiting; it does not prove provider compute was canceled.

## Recognize the error

| Error                 | Meaning                                            | Next action                                              |
| --------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `NonzeroExitError`    | The command completed with a nonzero exit.         | Inspect `error.result`, including stderr and exit code.  |
| `NoExitCodeError`     | Execution completed without a confirmed exit code. | Inspect captured output; do not assume success.          |
| `OutcomeUnknownError` | A mutation may have taken effect.                  | Persist `error.reference` and observe it.                |
| `WaitAbortedError`    | Local waiting stopped after submission.            | Save the reference; compute may still be running.        |
| `SandbarError`        | A structured SDK error.                            | Inspect `code` and `effect` before choosing a next step. |

`recover(savedReference)` returns an operation handle; call `observe()` for one read or `wait()` to continue observing. An `observe()` result of `null` means completion is not yet known, not that the operation failed.

## Persist references when it matters

The sample's `saveReference` is your application's persistence function. Await durable writes before moving on. For a checkpoint before native submission, pass `onReference` through the explicit adapter connection options or use the advanced `operations.prepare(...).submit(..., { beforeSubmit })` lifecycle. See [Asynchronous adapter recovery](/docs/guides/adapter-recovery/).

`onReference` runs only for the initial reference before provider dispatch. A pending `observe()` result can add or replace a recovery token on the handle without calling `onReference` again. Persist the updated `operation.reference` after each pending observation. `wait()` observes internally and does not provide checkpoints for those intermediate updates; use explicit `observe()` calls when you need to persist each update. Save the reference carried by `WaitAbortedError` or `OutcomeUnknownError` if waiting stops with either error.

E2B's default scope is tied to the authenticated API key; rotating it changes that scope. Daytona's scope includes its organization, target, endpoint, and selected network policy. Reconnect with matching scope to recover prior operations.
