---
title: Streaming and interactive processes
description: Stream sustained stdout/stderr, write incremental input, observe status and explicitly terminate a process.
---

Use `sandbox.processes.start()` for builds, interactive workers and servers. Daytona and E2B expose the same application interface. Sustained mode retains a bounded pending queue rather than a full transcript; stream logs to your own sink if you need to keep them. Output is decoded UTF-8 text with separate stdout/stderr. It is not byte-faithful output or a terminal.

```ts
const child = await sandbox.processes.start({
  command: { kind: "argv", argv: ["python3", "-u", "/workspace/worker.py"] },
  stdin: "pipe",
  output: { mode: "stream" },
});
const output = (async () => {
  for await (const chunk of child.output()) {
    await render(chunk.stream, chunk.text);
  }
})();
const completion = Promise.allSettled([output, child.wait()]);
try {
  await child.write("first request\n");
  await child.write(new TextEncoder().encode("second request\n"));
  await child.closeStdin();
  console.log(await child.status());
  console.log(await completion);
} finally {
  await child.detach();
}
```

`stdin` defaults to `"closed"`. Pipe writes accept UTF-8 strings or exact bytes, including NUL and invalid UTF-8. Each write is limited to 64 KiB; pending input including the in-flight write is limited to 256 KiB and a bounded number of calls. Split larger inputs and await each write. The SDK snapshots admitted bytes and serializes dispatch. Zero-length writes validate input state but do not send EOF. `closeStdin()` sends EOF after prior admitted writes; successful repeated closes reuse the acknowledgement. Writes after EOF reject locally.

Write resolution means transport acceptance, not program consumption. A queued abort before dispatch has no effect. A lost acknowledgement after dispatch makes delivery unknown and disables further input; Sandbar never retries a write or EOF. Output, status, wait and termination remain usable where the transport permits. Every control operation has a 30-second local budget, independent of remote runtime and sandbox lifetime.

Output has one consumer. In sustained mode, breaking out of its loop stops only output observation; input, status, wait and termination remain usable. Legacy finite iterator return retains its existing full local-detach behavior. The pending SDK queue holds at most 64 KiB and 256 chunks, each emitted text chunk at most 16 KiB. There is no cumulative lifetime limit in explicit stream mode. Slow-consumer overflow fails output with `OUTPUT_CAPACITY` and detaches local output; it never silently drops text or terminates the process. Native transports may allocate one bounded incoming frame before SDK admission. No cross-stream ordering or full-path guest backpressure is promised.

`wait({ signal })` independently awaits confirmed exit. Abort cancels only that waiter. Nonzero exit is an ordinary result. `outputComplete` stays false until native output end and all admitted text are delivered without a gap. A wait before drain may return false and a later wait true; earlier results are historical. Output failure preserves confirmed exit. When a transport interruption also removes exit observation, wait reports unavailable rather than inventing a result.

`status({ signal })` returns `{ state: "running" | "exited" | "unknown", exit?, observedAt }`. It reads current evidence without fetching a transcript. Missing native metadata is unknown; the presence of a local handle is not evidence that a process runs. Confirmed exit is preserved.

`terminate({ signal })` returns `{ status: "requested" | "not-found" | "exited" }`. Acknowledgement is not exit: await `wait()` separately. Concurrent callers share one request; caller cancellation stops only its wait. Lost acknowledgement caches `OUTCOME_UNKNOWN`, and subsequent calls do not dispatch again. Termination targets the launched process, with provider-specific target/descendant limitations below. There is no automatic escalation or sandbox destruction fallback.

`detach()` is idempotent local disposal. It closes local input/output transports, discards pending output and never implicitly kills, resumes or renews compute. Disconnect can affect guest pipes; remote continuation is not guaranteed. Always destroy a sandbox you own when its workflow finishes. Local client lifecycle submissions fence old handles from new control requests; this cannot prevent races caused by other clients.

## Build, worker and server recipes

