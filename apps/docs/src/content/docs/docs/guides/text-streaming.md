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

Requested `deadlineSeconds` rejects before dispatch: no native command runtime bound is provided. Sandbox TTL still applies. No stdin, PTY, remote signal/kill, process reopening, replay/cursors or binary streaming. Commands that buffer stdout may emit no timely chunks. Long-running/high-volume workloads are outside this slice.

E2B reuses non-resuming guest attachment: authenticated detail GET, verified scope, running state, explicit `autoResume: false`, guest token/version and trusted routing, then local construction. It never POSTs connect, resumes compute or extends TTL. External lifecycle/policy changes after verification remain a native race; failure never reconnects to another generation.

The public example in `apps/docs/examples/text-streaming.ts` compiles and runs against packed Node/Bun fixture consumers. Deterministic pinned-client fixtures cover transport/decoding. The maintained E2B live scenario remains unrun pending paid-call authorization.
