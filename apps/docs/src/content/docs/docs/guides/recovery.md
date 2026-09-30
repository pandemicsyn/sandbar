---
title: Errors and recovery
description: Inspect partial completion and observe submitted operations without replaying mutations.
---

Mutations can complete even if a response is lost. `submitCreate()`, `box.submitExec()` and `box.submitSnapshot()` return operation handles with a serializable `reference`, `observe()` and `wait({ signal, pollMs })`. Convenience calls such as `create()`, `exec()` and `snapshot()` submit and wait in one call; their successful results keep the same shape.

For an E2B connection using the `base` template:

```ts
const pending = await sandbar.sandboxes.submitCreate({
  environment: Image.prepared("base"),
});
await saveReference(pending.reference);
const box = await pending.wait();
```

`observe()` returns `null` while completion is not known. `WaitAbortedError` carries a reference and the original abort reason. Aborting a wait **does not cancel provider compute**. `OutcomeUnknownError` also carries a reference. Save the reference and call `recover(reference)` from a fresh connection with current credentials in the same verified provider scope. Recovery only observes; it never resubmits the mutation.

Direct SDK operations have `durability: 'process'`. Durable application writes and matching native provider evidence allow recovery after a process restart. Without a persistence hook, a crash before saving the reference may lose the pointer. Never blindly retry an unknown effect.

`close()` stops client-owned waiting and releases any adapter-owned transport through its release hook. It never destroys a sandbox or proves provider compute was canceled. Call `destroy()` explicitly and preserve a reference if destruction becomes uncertain. If native discovery is unavailable, an unknown result stays unknown.

## Read partial completion

Direct operation handles expose `operation.outcome`. Structured `SandbarError` instances expose an optional `error.outcome`, including direct `OutcomeUnknownError` and `WaitAbortedError`. The `RecoveryOutcome` has the operation `reference` and normalized facts; application code never needs to inspect its provider token.

| Field               | Meaning                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `version`           | Normalized facts format, currently `1`.                                                                              |
| `retainedResources` | Known snapshot and volume references, even after another step fails.                                                 |
| `retainedNativeIds` | Native retained IDs from a confirmed destroy result.                                                                 |
| `retainedArtifacts` | Retained artifact descriptions from a confirmed image build.                                                         |
| `completed`         | Confirmed steps, including capture preservation, interruption and restore execution facts when known.                |
| `source`            | Last known source state, its ISO observation time and `provider-read` or `acknowledgement` provenance.               |
| `steps`             | Logical steps with `pending`, `uncertain`, `failed` or `completed` status and an optional reason.                    |
| `nextAction`        | `continue`, `observe`, `manual`, `none` or `unknown`; advice never authorizes dispatch.                              |
| `continuation`      | Whether supported (`true`, `false` or `"unknown"`), with `eligible`, `unavailable` or `unknown` status and a reason. |

A completed Daytona cold filesystem capture can leave a retained snapshot even if restarting the source fails. E2B's native memory capture has different preservation and execution facts. Read `completed[].capture` to learn what was confirmed, instead of inferring guarantees from the provider name. An uncertain request does not become a successful snapshot merely because the wait stopped. Source state is historical evidence; its timestamp does not guarantee the source is still running now.

```ts
try {
  const result = await box.snapshot();
  await saveReference(result.snapshot.reference);
} catch (error) {
  if (error instanceof SandbarError && error.outcome) {
    const outcome = error.outcome;
    await saveReference(outcome.reference);
    for (const reference of outcome.retainedResources) {
      if (reference.kind === "snapshot") {
        const snapshot = await freshClient.snapshots.get(reference);
        console.log(await snapshot.inspect());
      }
    }
  } else {
    throw error;
  }
}
```

Reopening a retained resource still requires current authorization in the matching native scope. Where a snapshot or volume survives its source, its own resource reference supports reopening it after source deletion. Facts are bounded, versioned JSON and persist in the operation reference. Provider facts remain unchanged after completion. A compact `reference.completion` stores essential completion state and every additional resource identity, inheriting provider and scope from the reference. Resources already present in provider facts or mounts receive only newly learned evidence. Reopening evidence such as generation and history is preserved; no resource identity is silently trimmed to fit the facts budget. Older references without facts expose unknown completion and continuation evidence; they do not fabricate success. The reference and outcome copies are sealed against caller mutation, and none of these public facts grant dispatch authority.

## Recognize the error

