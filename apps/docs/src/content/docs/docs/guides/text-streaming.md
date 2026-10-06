---
title: Finite text streaming
description: Observe E2B stdout, stderr and confirmed exit through a local process handle.
---

E2B supports `sandbox.processes.start()` for finite text commands. Output arrives through separate stdout/stderr native callbacks while the command runs. Other adapters reject `UNSUPPORTED` before starting. Keep `exec()` for binary capture. Text follows E2B's UTF-8 decoder, including replacement characters for invalid bytes; original binary bytes cannot be recovered.

```ts
const process = await sandbox.processes.start({
  command: { kind: "argv", argv: ["/bin/sh", "-c", "printf hello; printf err >&2; exit 7"] },
  maxOutputBytes: 4096,
});
try {
  for await (const chunk of process.output()) {
    (chunk.stream === "stdout" ? console.log : console.error)(chunk.text);
  }
  const exit = await process.wait();
  console.log(exit.exitCode, exit.outputComplete); // 7, true after full drain
} finally {
  await process.detach();
}
```

The handle has one output consumer and repeated/concurrent waits. Zero and nonzero exits are ordinary results. `outputComplete` describes delivered output: a wait before consumer drain returns false; a later wait may return true. Earlier results remain unchanged. Confirmed exit survives output/decoder failure. Missing exit evidence rejects `UNAVAILABLE` and never invents exit zero.

The cumulative combined UTF-8 text budget defaults to 1 MiB and accepts integers from 1 through 1,048,576. The pending queue holds at most 64 KiB and 256 chunks; emitted chunks are at most 16 KiB, split on code-point boundaries. Crossing a limit disconnects locally and throws `OUTPUT_CAPACITY`. Established consumers receive the admitted prefix before the error. Sandbar retains only that bounded queue; E2B also accumulates text up to the cumulative budget. Incoming native decoding and in-flight final flush can allocate beyond admission bounds. These are not RSS, workload backpressure or provider log-storage guarantees.

`wait({ signal })` cancels only that waiter. Output abort, iterator return, `detach()` and client close promptly release local observation and discard queued text. Output stays incomplete unless delivery already finished. These actions never terminate the command or sandbox; provider logs may keep growing. Sandbox destruction is a separate lifecycle action.

Start setup is bounded to 30 seconds independently of stream lifetime. Pre-dispatch abort reports `WAIT_ABORTED`; abandoned/lost acknowledgement after dispatch reports `OUTCOME_UNKNOWN`. Early overflow reports `OUTPUT_CAPACITY` with effect possible. These errors include `provider` and `sandboxId` as local context, which cannot reopen a command. Start is never replayed; do not blindly resubmit uncertain work.

Requested `deadlineSeconds` rejects before dispatch: no native command runtime bound is provided. Sandbox TTL still applies. `processes.start` has closed stdin; use [finite input to ordinary exec](/docs/guides/files-and-output/#supply-finite-command-input) for a complete text or byte payload. PTY, arbitrary signal selection, process reopening, replay/cursors and binary streaming remain unsupported. Commands that buffer stdout may emit no timely chunks. Long-running/high-volume workloads are outside this slice.

E2B reuses non-resuming guest attachment: authenticated detail GET, verified scope, running state, explicit `autoResume: false`, guest token/version and trusted routing, then local construction. It never POSTs connect, resumes compute or extends TTL. External lifecycle/policy changes after verification remain a native race; failure never reconnects to another generation.

The public example in `apps/docs/examples/text-streaming.ts` compiles and runs against packed Node/Bun fixture consumers. Deterministic pinned-client fixtures cover transport/decoding. The maintained finite-streaming case passed at `3188e33` on borrowed base with Bun 1.3.14/darwin-arm64 and confirmed owned cleanup. This covers that recorded configuration; further live runs require separate authorization.

## Terminating an active E2B command

Call `job.terminate({ signal? })` before detaching to request E2B’s native SIGKILL. It is abrupt and does not promise application cleanup or termination of descendants. The captured native selector is a PID: if the original command exits and the PID is reused before native lookup, a successor could be signalled. An active stream narrows this window but cannot eliminate it. Applications requiring immutable execution targeting cannot use this operation.

The result is `{ status: "requested" | "not-found" | "exited" }`. `requested` acknowledges the signal request, not exit; `not-found` means the native selector is absent without supplying an exit; `exited` means this handle already confirmed a terminal result and sent no request. Use `wait()` for that result. E2B can report native `exitCode: -1` after signal termination; it is preserved, not translated to 137 or treated as evidence of a particular signal. Native signal handling may cancel output pipes, so `outputComplete` covers delivered native text, not all bytes the workload attempted to write.

Concurrent calls share one request. Caller cancellation stops only its own wait; a subsequent call reuses the eventual acknowledgement. A pre-aborted caller gets `WAIT_ABORTED` without consuming the attempt. Lost acknowledgement, shared request deadline or request transport failure caches `OUTCOME_UNKNOWN`; no subsequent call dispatches again. Independently confirmed exit remains readable and makes later calls return `exited`. The shared request has a 30-second local deadline; client close attempts to cancel its IO. Local cancellation cannot undo a possibly sent SIGKILL.

Without an earlier request, detached handles, lost observation, output overflow and client close reject before new dispatch. A previously dispatched request’s cached outcome survives those events. There is no reattachment, lifecycle change, shell supervisor, automatic escalation or sandbox-kill fallback. Other adapters may omit the optional native method and return `UNSUPPORTED`.

The `terminateJob` recipe in `apps/docs/examples/text-streaming.ts` uses one ten-second signal for termination, exit observation and output draining, then always detaches locally. This bounds a stream that never closes even after exit is confirmed. A failed termination acknowledgement can still be followed by independent exit observation. The recipe compiles and runs against packed Node/Bun consumers. The bounded E2B termination case passed on borrowed base with Bun 1.3.14/darwin-arm64 after the fixed-default guest-routing correction; owned compute cleanup and client close were confirmed. An earlier attachment failure remains recorded. This live result covers the tested configuration, not PID races or descendant cleanup.

Submitting destruction, suspension, resumption or an accepted snapshot plan through any wrapper for the same sandbox on one client invalidates older handles for new termination requests before lifecycle dispatch. This is a local submission fence, not native generation proof: a rejected or uncertain lifecycle submission does not restore old termination authority. Observation/wait continue independently. Other clients and external lifecycle changes are detected only through observation interruption; they can race dispatch. New starts capture fresh local authority without reattaching old commands.
