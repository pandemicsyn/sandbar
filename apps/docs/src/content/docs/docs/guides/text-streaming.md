---
title: Streaming and interactive processes
description: Stream sustained stdout/stderr, write incremental input, observe status and explicitly terminate a process.
---

Use `sandbox.processes.start()` for builds, interactive workers and servers. Daytona and E2B expose the same application interface. Sustained mode retains a bounded pending queue rather than a full transcript; stream logs to your own sink if you need to keep them. Output defaults to decoded UTF-8 text with separate stdout/stderr. Select original bytes explicitly when decoding would lose information. Ordinary process pipes do not have terminal semantics.

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

## Original output bytes

Select `output: { mode: "stream", format: "bytes" }` before starting the process. `child.output()` then yields `{ stream, bytes: Uint8Array }`, preserving NUL and invalid UTF-8. Bytes come directly from the native pipe transport. Each chunk owns its bytes; chunk boundaries can split characters or application records. Consume incrementally or decode with your own streaming decoder.

```ts
const child = await sandbox.processes.start({
  command: { kind: "argv", argv: ["cat", "/workspace/archive.bin"] },
  output: { mode: "stream", format: "bytes" },
});
try {
  for await (const chunk of child.output()) {
    await storeBytes(chunk.stream, chunk.bytes);
  }
  console.log(await child.wait());
} finally {
  await child.detach();
}
```

The same single-consumer, queue, overflow and completion rules apply. Each byte chunk is at most 16 KiB, with at most 64 KiB pending. The default format is `"text"`; adapters without binary output support reject the byte profile before dispatch. Exec callbacks continue to receive text. Byte output has deterministic fixtures and live qualification on both built-ins at `5f2bd13`, including 256 KiB of all byte values on stdout and invalid UTF-8/NUL on stderr. Each run destroyed its owned sandbox and closed its client.

## Provider transport facts

E2B sustained mode uses the public envd process RPC rather than the pinned native client's cumulative text buffers. Start/SendInput/CloseStdin/List/SendSignal provide the mapping. EOF requires a compatible envd version. Exit comes from the native end event; PID presence supplies running status and absence without an end event is unknown. Termination is native PID-selected SIGKILL and may race PID reuse; descendants and application cleanup are not guaranteed. A stream disconnect may lose exit observation. End notification and final output drain are separate; final-drain expiry marks output incomplete. Attachment verifies running scope and disables auto-resume without renewing sandbox TTL.

Daytona uses an adapter-owned Python 3 supervisor because native session input cannot provide exact bytes and EOF. It creates a private temporary directory and Unix socket, launches one child with ordinary pipes, and uses bounded local messages for output/input/status/control. No network listener, package download or service installation is involved. Python 3 and writable private `/tmp` are image prerequisites. The supervisor owns the child identity; termination does not delete a native session or destroy a sandbox. Detach closes input and output observation; a supervisor for a still-running child remains until child exit or sandbox destruction. Completed supervisors remove their private files. These mechanics do not appear in ordinary application calls.

## Finite compatibility and limits

Without `output: { mode: "stream" }`, the existing cumulative UTF-8 budget remains: default 1 MiB, configurable with `maxOutputBytes` from 1 through 1,048,576. Supplying both options is invalid. Adapters lacking new hooks reject only the requested new feature; their existing finite operations remain usable. `apps/docs/examples/text-streaming.ts` retains the finite example.

Start setup is bounded to 30 seconds. Pre-dispatch abort reports `WAIT_ABORTED`; abandoned/lost acknowledgement after dispatch reports `OUTCOME_UNKNOWN`. Start is never replayed. `deadlineSeconds` still rejects before start because no portable remote-runtime deadline is guaranteed. Sandbox TTL remains separate. Commands may buffer their own output.

Historical replay and cursors remain unsupported. Use the scoped process reference and explicit terminal APIs below for the delivered P4 extensions.

## Live callbacks on bounded exec