`apps/docs/examples/interactive-processes.ts` contains compiled `buildWithProgress`, `interactiveWorker` and `serverWorkspace` recipes. The server recipe starts output consumption, obtains preview access, probes readiness for at most 15 seconds, runs application work, requests termination and observes exit with a ten-second cleanup budget. It then detaches, destroys its owned sandbox and closes its client. Configure preview access explicitly in adapter setup; starting a process does not publish a port. Protected preview requests carry the returned headers and refuse redirects.

The same recipes compile against packed SDK declarations and execute in Node and Bun with an independently authored adapter. Deterministic provider fixtures and the ordinary maintained live suite are separate evidence; adding a suite does not claim a deployed-provider pass.

## Provider transport facts

E2B sustained mode uses the public envd process RPC rather than the pinned native client's cumulative text buffers. Start/SendInput/CloseStdin/List/SendSignal provide the mapping. EOF requires a compatible envd version. Exit comes from the native end event; PID presence supplies running status and absence without an end event is unknown. Termination is native PID-selected SIGKILL and may race PID reuse; descendants and application cleanup are not guaranteed. A stream disconnect may lose exit observation. End notification and final output drain are separate; final-drain expiry marks output incomplete. Attachment verifies running scope and disables auto-resume without renewing sandbox TTL.

Daytona uses an adapter-owned Python 3 supervisor because native session input cannot provide exact bytes and EOF. It creates a private temporary directory and Unix socket, launches one child with ordinary pipes, and uses bounded local messages for output/input/status/control. No network listener, package download or service installation is involved. Python 3 and writable private `/tmp` are image prerequisites. The supervisor owns the child identity; termination does not delete a native session or destroy a sandbox. Detach closes input and output observation; a supervisor for a still-running child remains until child exit or sandbox destruction. Completed supervisors remove their private files. These mechanics do not appear in ordinary application calls.

## Finite compatibility and limits

Without `output: { mode: "stream" }`, the existing cumulative UTF-8 budget remains: default 1 MiB, configurable with `maxOutputBytes` from 1 through 1,048,576. Supplying both options is invalid. Adapters lacking new hooks reject only the requested new feature; their existing finite operations remain usable. `apps/docs/examples/text-streaming.ts` retains the finite example.

Start setup is bounded to 30 seconds. Pre-dispatch abort reports `WAIT_ABORTED`; abandoned/lost acknowledgement after dispatch reports `OUTCOME_UNKNOWN`. Start is never replayed. `deadlineSeconds` still rejects before start because no portable remote-runtime deadline is guaranteed. Sandbox TTL remains separate. Commands may buffer their own output.

Reconnection, historical replay/cursors, binary output, PTYs and explicit signal selection require separate contracts and are not exposed by ordinary pipe handles. A local process handle cannot be serialized into a safe reopening reference.

## Live callbacks on bounded exec

`await box.exec(input, { onOutput, signal })` invokes one awaitable text callback per chunk while retaining the normal bounded original-byte `ExecOutput`. Callback execution, byte capture and confirmed exit belong to one command dispatch. The adapter must advertise exact-byte capture as well as sustained output; otherwise the call rejects before effects. This convenience never falls back by running the command again. Finite stdin is split into accepted writes followed by EOF. Explicit `deadlineSeconds` is unsupported for this streaming path; use a call signal to bound local observation and sandbox lifetime to bound owned compute.

A slow or throwing callback can fail local observation. Any already confirmed exit and native byte capture remain attached to the failure as `confirmedExit` and `output`; neither the callback nor local cancellation terminates the remote process. The capture budget still limits retained bytes and reports truncation; it does not impose a cumulative limit on text delivered to the callback. Payloads, input and output are excluded from ordinary telemetry.

Abandoned Daytona setup writes a private cancellation marker before releasing its local transport. A bootstrap delayed beyond the lost HTTP acknowledgement checks that marker before launching a child. If no bootstrap arrives, the small cancellation directory remains until owned sandbox destruction; it is not a running service or a retained provider artifact.
