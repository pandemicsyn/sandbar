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

`onReference` is awaited for the initial reference, provider stage checkpoints, and pending observation updates. The provider records a dispatch-may-have-occurred marker before every stage effect and checkpoints newly learned acknowledgements and resource identities. If persistence fails before a stage dispatch, that effect is not sent; after an effect, preserve the latest reference carried by the error. Resource and operation references are bounded versioned JSON owned by your application, without a required Sandbar database or provider-key signature.

For E2B credential rotation, configure `teamId` so authenticated verification establishes a stable native team scope. E2B's default scope is tied to the authenticated API key; rotating it changes that scope. Daytona's scope includes its organization, target, endpoint, and selected network policy. Reconnect with matching scope to recover prior operations.

Direct operations with supported multi-stage recovery expose `continue()`. `recover()`, `observe()`, `inspect()` and `wait()` stay read-only. Explicit continuation may dispatch a configured next stage proven never submitted, such as restarting a stopped Daytona source after a delayed capture completes. It does not replay an uncertain stage. Serialize concurrent continuations across processes with your application's own lease or compare-and-swap; a local handle guard is not a distributed exactly-once guarantee.

```ts
const operation = await client.recover(savedReference);
await operation.continue(); // Explicit mutation; persist checkpoints through onReference.
const result = await operation.wait(); // Read-only observation.
```