`await box.exec(input, { onOutput, signal })` invokes one awaitable text callback per chunk while retaining the normal bounded original-byte `ExecOutput`. Callback execution, byte capture and confirmed exit belong to one command dispatch. The adapter must advertise exact-byte capture as well as sustained output; otherwise the call rejects before effects. This convenience never falls back by running the command again. Finite stdin is split into accepted writes followed by EOF. Explicit `deadlineSeconds` is unsupported for this streaming path; use a call signal to bound local observation and sandbox lifetime to bound owned compute.

A slow or throwing callback can fail local observation. Any already confirmed exit and native byte capture remain attached to the failure as `confirmedExit` and `output`; neither the callback nor local cancellation terminates the remote process. The capture budget still limits retained bytes and reports truncation; it does not impose a cumulative limit on text delivered to the callback. Payloads, input and output are excluded from ordinary telemetry.

Abandoned Daytona setup writes a private cancellation marker before releasing its local transport. A bootstrap delayed beyond the lost HTTP acknowledgement checks that marker before launching a child. If no bootstrap arrives, the small cancellation directory remains until owned sandbox destruction; it is not a running service or a retained provider artifact.

## Signals and explicit terminals

`await child.signal("SIGTERM")` requests graceful termination; `"SIGKILL"` is also supported. Request acknowledgement does not establish exit: await `child.wait()` separately. `terminate()` remains the SIGKILL convenience. There is no automatic escalation or sandbox destruction. A process can ignore SIGTERM, and descendants are not guaranteed to stop.

Use `box.terminals.start({ command, columns: 80, rows: 24 })` when an application needs a terminal. Its single `output()` iterator yields combined `Uint8Array` chunks. It supports `write()`, `resize({ columns: 120, rows: 40 })`, status, wait, signals and termination. It has no `closeStdin()`: Ctrl+D is terminal input, not pipe EOF. PTYs can echo input, translate newlines and change program buffering. Ordinary process pipes retain their existing semantics.

## Reopen a process after reconnecting

Save both `sandbox.reference` and `child.reference()` as private JSON. A process reference snapshots its current profile; creating one rejects while EOF acknowledgement is pending or input delivery is uncertain. Call `await child.disconnect()` to park observation while preserving the child's stdin, then reconnect the client, obtain the same sandbox through `client.sandboxes.get(savedSandbox)`, and call `sandbox.processes.reopen(savedProcess)`. Terminals use `sandbox.terminals.reopen(savedTerminal)`. A disconnected handle rejects further input/control. `detach()` remains local disposal and may close guest stdin; use disconnect when you intend to reopen.

References verify provider, sandbox, connection scope and profile; they expire after at most 24 hours and can become unavailable earlier. Reopening never starts a replacement process. Reopened handles have `outputGap: true`, and their exit results keep `outputComplete: false`. Only the newly attached live stream is available; there is no historical transcript replay. Native buffers may still deliver bytes emitted before attachment, so this is not an exact emission-time cutoff. Output during a connection gap can be lost. An active attachment may prevent reopening. Save references privately and do not treat them as immutable process identities across arbitrary native-provider operations.

E2B uses random tags scoped to the sandbox and connection; native clients can reuse tags, so these are selectors rather than immutable generations. Its live streams can have concurrent subscribers. Daytona verifies a supervisor generation and rotates exclusive attachment leases; explicit disconnect releases the lease immediately, while a lost client's lease expires after 30 seconds without requests. Its supervisor discards output while disconnected. No application-level provider options are required for either mapping.

## Bounded diagnostic lines and tails

`readProcessLines(child.output(), { maxLineBytes: 16_384, signal })` yields `{ stream, text, partial, truncated }`. It decodes split UTF-8 separately for each stream, handles CRLF, clips oversized lines and discards their remainder until newline. A final unterminated line is partial. A quiet process waits until output or cancellation; cancellation releases only output observation.

`createProcessTail({ maxBytes: 65_536, maxChunks: 256, maxLines: 200, maxLineBytes: 16_384 })` gives a rolling diagnostic window. Feed each output chunk to `tail.push(chunk)` while streaming it to your normal sink. `tail.snapshot()` returns `{ lines, truncated }` immediately, even for a quiet process. Snapshots are independent and include partial lines. Window eviction can start mid-character or mid-line; the truncation flag records that gap. These helpers never retain a full transcript, retrieve historical provider logs or own remote compute.
