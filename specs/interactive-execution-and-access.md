# First streaming execution slice

Implementation contract · Updated October 5, 2026 · E2B streaming (#52), read cancellation (#51) and E2B termination (#66) merged; scoped streaming/file-read workflows passed at `3188e33` in #68

The [current process IO contract](process-io-dx.md) owns sustained output, incremental input, byte output, signals, terminals and reopening. This document retains the legacy finite E2B profile. Exact signatures are owned by the [SDK exports](../packages/sdk/src/index.ts) and [public reference](../apps/docs/src/content/docs/docs/reference/typescript.md).

The legacy E2B profile delivers one command start, separate stdout/stderr **text**, and confirmed exit through a local handle. Bounded `exec()` remains available for binary capture and short commands. This profile uses the pinned high-level SDK’s text callbacks; original-byte streaming uses the additive transport in the current process contract. Do not label UTF-8 re-encoded native text as original bytes.

## Legacy provider boundary

This finite profile uses pinned `e2b@2.51.0` background commands, text callbacks, closed stdin and a mandatory cumulative output cap because the native handle retains decoded output. It starts once with retries disabled and has no runtime-deadline or reopening guarantee. E2B local-handle termination is described below. The additive transports and provider support for sustained processes are owned by [process IO](process-io-dx.md); legacy limitations here do not describe all current process profiles.

## Public contract

PR #52 exports this local text-streaming surface through the SDK. Exact current types include additive process profiles; the sketch below describes this legacy finite profile only.

A successful start returns a handle as soon as the native start event supplies its local handle, not when the command exits. Attach the output receiver before dispatch so early output cannot fall between start and subscription. A single consumer can call `output()` once; a second call rejects `INVALID_ARGUMENT` without changing the first consumer. `wait()` can be called repeatedly/concurrently and returns the same confirmed exitCode, with outputComplete sampled at settlement; each caller's abort only ends that caller's wait. It does not detach the output receiver or abort the native command stream.

The legacy finite handle is local observation state, has no serialized `reference`, no public PID identity and no `get()`/`inspect()`/`submitStart()` API. Its provider connection owns native credentials. Do not invent a serializable generation token to make unsafe native PID selectors look safe. The first slice did not provide termination. PR #66 implements the follow-up [termination contract](preview-and-process-control.md#process-control-that-means-what-it-says) for E2B local-handle `terminate()` as a native PID request with explicit exit/reuse races, shared cached acknowledgement and no replay. It does not promise immutable execution targeting. Sandbox `destroy()` remains a separate deliberate lifecycle action.

Pre-aborted start rejects `WAIT_ABORTED` before dispatch. Abort or transport loss after dispatch can mean the command started: reject `OUTCOME_UNKNOWN`, with provider and sandbox ID only where known; no automatic retry and no claim that these fields can reopen the command. If the native handle arrives after local start abandonment, disconnect it immediately. Do not orphan a local socket, kill the command, or wait indefinitely for a non-cooperative provider. Process failures use current error conventions with a typed optional confirmed `ProcessExit` where available.

`wait()` reports normal and nonzero exits without throwing merely for an exit code. This intentional observation API differs from bounded `exec()`, which keeps `NonzeroExitError`/`NoExitCodeError`. Transport loss without exit evidence rejects `UNAVAILABLE`; never synthesize exit 0, a signal, a runtime-timeout cause, or a missing exit code. Output failure rejects the iterator; it does not erase an exit already confirmed.

## Legacy adapter boundary

The legacy profile uses the optional `processes` member on the public adapter session. Do not route it through the durable `Mutation`/checkpoint runtime or internal provider SPI. Use current `Command`, `Sandbox` and error conventions from `sandbar-adapter`.

Exact adapter hooks are owned by the [adapter exports](../packages/adapter/src/index.ts); legacy native observation failures may carry validated `confirmedExit` evidence.

Presence advertises only this fixed text/closed-stdin/local-handle contract. Reject `deadlineSeconds` in SDK validation for this slice; do not add inactive capability dimensions for signals, cursors or stdin. Resolve unsupported methods/options before mutation. Setup uses a 30-second local deadline and client-close signal. E2B disables the native streaming RPC timeout (`timeoutMs: 0`), sets `requestTimeoutMs: 30_000`, `stdin: false`, and uses the existing `retries: 0` connection configuration. Setup abort must not remain wired to an established stream: separate its controller from the stream lifetime, retain late-handle disposal, and clear setup timers after the native start event. Streaming must use the [non-resuming E2B guest-attachment path](sandbox-lifecycle.md#reopening-and-identity): a bounded authenticated detail/token GET, verified scope and trusted routing, then local construction of the pinned SDK client and direct envd access. Require running state, `autoResume === false` and the detail token before guest access; missing/true auto-resume or missing token makes access unavailable. Do not call `Sandbox.connect` or POST connect: a running preflight cannot prevent a pause before attachment from implicitly resuming compute. Local construction alone does not disable server auto-resume; reject changed lifecycle policy rather than mutating it back. External policy changes after verification remain the documented native race.

E2B transport maps native nonzero-exit errors to the ordinary exit result. On other native wait failures, read the public `handle.exitCode`: if it is a valid confirmed integer, throw `ProcessObservationFailure` carrying `confirmedExit`; otherwise omit that field. The SDK fails the output iterator, caches the confirmed exit and returns it with incomplete output from pending/subsequent waits. Validate this optional field and never recover exit by parsing an exception message. E2B sets its result before decoder-flush callbacks, so a flush failure can coexist with confirmed exit. Native callback delivery starts before `run()` resolves: enforce the output budget in callbacks and latch a disconnect request until the returned handle is available. Attach rejection handlers to native wait immediately to avoid unhandled rejections. Lifecycle interruption or client closure ends local observation; it never reconnects to a restored/resumed generation.

## Buffering, completeness and cancellation

Defaults are intentionally fixed: cumulative output budget **1 MiB combined**, configurable integer **1–1,048,576 bytes**, measured as UTF-8 encoding length of native text; pending-consumer queue **64 KiB combined**, with at most **256 chunks**, and per emitted chunk at most **16 KiB UTF-8** (split only on code-point boundaries). Reject invalid limits before dispatch. Tiny chunks consume the chunk limit even when byte usage is low. No capture copy is kept by Sandbar beyond the pending queue and a terminal result/error.

E2B's public handle also retains decoded text internally. A drained Sandbar queue does not bound that accumulation: the cumulative budget is mandatory, even for fast consumers. On the first callback crossing either cumulative or queue limit, stop admission, latch `OUTPUT_CAPACITY`, disconnect locally immediately (or on late handle arrival), and reject output/wait promptly unless exit is already known. Do not kill compute. If overflow precedes start resolution, `start()` rejects `OUTPUT_CAPACITY` with effect possible and minimal provider/sandbox context, and disconnects the late handle without exposing a partial public handle. For an established handle, deliver the already admitted prefix, then throw; no silent dropping and no resumable gap/cursor format. An error means the remainder is unavailable through this handle.

Sandbar-owned buffers obey these bounds. Native decoding/transport can allocate an incoming message before a callback checks the limit, and already in-flight decoding/final flush can append text after disconnect; these numbers are not an RSS or provider log-storage guarantee. Fixtures must cover one oversized incoming message and show no additional Sandbar admission or native callbacks after disconnect; permit in-flight native decode/flush allocation. Do not change private E2B fields or import its internal RPC protocol to claim a stronger cap. Sustained profiles use the separate raw transport described in process IO; this legacy path retains its native-client limitation.

Do not promise workload backpressure: callbacks are awaited by E2B, but server/socket buffering is not a verified end-to-end bound. Sandbar callbacks synchronously enqueue within the budgets; slow consumers fail locally. There is no unbounded pending promise chain. Provider-side retained logs may continue growing after detach; sandbox lifetime still applies.

On normal native stream end plus confirmed exit, output drains and ends. `outputComplete` becomes true only after all admitted chunks were yielded and the native stream finished without loss; a wait that settles earlier conservatively returns false. Results returned earlier stay historical and are not mutated; a later `wait()` may return true once drain completes. If delivery has not already completed, closing the iterator (`break` or abort), `detach()` or client close ends the subscription, discards queued text and leaves completeness false. Aborting output throws `WAIT_ABORTED` and performs local detach. Explicit `detach()` closes the iterator normally, settles unconfirmed waits with `UNAVAILABLE`, and preserves a cached confirmed exit; completeness stays true if delivery had already finished, otherwise false. Detachment cannot undo completed delivery. It never waits for remote exit. A provider that already supplied confirmed exit keeps it when later local output delivery fails.

| User intent | Operation | Guarantee |
| --- | --- | --- |
| Stop this local wait after 5 seconds | `wait({ signal: AbortSignal.timeout(5000) })` | Only that waiter stops; command/output continue |
| Stop watching output | Abort `output()` or call `detach()` | Release local observation; command may keep running |
| End command after a runtime limit | `start({ deadlineSeconds: ... })` | Unsupported here; reject before dispatch |
| Terminate command remotely | E2B `process.terminate({ signal? })` | One native PID SIGKILL request; acknowledgement is not exit, PID reuse race, no whole-sandbox fallback |
| End sandbox lifetime | Existing provider TTL or explicit `sandbox.destroy()` | Separate lifecycle operation affecting compute |

Current bounded-exec timeout analysis and output-helper delivery are maintained in the [focused output/timeout brief](output-and-timeouts.md). It distinguishes RPC/request waiting from verified runtime enforcement and retains existing defaults. This does not change this streaming slice's rejection of `deadlineSeconds` before dispatch.

## Full decoding and bounded display

See the [selected helper API and capture/display contract](output-and-timeouts.md#selected-helper-api). Existing 16 KiB display defaults stay unchanged; full decode and structured previews are a separate additive SDK slice. The focused brief owns signatures, byte/UTF-8 behavior, examples and acceptance.

## Usage and delivery

Legacy usage (covered by packed public-package fixtures):

```ts
const process = await sandbox.processes.start({
  command: { kind: "argv", argv: ["node", "job.js"] },
});
try {
  for await (const chunk of process.output()) {
    const destination = chunk.stream === "stdout" ? console.log : console.error;
    destination(chunk.text);
  }
  const exit = await process.wait();
  console.log(exit.exitCode, exit.outputComplete);
} finally {
  await process.detach(); // release observation even on a display exception
}
```

This legacy profile is for finite text commands whose output fits the budget. Use the explicit sustained/byte profiles in the [current process IO contract](process-io-dx.md) for long-running, high-volume or binary workloads. A command that buffers its own stdout may not emit timely chunks; Sandbar delivers native callbacks promptly, without waiting for exit or creating a hidden shell supervisor. `argv` uses the adapter's existing quoting rules; shell requests use its declared shell. Keep guest stdin closed; preserve cwd/env validation and reject NUL input before start.

Legacy finite E2B streaming passed at `3188e33` in #68 on borrowed base with confirmed owned cleanup. Read cancellation (#51) uses one fixed 30-second local deadline across provider response/chunks, promptly releases local readers and late streams, and reports `WAIT_ABORTED`, `TIMEOUT` or `CLIENT_CLOSED` with effect none. Native cancellation is best effort. Signal-bearing file scenarios passed for both built-ins at that revision. File streaming has its separate [transfer policy](filesystem-dx.md).

## Legacy regression boundaries

Use deterministic native-boundary fixtures; paid live qualification remains separately authorized. Cover:

- Exactly one native command start; no retries after lost acknowledgement, callback failure, local abort or missing exit. Unsupported deadline/provider/invalid cwd/env and pre-abort issue zero start calls.
- Output before the start promise resolves is delivered. A stdout chunk arrives while exit is held pending; stderr arrives independently. Per-stream order is preserved, with no cross-stream ordering claim.
- UTF-8 split boundaries and invalid bytes match the native text decoder, explicitly demonstrating that binary fidelity is not promised. Existing bounded exec binary capture tests remain intact.
- Start rejects after its 30-second setup deadline; a late native handle disconnects once without remote kill. Established streams are unaffected by clearing setup timers or a later abort of the start-only signal.
- Overflow before start resolution rejects start with effect possible and disposes the late handle. Fast-consumer cumulative overflow, slow-consumer queue-byte overflow, tiny-chunk count overflow and one oversized callback settle promptly. Sandbar admission and native callbacks stop after detach; the remote command is not terminated. Non-cooperative native cleanup cannot hold iterator/wait/client close forever.
- Exit 0/nonzero are ordinary confirmed results. Lost transport/no exit rejects; confirmed exit survives subsequent output failure with incomplete output, including a native end event followed by decoder-flush callback failure and native wait rejection. Drain, iterator break, cached result, repeated wait and concurrent waiters match the completeness rules.
- Wait abort affects only its waiter; output abort/iterator return/detach/client close release local stream and report incomplete output. No hidden destroy, signal, PID reattachment, file spool or supervisor is invoked.
- Native E2B connection uses retries 0, stdin false, disabled RPC timeout and separate setup cancellation; paused sandbox is rejected without automatic resume. Exercise the actual pinned client against fake HTTP with a pause between running preflight and attachment: no POST connect, resume, timeout extension or command replay. Auto-resume true/missing and missing detail token fail before guest I/O. Snapshot/suspend/destroy interruption cannot attach to a different execution.
- Compile the concise workflow against exported types and execute it using packed public SDK/adapter consumers on Node and Bun.

These regression boundaries describe the legacy profile; current sustained transport and P4 contracts, qualification and separately scoped work are maintained in [process IO](process-io-dx.md). Offline fixtures do not qualify new live configurations, and reruns require separate paid-call authorization.
