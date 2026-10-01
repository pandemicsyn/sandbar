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

This existing advanced operation API is optional. Ordinary snapshot calls return a resource reference for application persistence; they do not require an operation journal.

For callers using the legacy checkpoint callback, persist the initial operation reference before native submission. The SDK awaits `onReference` for pending token updates; persist the updated `operation.reference` before a process can restart. Reopen the same verified scope and call `recover(savedReference)`; recovery never calls `submit`. The [runnable restart test](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/async-adapter.test.ts) exercises this flow.

`wait()` respects each pending result's `pollAfterMs` as the earliest automatic next read. Its `pollMs` option can slow polling further but cannot shorten the adapter's delay. A manual `observe()` remains an explicit read; if it returns pending, a later `wait()` still respects the new delay.

The SDK enforces a 30-second local deadline for `prepare`. An adapter must honor the deadline supplied to `observe` and other read callbacks; the SDK does not apply an automatic timeout to observation. Caller cancellation or client close stops SDK waiting and preserves the recovery reference, without guaranteeing that provider transport or compute stopped.

If a response is lost and the provider offers no correlated discovery, the operation remains unknown. Do not reinterpret a timeout, abort, or thrown error as a provider rejection. For a durable application ledger, the optional `client.operations` lifecycle lets the application commit its submission marker in `beforeSubmit` and persist pending-token updates; ordinary sandbox calls use the same SDK execution path.

For multi-stage mutations, call `await ctx.checkpoint(token)` before each native dispatch and after each newly learned acknowledgement, stage result or artifact identity. Tokens must distinguish never submitted, dispatch may have occurred, acknowledged/pending, completed and definitively failed. Checkpoint persistence failures must stop later effects; do not catch them as native transport failures. Recovery references and resource history are application-owned JSON, independent of provider credential lifetime. Native authentication, scope, identity and dependency checks remain mandatory.

A mutation object can implement `continue(attempt, ctx)` through the existing runtime. The direct SDK's explicit `operation.continue()` invokes it with the original operation identities and checkpoint hook. `observe` must remain read-only. Advance only a proven never-submitted next stage after reconciling earlier effects; never replay an uncertain dispatch. Applications must serialize continuation across processes with their own lease or compare-and-swap unless native idempotency provides that guarantee. No SDK database or workflow engine is required.

Adapters may attach typed operation-specific data through `ctx.unknown(reason, outcome)`: a known snapshot reference, confirmed capture and source observation, or known retained volume references. Report failed versus uncertain source restart accurately; a definitive restart failure requires `status: "partial"` with the confirmed snapshot and capture result. A later observation of the source running confirms the requested restart state. Do not certify capture from an allocated ID alone. This data is returned directly on existing SDK errors and does not change the saved operation-reference format. If a compatibility checkpoint fails after an acknowledgement, attach known data to `AdapterCheckpointError.outcome` and stop before later effects. Never reinterpret callback failure as provider validation failure.

Lifetime renewal is a time-relative reset, so `observe` must never submit another renewal. The saved attempt includes `renewal.forSeconds` resolved before dispatch; recover that intent rather than the new connection's default. A recorded ACK confirms acceptance even when a fresh detail read fails, returning `observation: null`. Without ACK, return `ctx.unknown` with the `sandbox_renew` outcome containing the bound resource reference, resolved requested window, and latest read-only observation (or `null`). That observation explains current state without attributing its deadline to the lost operation. There is no renewal continuation after possible dispatch.
