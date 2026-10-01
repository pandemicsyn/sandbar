# First streaming execution slice

Implementation contract · Updated October 1, 2026 · E2B streaming merged in PR #52; read cancellation merged in PR #51; new live validation not run

Research baseline: freshly fetched `origin/main` at `d186cea` (PRs #32 and #33 merged). This replaces the broad interactive-execution draft with one delivery decision. Preserve [ordinary results and minimal identities](sdk-recovery-dx.md); its older PR-status sentence is historical. No new persistence callbacks, completion-facts envelopes, continuation framework is required.

Deliver one command start, timely separate stdout/stderr **text**, and confirmed exit through a local handle. Keep bounded `exec()` for binary capture and short commands. First provider: E2B. A text-only first slice is deliberate: neither pinned high-level SDK supplies binary-faithful streaming callbacks. Do not label UTF-8 re-encoded native text as original bytes.

## Evidence and provider support

The table records the original research candidates, not live qualification. No paid calls were made. The research baseline exposed only bounded exec; the coding slice now implements finite E2B text streaming as described below. E2B is pinned to `e2b@2.51.0` in `packages/providers/e2b/package.json` and `bun.lock`. Daytona uses single-attempt REST/toolbox calls; its reference SDK is `@daytona/sdk@0.218.0`, not a runtime dependency.

| Behavior | E2B 2.51.0 | Daytona 0.218 reference | First delivery |
| --- | --- | --- | --- |
| Start once, live text | `commands.run(cmd, { background: true, onStdout, onStderr, stdin: false })` returns `CommandHandle` | Create dedicated session, `executeSessionCommand(..., { runAsync: true })`, follow command logs | E2B only; one start RPC, no retry |
| Exit | `handle.wait()`, including `CommandExitError` result | GET session command exposes optional `exitCode`; poll | E2B normal/nonzero exits become ordinary results |
| Local detach | `handle.disconnect()` stops callbacks and leaves command running | Close log WebSocket; keep session/command | E2B `detach()`; never kill sandbox |
| Remote termination | `handle.kill()` / `commands.kill(pid)` send SIGKILL by PID | Session DELETE exists; no verified per-command signal contract | Unsupported in slice 1; do not advertise portable `signal()` |
| Runtime deadline | `timeoutMs` is passed to streaming RPC, not a process-runtime field | Async session request has no native runtime-deadline field; SDK timeout limits HTTP request | Reject requested runtime deadlines before start |
| Reattachment | `commands.connect(pid)` and `list()` exist; no immutable process generation in public selector | Session ID + command ID permit status/log reads; no proven retained cursor or restart-generation contract | No reopening, cursors or reconnect in slice 1 |
| Binary streams | Native protocol carries bytes; public handle decodes UTF-8 | Log demux decodes UTF-8 and scans sentinel prefixes | Deferred; preserve binary bounded exec |
| Stdin | `sendStdin` / `closeStdin`; acknowledgements do not prove consumption | Session command input endpoint accepts text | Closed stdin only; no input delivery contract |

Primary sources, inspected September 30, 2026:

- [E2B streaming examples](https://docs.e2b.dev/commands/streaming) and [background execution](https://docs.e2b.dev/commands/background) establish the callback/background workflow. The authoritative pin is the installed npm package's `dist/index.js` and `dist/index.d.ts`: `Commands.start/connect/kill`, `CommandHandle.iterateEvents/handleEvents/disconnect`. [Published pinned tarball](https://registry.npmjs.org/e2b/-/e2b-2.51.0.tgz). The code awaits callbacks, accumulates `_stdout`/`_stderr`, sets RPC `timeoutMs`, and selects termination/connection by PID. Reconnection documentation alone does not establish safe identity after PID reuse.
- [Daytona process documentation](https://www.daytona.io/docs/en/process-code-execution/), [TypeScript reference](https://www.daytona.io/docs/en/typescript-sdk/process/), and [toolbox schema](https://www.daytona.io/docs/toolbox-openapi.json). Current documentation may evolve: the retrieved toolbox schema identifies itself as `v0.0.0-dev`, not an immutable 0.218 schema. Its session request has `command`, `runAsync`, `async`, `suppressInputEcho`, but no runtime deadline. The [published 0.218.0 tarball](https://registry.npmjs.org/@daytona/sdk/-/sdk-0.218.0.tgz) corroborates the session paths and HTTP-only timeout in `esm/Process.js`; `esm/utils/Stream.js` uses text demux with `01 01 01` / `02 02 02` markers. Binary transparency cannot be inferred from that framing. Tarball SHA-256: `403c89ad9c9e292c27b12a953229d050dd09f6635b25e089e60767318cdbf803`.

Daytona integration is deferred rather than blocked on a new universal process abstraction. A later native-boundary investigation must establish initial-log completeness, bounded WebSocket framing, session cleanup and any termination guarantee before enabling it. Modal and third-party adapters return `UNSUPPORTED` without starting anything.

## Public contract

PR #52 exports this local text-streaming surface through the SDK. See the roadmap for remaining extensions and live qualification; these signatures are no longer an unimplemented proposal.

```ts
// Reuse the existing command, cwd and env validation, not ExecInput wholesale.
type StartProcessInput = {
  command: ExecInput["command"];
  cwd?: string;
  env?: Record<string, string>;
  maxOutputBytes?: number; // cumulative UTF-8 text budget; default 1 MiB
  deadlineSeconds?: number; // required native runtime bound if supplied
};
type ProcessOutput = { stream: "stdout" | "stderr"; text: string };
type ProcessExit = {
  exitCode: number; // confirmed native exit, including nonzero
  outputComplete: boolean; // all native text delivered to the output consumer
};
interface ProcessHandle {
  readonly provider: string;
  output(options?: { signal?: AbortSignal }): AsyncIterable<ProcessOutput>;
  wait(options?: { signal?: AbortSignal }): Promise<ProcessExit>;
  detach(): Promise<void>; // local, idempotent, prompt
}
// On a direct sandbox:
// sandbox.processes.start(input, { signal? }): Promise<ProcessHandle>
```

A successful start returns a handle as soon as the native start event supplies its local handle, not when the command exits. Attach the output receiver before dispatch so early output cannot fall between start and subscription. A single consumer can call `output()` once; a second call rejects `INVALID_ARGUMENT` without changing the first consumer. `wait()` can be called repeatedly/concurrently and returns the same confirmed exitCode, with outputComplete sampled at settlement; each caller's abort only ends that caller's wait. It does not detach the output receiver or abort the native command stream.

The handle is local observation state, has no serialized `reference`, no public PID identity and no `get()`/`inspect()`/`submitStart()` API. Its provider connection owns native credentials. Do not invent a serializable generation token to make unsafe native PID selectors look safe. No public termination method is added until it can target the same execution reliably; explicit termination remains unsupported, and sandbox `destroy()` is a separate deliberate lifecycle action.

Pre-aborted start rejects `WAIT_ABORTED` before dispatch. Abort or transport loss after dispatch can mean the command started: reject `OUTCOME_UNKNOWN`, with provider and sandbox ID only where known; no automatic retry and no claim that these fields can reopen the command. If the native handle arrives after local start abandonment, disconnect it immediately. Do not orphan a local socket, kill the command, or wait indefinitely for a non-cooperative provider. No new generic error family is needed; proposed process failures use current error conventions with a typed optional confirmed `ProcessExit` where available.

`wait()` reports normal and nonzero exits without throwing merely for an exit code. This intentional observation API differs from bounded `exec()`, which keeps `NonzeroExitError`/`NoExitCodeError`. Transport loss without exit evidence rejects `UNAVAILABLE`; never synthesize exit 0, a signal, a runtime-timeout cause, or a missing exit code. Output failure rejects the iterator; it does not erase an exit already confirmed.

## Small adapter addition

Add an optional `processes` member on the public adapter session. Do not route it through the durable `Mutation`/checkpoint runtime or internal provider SPI. Use current `Command`, `Sandbox` and error conventions from `sandbar-adapter`.

```ts
type NativeProcessExit = { exitCode: number };
// Native wait rejection may preserve exit evidence without claiming full output.
type ProcessObservationFailure = AdapterError & {
  confirmedExit?: NativeProcessExit;
};
type ProcessStartContext = {
  readonly signal: AbortSignal; // setup/abandonment only
  readonly deadline: number; // local setup deadline, not remote runtime
  onOutput(chunk: { stream: "stdout" | "stderr"; text: string }): void;
};
interface NativeProcess {
  // Optional synchronous confirmed evidence during final decoder callbacks.
  readonly confirmedExit?: NativeProcessExit;
  wait(): Promise<NativeProcessExit>;
  detach(): Promise<void>;
}
// Optional session member:
// processes?: {
//   start(input: {
//     sandbox: Sandbox; command: Command; cwd?: string;
//     env?: Record<string, string>; maxOutputBytes: number;
//   }, ctx: ProcessStartContext): Promise<NativeProcess>;
// }
```

Presence advertises only this fixed text/closed-stdin/local-handle contract. Reject `deadlineSeconds` in SDK validation for this slice; do not add inactive capability dimensions for signals, cursors or stdin. Resolve unsupported methods/options before mutation. Setup uses a 30-second local deadline and client-close signal. E2B disables the native streaming RPC timeout (`timeoutMs: 0`), sets `requestTimeoutMs: 30_000`, `stdin: false`, and uses the existing `retries: 0` connection configuration. Setup abort must not remain wired to an established stream: separate its controller from the stream lifetime, retain late-handle disposal, and clear setup timers after the native start event. Streaming must use the [non-resuming E2B guest-attachment path](sandbox-lifecycle.md#reopening-and-identity): a bounded authenticated detail/token GET, verified scope and trusted routing, then local construction of the pinned SDK client and direct envd access. Require running state, `autoResume === false` and the detail token before guest access; missing/true auto-resume or missing token makes access unavailable. Do not call `Sandbox.connect` or POST connect: a running preflight cannot prevent a pause before attachment from implicitly resuming compute. Local construction alone does not disable server auto-resume; reject changed lifecycle policy rather than mutating it back. External policy changes after verification remain the documented native race.

E2B transport maps native nonzero-exit errors to the ordinary exit result. On other native wait failures, read the public `handle.exitCode`: if it is a valid confirmed integer, throw `ProcessObservationFailure` carrying `confirmedExit`; otherwise omit that field. The SDK fails the output iterator, caches the confirmed exit and returns it with incomplete output from pending/subsequent waits. Validate this optional field and never recover exit by parsing an exception message. E2B sets its result before decoder-flush callbacks, so a flush failure can coexist with confirmed exit. Native callback delivery starts before `run()` resolves: enforce the output budget in callbacks and latch a disconnect request until the returned handle is available. Attach rejection handlers to native wait immediately to avoid unhandled rejections. Lifecycle interruption or client closure ends local observation; it never reconnects to a restored/resumed generation.

## Buffering, completeness and cancellation

Defaults are intentionally fixed: cumulative output budget **1 MiB combined**, configurable integer **1–1,048,576 bytes**, measured as UTF-8 encoding length of native text; pending-consumer queue **64 KiB combined**, with at most **256 chunks**, and per emitted chunk at most **16 KiB UTF-8** (split only on code-point boundaries). Reject invalid limits before dispatch. Tiny chunks consume the chunk limit even when byte usage is low. No capture copy is kept by Sandbar beyond the pending queue and a terminal result/error.

E2B's public handle also retains decoded text internally. A drained Sandbar queue does not bound that accumulation: the cumulative budget is mandatory, even for fast consumers. On the first callback crossing either cumulative or queue limit, stop admission, latch `OUTPUT_CAPACITY`, disconnect locally immediately (or on late handle arrival), and reject output/wait promptly unless exit is already known. Do not kill compute. If overflow precedes start resolution, `start()` rejects `OUTPUT_CAPACITY` with effect possible and minimal provider/sandbox context, and disconnects the late handle without exposing a partial public handle. For an established handle, deliver the already admitted prefix, then throw; no silent dropping and no resumable gap/cursor format. An error means the remainder is unavailable through this handle.

Sandbar-owned buffers obey these bounds. Native decoding/transport can allocate an incoming message before a callback checks the limit, and already in-flight decoding/final flush can append text after disconnect; these numbers are not an RSS or provider log-storage guarantee. Fixtures must cover one oversized incoming message and show no additional Sandbar admission or native callbacks after disconnect; permit in-flight native decode/flush allocation. Do not change private E2B fields or import its internal RPC protocol to claim a stronger cap. A hard bound on provider-client allocations requires a separate raw transport or upstream bounded-capture support, outside slice 1.

Do not promise workload backpressure: callbacks are awaited by E2B, but server/socket buffering is not a verified end-to-end bound. Sandbar callbacks synchronously enqueue within the budgets; slow consumers fail locally. There is no unbounded pending promise chain. Provider-side retained logs may continue growing after detach; sandbox lifetime still applies.

On normal native stream end plus confirmed exit, output drains and ends. `outputComplete` becomes true only after all admitted chunks were yielded and the native stream finished without loss; a wait that settles earlier conservatively returns false. Results returned earlier stay historical and are not mutated; a later `wait()` may return true once drain completes. If delivery has not already completed, closing the iterator (`break` or abort), `detach()` or client close ends the subscription, discards queued text and leaves completeness false. Aborting output throws `WAIT_ABORTED` and performs local detach. Explicit `detach()` closes the iterator normally, settles unconfirmed waits with `UNAVAILABLE`, and preserves a cached confirmed exit; completeness stays true if delivery had already finished, otherwise false. Detachment cannot undo completed delivery. It never waits for remote exit. A provider that already supplied confirmed exit keeps it when later local output delivery fails.

| User intent | Operation | Guarantee |
| --- | --- | --- |
| Stop this local wait after 5 seconds | `wait({ signal: AbortSignal.timeout(5000) })` | Only that waiter stops; command/output continue |
| Stop watching output | Abort `output()` or call `detach()` | Release local observation; command may keep running |
| End command after a runtime limit | `start({ deadlineSeconds: ... })` | Unsupported here; reject before dispatch |
| Terminate command remotely | Future verified process termination API | Unsupported here; no whole-sandbox fallback |
| End sandbox lifetime | Existing provider TTL or explicit `sandbox.destroy()` | Separate lifecycle operation affecting compute |

Current bounded-exec timeout analysis and output-helper delivery are maintained in the [focused output/timeout brief](output-and-timeouts.md). It distinguishes RPC/request waiting from verified runtime enforcement and retains existing defaults. This does not change this streaming slice's rejection of `deadlineSeconds` before dispatch.

## Full decoding and bounded display

See the [selected helper API and capture/display contract](output-and-timeouts.md#selected-helper-api). Existing 16 KiB display defaults stay unchanged; full decode and structured previews are a separate additive SDK slice. The focused brief owns signatures, byte/UTF-8 behavior, examples and acceptance.

## Usage and delivery

First-slice usage (compiled against packed public packages in the coding slice):

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

This is for finite text commands whose output fits the budget. Long-running/high-volume/binary processes remain outside this first slice. A command that buffers its own stdout may not emit timely chunks; Sandbar delivers native callbacks promptly, without waiting for exit or creating a hidden shell supervisor. `argv` uses the adapter's existing quoting rules; shell requests use its declared shell. Explicitly close stdin; preserve cwd/env validation and reject NUL input before start.

The delivery slices are merged:

1. **E2B text streaming — PR #52.** Uses the non-resuming guest attachment from #38 and provides local output/wait/detach with bounded admission, explicit unsupported runtime deadlines, deterministic native fixtures and packed Node/Bun examples. The maintained live scenario remains not-run.
2. **Read cancellation — PR #51.** `readFile(path, { signal? })` and exported `ReadOptions` preserve inspection's existing `WaitOptions` compatibility. One fixed 30-second local deadline covers provider results and streamed chunks, including noncooperative reads. Late streams are disposed and local readers released without waiting indefinitely. Read-only errors use `WAIT_ABORTED`, `TIMEOUT` and `CLIENT_CLOSED` with effect `none`; native failures retain their code. Native download cancellation is best effort. The updated live file scenario has not been qualified.
3. **[Output helpers and timeout clarity](output-and-timeouts.md#delivery-and-acceptance) — PRs #53 and #54.** Full decode/structured previews, provider timeout documentation and deterministic wiring tests are implemented. Native runtime enforcement and raw binary transport remain separate proposals.

The shipped streaming scope is finite E2B text with local-only handles. Binary streaming, remote kill and reattachment need their own design and provider evidence; they are not implicit follow-ups required to finish #52.

## Acceptance for the coding slice

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

Run focused SDK/adapter/E2B tests first, then sequential shared builds and required CI gates (`check:built`, lint, format, offline tests, packed consumers, observability and docs/examples). The coding slice adds public process exports, deterministic pinned-client fixtures and compiled/packed Node/Bun examples. Live acceptance remains not-run pending separate paid-call authorization; offline results do not qualify live behavior.

PTYs, terminals, stdin, arbitrary signals, process inventory/reopening, retained replay/cursors, endpoints/tunnels, broad filesystem APIs, sandbox reopen, cleanup configuration, and generic workflows are explicit scope cuts. Use ROADMAP.md for the delivery queue; this contract does not schedule those extensions.
