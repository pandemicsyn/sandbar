---
title: Recovery and uncertain outcomes
description: Observe submitted operations without replaying possibly applied mutations.
---

Mutations can complete even if a response is lost. `submitCreate()` and `box.submitExec()` return an `OperationHandle` with a serializable `reference`, `observe()` and `wait({ signal, pollMs })`. Normal `create()` and `exec()` submit and wait in one call.

```ts
const pending = await sandbar.sandboxes.submitCreate({
  environment: Image.prepared("fake-starter"),
});
saveReference(pending.reference);
const box = await pending.wait();
```

`observe()` returns `null` while pending. A `WaitAbortedError` after submission carries a reference and the original abort reason. Aborting a wait **does not cancel provider compute**. An `OutcomeUnknownError` also carries a reference. Save either reference and call `recover(reference)` from a client configured with the same provider scope or service URL/project. Recovery only observes; it never resubmits the mutation.

Direct references have `durability: 'process'` on their operation handles. A new caller can import a saved reference only if the provider retains matching native evidence and the caller reconfigures credentials and scope. A crash after submission but before saving the reference may lose the pointer. Remote handles have `durability: 'service'` and use the service operation ledger. Neither mode should blindly retry an unknown effect.

`close()` stops client-owned waiting and never destroys a sandbox. Call `destroy()` explicitly and preserve a reference if destruction becomes uncertain. If native discovery is unavailable, an unknown result stays unknown.

When direct mode receives a borrowed provider driver, `close()` does not cancel that driver's transport work or provider compute. It only stops SDK-owned waiting.
