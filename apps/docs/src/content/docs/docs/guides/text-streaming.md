---
title: Streaming and interactive processes
description: Read live process output, send input, check status, and stop a process.
---

Use `sandbox.processes.start()` when you need live output from a build, worker or server. E2B and Daytona support the process features on this page through the same SDK methods. The examples assume you already have a `sandbox` handle; see [sandboxes and execution](/docs/guides/resources/).

Set `output: { mode: "stream" }` for long-running processes. Sandbar keeps a small queue of unread output, so read it as it arrives. Save chunks to your own log or storage if you need a complete transcript. Output defaults to UTF-8 text, with separate stdout and stderr. Use the [byte format](#original-output-bytes) for binary data, or a [terminal](#signals-and-explicit-terminals) for programs that need terminal behavior.

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

`render` is your application's output handler. The example reads output while sending requests, closes stdin when there is no more input, and waits for both output and exit. `Promise.allSettled()` lets you inspect output errors and exit errors separately.

**Sending input.** Set `stdin: "pipe"` to call `write()` and `closeStdin()`. The default, `"closed"`, does not accept input. Strings are encoded as UTF-8; `Uint8Array` values preserve exact bytes, including NUL and invalid UTF-8.

Each write can contain at most 64 KiB. The input queue holds at most 256 KiB, including the write in progress, and at most 256 calls. Split larger input and await each write. Sandbar copies accepted bytes and sends writes in order. An empty write checks that input is still allowed but does not close stdin. `closeStdin()` sends end-of-input (EOF) after earlier writes; repeated successful closes do not send EOF again. Later writes reject locally.

A successful write means the transport accepted it, not that the program read it. Cancelling a queued write before it is sent has no remote effect. If a sent write or EOF is not acknowledged, delivery is unknown and further input is disabled. Sandbar never retries that input. You can still read output, check status, wait or terminate where the connection allows. Each dispatched input request, status check and termination request has a 30-second local timeout; that timeout does not limit the process's runtime or the sandbox's lifetime.

**Reading output.** Each process has one output consumer. In stream mode, leaving the output loop stops reading output but leaves input and process control available. In the default finite mode, leaving the loop detaches the whole local handle.

The unread SDK queue holds at most 64 KiB and 256 chunks. Each delivered chunk is at most 16 KiB. Stream mode has no total output limit over the process's lifetime. If your consumer falls behind and fills the queue, output fails with `OUTPUT_CAPACITY`. Sandbar stops local output observation without silently dropping chunks or killing the process. A native transport can allocate one bounded incoming frame before the SDK checks its queue. Do not depend on an exact ordering between stdout and stderr, or assume a slow reader will make the guest program pause its output.

**Waiting for exit.** `wait({ signal })` waits for a confirmed exit and returns an exit code, including nonzero codes. It has no default timeout; supply an abort signal to limit your wait. Aborting cancels only that waiter.

The result's `outputComplete` is true only after the output stream has ended and all queued output has been delivered without a gap. A wait that finishes before output drains can return false; a later wait can return true. Earlier results do not change. An output error does not erase a confirmed exit. If a broken connection also prevents exit observation, the wait fails as unavailable instead of guessing an exit code.

**Checking status.** `status({ signal })` returns `{ state: "running" | "exited" | "unknown", exit?, observedAt }` without downloading a transcript. Unknown means there is not enough evidence to say whether the process is running. Having a local handle alone does not prove it is running. A confirmed exit is preserved.

**Stopping and cleaning up.** `terminate({ signal })` returns `{ status: "requested" | "not-found" | "exited" }`. A successful request does not prove the process has exited: call `wait()` separately. Concurrent callers share one termination request, and cancelling one caller stops only its wait. If the request's acknowledgement is lost, later calls return the saved `OUTCOME_UNKNOWN` failure without sending another request. Termination targets the launched process; [provider limitations](#provider-transport-facts) apply to child processes and cleanup. Sandbar does not escalate automatically or destroy the sandbox as a fallback.

`detach()` releases local input and output connections and discards unread output. Calling it again is safe. It does not request a kill, resume compute or extend sandbox lifetime. Disconnecting pipes can still affect the program, so remote continuation is not guaranteed. Destroy a sandbox you own when the workflow finishes. Lifecycle operations submitted through the same client prevent old process handles from sending new control requests; other clients can still cause races.

## Build, worker and server recipes

The [interactive process examples](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/interactive-processes.ts) show three workflows:

- `buildWithProgress`: read build output as it arrives and wait for exit.
- `interactiveWorker`: send requests while reading output, then close stdin.
- `serverWorkspace`: read server logs, obtain a preview URL, and check readiness for up to 15 seconds. After application work, request termination and wait for exit within a ten-second cleanup budget. Finally, detach, destroy the sandbox and close the client.

Configure preview access in adapter setup. Starting a server does not publish its port. For protected previews, send the returned headers and refuse redirects.

These examples compile against the packed SDK and run in Node and Bun with a separate test adapter. Provider fixtures and live qualification are separate checks; a passing example test alone does not prove a live provider works.

## Original output bytes

Set `output: { mode: "stream", format: "bytes" }` when starting the process. `child.output()` then yields `{ stream, bytes: Uint8Array }` from the native pipe, preserving NUL and invalid UTF-8. Each chunk owns its bytes. A chunk can end in the middle of a character or application record; process chunks incrementally or use a streaming decoder.

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

`storeBytes` is your application's byte handler. The same rules for one consumer, unread output, overflow and completion apply. Each byte chunk is at most 16 KiB, with at most 64 KiB unread. Adapters without byte output support reject this option before starting the process. Exec callbacks still receive text.

Byte output has deterministic fixtures and passed live qualification on E2B and Daytona at revision `5f2bd13`. Those runs checked 256 KiB containing all byte values on stdout and invalid UTF-8/NUL on stderr, then destroyed their sandboxes and closed their clients.

## Provider transport facts

These details explain provider requirements and limits. Applications use the same SDK methods for both providers.

**E2B** uses envd's process API directly, avoiding the native client's growing text buffers. EOF requires a compatible envd version. A native end event confirms exit. Status checks look up the selected process; absence without an end event means unknown. Termination sends native SIGKILL using the process selector. Reuse of native selectors can cause races, and neither descendant termination nor application cleanup is guaranteed.

A disconnected E2B stream can lose exit observation. The exit event can arrive before the last output; if the final output drain times out, output remains incomplete. Attaching checks that the sandbox is running and disables auto-resume without extending its lifetime.

**Daytona** uses a small Python 3 supervisor inside the sandbox because native session input cannot deliver exact bytes and EOF. It needs Python 3 and writable private `/tmp` storage in the image. The supervisor creates a private temporary directory and Unix socket, starts one child with ordinary pipes, and exchanges bounded messages for input, output and control. It does not open a network port, download packages or install a service.

The supervisor tracks the child it launched. Termination does not delete a native session or destroy the sandbox. Detach closes input and output observation. If the child still runs, its supervisor remains until child exit or sandbox destruction. Completed supervisors remove their private files.

## Finite compatibility and limits

Choose `output: { mode: "stream" }` for long-running or interactive work and read output promptly. Without it, output uses the default finite mode: at most 1 MiB of cumulative UTF-8 output. Set `maxOutputBytes` to a value from 1 through 1,048,576 to lower that limit. You cannot combine `maxOutputBytes` with stream mode. Adapters without stream or input support reject the requested feature before starting; their existing finite operations remain available. The [finite streaming example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/text-streaming.ts) demonstrates the default mode.

Process setup has a 30-second local timeout. An abort before dispatch reports `WAIT_ABORTED`. If setup is abandoned after dispatch or its acknowledgement is lost, it reports `OUTCOME_UNKNOWN`. Sandbar never starts the command again to recover from an uncertain result.

`processes.start()` rejects `deadlineSeconds` before starting because it cannot guarantee a portable runtime deadline. Sandbox lifetime is separate. Programs can also buffer their own output, delaying what you see even when streaming is enabled.

Output replay and cursors are unsupported. See [reopening](#reopen-a-process-after-reconnecting) for how to reconnect to a process's live output.

## Live callbacks on bounded exec

Use `await sandbox.exec(input, { onOutput, signal })` when you want live text updates and the usual bounded `ExecOutput` result. Sandbar awaits `onOutput` for each chunk and captures the original bytes from the same command. The adapter must support both exact-byte capture and sustained output; otherwise the call rejects before running. Sandbar never runs the command again as a fallback. Finite stdin is split into writes followed by EOF. Command, working directory, environment, stdin and capture limits keep their usual meanings.

Callback exec rejects an explicit `deadlineSeconds` before starting. Its process transport cannot apply the timeout used by ordinary exec: E2B's process start has no total RPC timeout, and Daytona's supervisor setup timeout does not limit the child. With no `deadlineSeconds`, callback exec has no execution or observation timer. Ordinary exec keeps its provider-specific 300-second default; see [execution and waiting timeouts](/docs/guides/resources/#execution-and-waiting-timeouts). Pass an abort signal to limit local observation. It does not kill the process or change sandbox lifetime. Modal does not support callback exec.

A slow or throwing callback can fail local observation. The error keeps the original failure as `cause`, and any already confirmed exit and captured bytes as `confirmedExit` and `output`. Callback failure or local cancellation does not request termination. The capture limit bounds retained bytes and reports truncation; it does not limit the total text sent to callbacks. Ordinary telemetry excludes input and output payloads.

If Daytona setup is abandoned, the adapter writes a private cancellation marker before releasing its connection. A delayed supervisor checks it before launching a child. If setup never arrives, the small marker directory remains until sandbox destruction.

## Signals and explicit terminals

`await child.signal("SIGTERM")` asks the process to shut down gracefully. A process can ignore SIGTERM, so call `child.wait()` to confirm exit. `"SIGKILL"` requests a forced stop; `terminate()` is the convenience method for that signal. Sandbar does not automatically escalate from SIGTERM to SIGKILL or destroy the sandbox. Descendant processes are not guaranteed to stop.

Use `sandbox.terminals.start({ command, columns: 80, rows: 24 })` for programs that need a terminal. Its one `output()` iterator yields combined stdout/stderr as `Uint8Array` chunks. You can write input, resize with `resize({ columns: 120, rows: 40 })`, check status, wait, send signals and terminate.

A terminal has no `closeStdin()`. Sending Ctrl+D is terminal input, not a pipe close. Terminals can echo input, translate newlines and change how programs buffer output. Use ordinary process pipes when you need separate stdout/stderr or explicit EOF.

## Reopen a process after reconnecting

To return to the same process later:

1. Save `sandbox.reference` and `child.reference()` as private JSON. The process reference records its current input/output settings. Creating one rejects while EOF acknowledgement is pending or input delivery is uncertain.
2. Call `await child.disconnect()` to release observation without closing the child's stdin. The old handle then rejects further input and control requests.
3. Reconnect the client, get the same sandbox with `client.sandboxes.get(savedSandbox)`, and call `sandbox.processes.reopen(savedProcess)`. For a terminal, use `sandbox.terminals.reopen(savedTerminal)`.

Use `disconnect()` when you intend to reopen. `detach()` disposes local connections and may close guest stdin.

References check the provider, sandbox, connection scope and process settings. They expire after at most 24 hours and can become unavailable sooner. Reopening never starts a replacement process. Another active attachment can prevent reopening.

A reopened handle has `outputGap: true`, and its exit results always have `outputComplete: false`. It reads the newly attached live stream, with no historical replay. Output during the connection gap can be lost. Native buffers can also deliver bytes emitted before attachment, so attachment time is not an exact cutoff. Keep references private; they are not immutable identities across arbitrary native-provider operations.

E2B selects processes with random tags scoped to the sandbox and connection. Native clients can reuse those tags, and E2B permits concurrent stream subscribers. Daytona checks a supervisor generation and permits one attachment at a time. Explicit disconnect releases that attachment immediately; after a lost connection, it becomes available after 30 seconds without requests. The Daytona supervisor discards output while disconnected. These differences need no provider options in application calls.

## Bounded diagnostic lines and tails

Import `readProcessLines` and `createProcessTail` from `sandbar-sdk` to turn output into bounded diagnostic text.

`readProcessLines(child.output(), { maxLineBytes: 16_384, signal })` yields `{ stream, text, partial, truncated }`. It handles UTF-8 characters split across chunks and Windows-style CRLF newlines separately for stdout and stderr. It clips oversized lines, marks them truncated and discards the rest until the next newline. A final line without a newline is marked partial. For a quiet process, the iterator waits for output or cancellation. In stream mode, cancellation releases only output observation.

`createProcessTail({ maxBytes: 65_536, maxChunks: 256, maxLines: 200, maxLineBytes: 16_384 })` keeps a rolling window of recent output. Pass each chunk to `tail.push(chunk)` while also saving it to your normal log. `tail.snapshot()` immediately returns `{ lines, truncated }`, even when the process is quiet. Each snapshot is independent and can contain partial lines. Discarding old output can leave the window starting in the middle of a character or line; the truncation flag records that gap.

Neither helper stores a full transcript, fetches old provider logs or stops the remote process.