| Error                       | Meaning                                            | Next action                                                                                              |
| --------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `NonzeroExitError`          | The command completed with a nonzero exit.         | Inspect `error.result`, including stderr and exit code.                                                  |
| `NoExitCodeError`           | Execution completed without a confirmed exit code. | Inspect captured output; do not assume success.                                                          |
| `ReferencePersistenceError` | A required reference write failed.                 | Inspect `phase`, `providerOutcome`, `result` and `reference`; retry the write, not a confirmed mutation. |
| `OutcomeUnknownError`       | A mutation may have taken effect.                  | Persist `error.reference`, inspect `error.outcome` when present, and observe.                            |
| `WaitAbortedError`          | Local waiting stopped after submission.            | Save the reference and partial outcome; compute may still be running.                                    |
| `SandbarError`              | A structured SDK error.                            | Inspect `code`, `effect` and any `outcome` before choosing a next step.                                  |

For a direct connection, `recover(savedReference)` returns a `RecoveredOperation` union. Narrow by `operation.kind` to obtain the corresponding result type: snapshot capture returns a `SnapshotResult`, volume creation returns a volume handle, and sandbox creation or snapshot restore returns a sandbox handle. Caller-supplied type assertions are unnecessary.

```ts
const operation = await freshClient.recover(savedReference);
if (operation.kind === "snapshot_capture") {
  const result = await operation.observe();
  if (result) console.log(result.snapshot.reference, result.capture);
}
```

Use the exported `DirectClient` and `DirectSandboxHandle` types when annotating direct SDK connections and sandbox handles that include snapshots and volumes. These APIs are separate from the service's `SandbarClient` surface.

## Persist references when it matters

`saveReference` is your application's persistence function. Await durable writes before moving on. The ordinary bound-adapter connection accepts `onReference`, alongside observability options:

```ts
const client = await Sandbar.connect(daytona({ apiKey, target: "us" }), {
  async onReference(reference) {
    await saveJson(JSON.stringify(reference));
  },
});
```

The E2B form is the same: `Sandbar.connect(e2b({ apiKey, teamId }), { onReference })`. No empty `config` or `credentials` objects are needed. The advanced `operations.prepare(...).submit(..., { beforeSubmit })` lifecycle also supports an application submission ledger. See [Asynchronous adapter recovery](/docs/guides/adapter-recovery/).

`onReference` is awaited for the initial reference, provider stage checkpoints, observation updates, and confirmed completion. A failed write throws `ReferencePersistenceError`, separate from provider uncertainty. Its `phase` identifies `before-dispatch`, `checkpoint`, `observation` or `completion`. When `providerOutcome` is `completed`, `effect` is `applied`; completion-phase errors also include the confirmed operation `result`. Later writes of an already completed reference preserve that completion status. Save `error.reference` again without resubmitting the mutation. Retrying the same operation's `wait()` retries the required final write and returns the confirmed result without replay. A failed initial marker has `providerOutcome: "not-dispatched"` and `effect: "none"`. Checkpoint failures preserve confirmed partial facts without claiming that earlier effects did not happen. The provider records a dispatch-may-have-occurred marker before each stage effect and checkpoints newly learned acknowledgements and resource identities. If persistence fails before a stage dispatch, that effect is not sent; after an effect, preserve the latest reference carried by the error. Application-owned references do not require a Sandbar database or provider-key signature.

For E2B credential rotation, configure `teamId` so authenticated verification establishes a stable native team scope. E2B's default scope is tied to the authenticated API key; rotating it changes that scope. Daytona's scope includes its organization, target, endpoint, and selected network policy. Reconnect with matching scope to recover prior operations.

## Continue only explicitly

Direct operations with supported multi-stage recovery expose `continue()`. `recover()`, `observe()`, `inspect()` and `wait()` remain read-only. Explicit continuation may dispatch a configured next stage proven never submitted, such as restarting a stopped Daytona source after delayed capture completes. It never replays an uncertain stage. Check `outcome.nextAction` and `continuation`: a definitive source-restart failure requires manual native restart or restoring the retained snapshot, rather than observation alone. A confirmed completed operation reports `nextAction: "none"` and rejects continuation.

```ts
const operation = await client.recover(savedReference);
try {
  await operation.observe();
} catch (error) {
  if (!(error instanceof SandbarError && error.outcome)) throw error;
}
if (operation.outcome.continuation.status === "eligible") {
  await operation.continue();
  await operation.wait();
}
```

Observation may throw a structured error when completion remains unknown; the handle retains its latest outcome. Eligibility is advisory. The provider revalidates current native state and dispatch authority before effects. For `unknown` or `unavailable`, read the reason and keep uncertain work under observation instead of retrying the mutation. Serialize concurrent continuations across processes with your application's lease or compare-and-swap; a local handle guard is not a distributed exactly-once guarantee.

The [compiled recovery example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/recovery-outcomes.ts) demonstrates awaited persistence for Daytona and E2B, convenience error handling, retained snapshot reopening and typed explicit recovery. These examples make no new live provider qualification claim.
