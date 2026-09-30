---
title: Asynchronous adapter recovery
description: Add pending tokens and observation without replaying a native mutation.
---

The [runnable asynchronous adapter](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/async-adapter.ts) uses `prepare` for read-only checks, `submit` for exactly one native start, and `observe` for read-only lookup. Its token schema has a version and a bounded JSON value.

```ts
create: {
  recovery: { version: 1, token: z.strictObject({ jobId: z.string().min(1) }) },
  async prepare(input) {
    return { image: input.image.value }; // read-only
  },
  async submit(input, ctx) {
    const job = await native.start({ image: input.image, requestId: ctx.submissionId });
    return ctx.pending({ jobId: job.id }, { pollAfterMs: 500 });
  },
  async observe(attempt, ctx) {
    const token = z.strictObject({ jobId: z.string() }).parse(attempt.token);
    const job = await native.readJob(token.jobId); // read-only
    if (!job) return null;
    if (!job.done) return ctx.pending(token);
    return { id: job.sandboxId, state: "running" };
  },
}
```

Persist the initial reference before native submission. The SDK awaits `onReference` for pending token updates; persist the updated `operation.reference` before a process can restart. Reopen the same verified scope and call `recover(savedReference)`; recovery never calls `submit`. The [runnable restart test](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/async-adapter.test.ts) exercises this flow.

`wait()` respects each pending result's `pollAfterMs` as the earliest automatic next read. Its `pollMs` option can slow polling further but cannot shorten the adapter's delay. A manual `observe()` remains an explicit read; if it returns pending, a later `wait()` still respects the new delay.

The SDK enforces a 30-second local deadline for `prepare`. An adapter must honor the deadline supplied to `observe` and other read callbacks; the SDK does not apply an automatic timeout to observation. Caller cancellation or client close stops SDK waiting and preserves the recovery reference, without guaranteeing that provider transport or compute stopped.

If a response is lost and the provider offers no correlated discovery, the operation remains unknown. Do not reinterpret a timeout, abort, or thrown error as a provider rejection. For a durable application ledger, the optional `client.operations` lifecycle lets the application commit its submission marker in `beforeSubmit` and persist pending-token updates; ordinary sandbox calls use the same SDK execution path.

For multi-stage mutations, call `await ctx.checkpoint(token)` before each native dispatch and after each newly learned acknowledgement, stage result or artifact identity. Tokens must distinguish never submitted, dispatch may have occurred, acknowledged/pending, completed and definitively failed. Checkpoint persistence failures must stop later effects; do not catch them as native transport failures. Recovery references and resource history are application-owned JSON, independent of provider credential lifetime. Native authentication, scope, identity and dependency checks remain mandatory.

A mutation object can implement `continue(attempt, ctx)` through the existing runtime. The direct SDK's explicit `operation.continue()` invokes it with the original operation identities and checkpoint hook. `observe` must remain read-only. Advance only a proven never-submitted next stage after reconciling earlier effects; never replay an uncertain dispatch. Applications must serialize continuation across processes with their own lease or compare-and-swap unless native idempotency provides that guarantee. No SDK database or workflow engine is required.

## Publish normalized recovery facts

An adapter can add a pure `recovery.facts(token)` mapper alongside its versioned token schema. Return `RecoveryFacts` from `sandbar-adapter`; the runtime validates the mapper's output and persists it in the same reference as the opaque token. Applications read `operation.outcome` or `error.outcome` through the SDK instead of depending on your private token layout.

`RecoveryFacts` version `1` contains `retainedResources`, `completed`, an optional timestamped `source`, `steps` and `continuation`. Each capture fact reports its confirmed preservation, interruption and restore execution semantics. A completed capture and a failed restart are separate facts. A source observation records `observedAt` as an ISO timestamp and `provenance` as `provider-read` or `acknowledgement`; do not replace the time with the time the application reads the outcome.

Keep the mapper read-only and deterministic. It cannot perform provider reads or grant dispatch authority. Continuation reports `supported: true | false | "unknown"` separately from `status: "eligible" | "unavailable" | "unknown"`, with a reason. Eligibility reflects current evidence and must be revalidated by `continue` before dispatch. Unknown effects stay uncertain even when other steps completed.

Facts are limited to 16 KiB of serialized UTF-8 JSON, 32 retained resources, 16 completed entries and 16 step entries. Step names are at most 128 characters; reasons are at most 1,024 characters. Facts have their own version inside the recovery reference. The base envelope retains its 16 KiB budget; the full reference with facts is capped at 48 KiB. Public outcomes combine facts with envelope mounts and expose at most 64 known resource references. References without normalized facts remain recoverable when their token format is supported; the SDK exposes unknown facts until new evidence is available. Unsupported fact versions fail validation instead of silently acquiring new semantics.

For direct connections, the SDK exposes sealed reference and outcome copies. Treat these fields as an application-facing evidence view. Use the validated native token and current credential/scope checks for identity and dispatch decisions, including after source deletion where a retained resource can still be inspected independently.

## Share the dispatch barrier

`checkpointBeforeDispatch(ctx, token)` implements the repeated ordering used by the Daytona and E2B adapters: await the checkpoint hook, then recheck cancellation before a native effect. It returns `false` when cancellation arrived while persistence was pending; return a pending attempt instead of dispatching.

```ts
import { checkpointBeforeDispatch } from "sandbar-adapter";

// token already records that this stage may dispatch; keep it provider-specific.
if (!(await checkpointBeforeDispatch(ctx, token))) return ctx.pending(token);
const acknowledgement = await native.start(request);
await ctx.checkpoint(withAcknowledgement(token, acknowledgement));
```

Construct the stage marker before entering the barrier. After dispatch, checkpoint newly known identities and acknowledgements before any later effect. Do not catch `AdapterCheckpointError` as a transport failure or continue through it. A successful helper call without a configured persistence hook supplies local ordering only; it does not establish crash durability. Applications remain responsible for durable writes and cross-process continuation serialization.

Providers still own native stage meaning, correlated discovery and proven never-submitted transitions. The helper does not retry mutations, add a store or infer filesystem/memory guarantees. Test the actual SDK checkpoint path under failed writes, cancellation during persistence, lost acknowledgements, stale observations racing continuation, delayed capture and fresh-connection recovery. Assert both the surviving public facts and native dispatch counts so uncertain effects cannot be replayed.
