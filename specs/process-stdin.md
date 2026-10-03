# UTF-8 process stdin

Design proposal · October 3, 2026 · baseline `3fbeb3e` · no implementation or live stdin qualification

## Decision and scope

Add opt-in UTF-8 pipe input to the existing finite local process handle in **one E2B implementation PR**. Start with stdin closed unless `stdin: "pipe"` is explicit. Ship write and real EOF together; a writable pipe without half-close leaves ordinary filters hanging. Daytona, Modal and adapters without this extension reject the option before starting compute. No PTY, process reopening, persistence, supervisor, workflow framework, output-budget change or sustained-output prerequisite.

Current source is authoritative: `packages/sdk/src/processes.ts`, `packages/adapter/src/index.ts`, `packages/providers/e2b/src/transport.ts` and their process tests. Existing E2B streaming passed at `3188e33` in #68; that scenario started with `stdin: false` and proves no stdin behavior. Storage #69 is independent. Earlier process-spec live-status paragraphs predate that qualification.

## Public SDK surface

Export the new result types from `sandbar-sdk`; extend the existing input and handle without changing output, wait, terminate or detach results:

```ts
type StartProcessInput = {
  command: ExecInput["command"];
  cwd?: string;
  env?: Record<string, string>;
  maxOutputBytes?: number;
  deadlineSeconds?: number; // remains unsupported for processes.start
  stdin?: "closed" | "pipe"; // omitted = closed; pipe is UTF-8, never a PTY
};
type ProcessInputWrite = { status: "acknowledged"; bytes: number };
type ProcessInputClose = { status: "acknowledged" };
interface ProcessHandle {
  readonly provider: string;
  writeStdin(text: string, options?: { signal?: AbortSignal }): Promise<ProcessInputWrite>;
  closeStdin(options?: { signal?: AbortSignal }): Promise<ProcessInputClose>;
  // Existing output(), wait(), terminate(), detach() stay as shipped.
}
```

`bytes` counts the full UTF-8 payload in the acknowledged request, not guest-consumed bytes. Successful EOF acknowledges a native pipe half-close request; it does not prove that the guest has read remaining bytes, observed EOF or exited. Use guest output/protocol acknowledgements and `wait()` for those facts. No delivery receipt, byte offset, public PID or recovery reference is invented.

Input is a well-formed JavaScript Unicode string, encoded with `TextEncoder`. Reject lone surrogates instead of silently replacing them. Preserve newline, CR, NUL and other control characters literally; never add newline, shell-escape input or interpret Ctrl-D as EOF. Binary input is deferred. Require **1–65,536 UTF-8 bytes per write**, with `INVALID_ARGUMENT` for empty/oversized/non-string/ill-formed text. Validate UTF-16 length first (more than 65,536 code units cannot fit), then well-formedness and UTF-8 length; reject before retaining/encoding arbitrarily large input. Splitting larger input is the caller's job, on code-point boundaries.

## Adapter surface and E2B mapping

Use the public adapter session, not durable mutation/checkpoint APIs or the internal SPI. The optional marker lets the SDK reject unsupported pipe starts before native start. It advertises the paired write/EOF contract, not a capability-negotiation workflow for applications.

```ts
// Add to existing ProcessStartInput:
// stdin?: "closed" | "pipe";
interface NativeProcessInput {
  write(text: string, ctx: ReadContext): Promise<void>;
  close(ctx: ReadContext): Promise<void>;
}
// Add to existing NativeProcess:
// readonly stdin?: NativeProcessInput;
// Extend existing optional session.processes:
// processes?: {
//   stdin?: true; // supports the complete UTF-8 pipe contract when requested
//   start(input: ProcessStartInput, ctx: ProcessStartContext): Promise<NativeProcess>;
// };
```

The SDK validates/encodes for byte accounting; the adapter receives the unchanged validated string and E2B's public client performs its own encoding. Neither layer stores history. A pipe start must return both hooks; a missing/invalid hook is a broken adapter contract after possible start, so fail start with `OUTCOME_UNKNOWN`, release the late/local observer, retain known sandbox identity and never restart. Closed starts need no hooks. Adapter hooks resolve with `undefined` only after full native acknowledgement (any other runtime value is an invalid adapter acknowledgement) and must not retry, partially acknowledge, queue or split a write internally.

E2B retains the existing non-resuming, scoped guest attachment and `retries: 0`. After authenticated detail lookup and before `commands.run`, require a valid observed `envdVersion >= 0.5.2` for pipe mode; absent/malformed version is `UNAVAILABLE`, older version is actionable `UNSUPPORTED` (“Rebuild the E2B template with envd 0.5.2 or newer for stdin EOF”). Use a local version comparison; do not depend on the SDK's hidden `supportsStdinClose` getter. Closed starts on older versions remain available. This is a native-client compatibility threshold, not proof of every deployed image.

Start sends `background: true`, `stdin: input.stdin === "pipe"`, existing disabled RPC runtime timeout and bounded setup timeout. Returned hooks use public `handle.sendStdin(text, { signal, requestTimeoutMs })` and `handle.closeStdin({ signal, requestTimeoutMs })`, bounded by the remaining `ReadContext.deadline`. The pinned error mapper may perform a read-only health check after RPC failure; it can outlast request cancellation, so the SDK must race local abandonment independently. They capture the existing attached client/handle; no new connect, process lookup, resume, lifetime renewal or retry. The pinned handle delegates both operations to its PID selector. PID reuse can send input/EOF to a successor after an unobserved exit. Same-client fencing reduces stale local use but does not make that native selector immutable or fence external controllers.

## Ordering, bounds and repeated calls

One input mutation may be in flight per handle. A concurrent write, or close while a write is outstanding, rejects `CONFLICT`, effect `none`, with “Await the current stdin write before sending more input or EOF.” There is **no pending-write queue**. Callers await each acknowledgement; successful successive requests are dispatched in that order. This is not a claim of cross-client ordering, atomic guest reads or message framing. Identical repeated successful writes are deliberate new input and dispatch again.

A close admitted while idle synchronously seals the input lane before dispatch. Concurrent/subsequent close calls share its single cached native attempt/result; they never send another EOF. Writes while closing or after acknowledged close reject `CONFLICT`, effect `none`, explaining that stdin cannot be reopened. Close on a start with default/explicit closed stdin returns `UNSUPPORTED`, effect `none`, just like write: “Start with stdin: 'pipe' to send input and EOF.” It sends no request. Pre-aborted calls reject `WAIT_ABORTED`, effect `none`, before reserving the lane, including repeat close callers.

These fixed limits bound Sandbar admission to one <=64 KiB payload and one native input mutation request, plus existing transport encoding overhead; they are not an RSS, native pipe capacity, guest buffer or consumption guarantee. No cumulative copy or promise chain is kept. There is no new configurable input-budget API. Sequentially awaiting writes provides request-level pacing only. A guest that stops reading may stall native input; the **30-second fixed local deadline** stops waiting with uncertainty. Native/server buffering and whether cancellation interrupts a blocked pipe write remain unqualified. Use smaller chunks and an application protocol when guest consumption matters; use files for bulk finite payloads. Output must be consumed concurrently to avoid guest pipe deadlocks and existing output queue overflow.

## Cancellation, uncertainty and lifecycle

The SDK checks caller signal, client state, confirmed exit and the existing same-client process-control fence immediately before invoking a hook. A local failure before hook dispatch has effect `none`; no implicit termination or EOF. Once a write/close hook is invoked, abort, deadline, client closure, detach, lifecycle fencing, transport failure or malformed acknowledgement can leave some/all input applied. Reject `OUTCOME_UNKNOWN`, effect `possible`, with provider/sandbox context and “Input may have been applied; this handle will not replay or accept more stdin.” The acknowledged-prefix size is unknown; do not report zero bytes or all bytes as confirmed.

A dispatched write passes a composed per-request abort signal to the adapter. Stop local waiting promptly even if the adapter ignores it; attach handlers for late completion/rejection and release the payload reference when the underlying request settles. An uncertain write permanently disables further write/EOF dispatch on that handle. It must not reopen the lane on late success: callers may already have acted on uncertainty, and a native request could remain active. Output/wait and deliberate termination remain usable under their existing rules. A repeated write then fails `UNAVAILABLE`, effect `none`, with the same no-replay guidance. An uncertain EOF attempt remains cached; repeat close rejects with its original `OUTCOME_UNKNOWN` and dispatches nothing. No timeout clears the busy lane for another request.

Close callers cancel only their own waits on the shared EOF attempt, following terminate's existing shared-request model. After its first dispatch, a caller abort reports `OUTCOME_UNKNOWN` for that caller without aborting the shared request or poisoning an otherwise successful close. The request has its own 30-second/client/local-authority bound. Other callers can receive its actual acknowledgement. A pre-dispatch close abort creates no cached attempt. A late response after the shared request itself was abandoned does not change its cached uncertain result.

Confirmed exit rejects new writes and first-time close with `UNAVAILABLE`, effect `none`, instructing the caller to use `wait()`; do not fabricate an EOF acknowledgement or treat native not-found as this handle's confirmed exit. Already acknowledged/cached EOF remains historical and can be returned after exit/detach/client close/fencing (subject to pre-aborted caller validation). Dispatched write acknowledgement arriving before local abandonment can remain a historical success even if exit/fencing follows; it still says nothing about guest consumption. Exit before dispatch wins; an unobserved exit during native dispatch remains the documented race.

Detach, output break/abort/overflow, observation failure, client close and same-client lifecycle invalidation revoke input authority and promptly abort/abandon pending input requests. They perform local cleanup only, never send EOF, kill, resume or target a replacement. SDK suspend/resume/snapshot/destroy fencing uses the same alias-aware authority already used by terminate, before lifecycle dispatch even if that action later fails. Today that token is only an `active` boolean; the coding slice adds one abort signal to that same token so pending input sees invalidation promptly, rather than introducing a registry or poller. `wait()` cancellation alone does not revoke input. Preserve independently confirmed exit and existing output completeness rules. Reopening a sandbox/resuming compute never reopens this input handle.

The adapter must check an already-aborted request before calling native IO. The SDK still conservatively treats any hook rejection as uncertain: this small hook has no typed dispatch-evidence envelope. Do not infer no-effect from error wording/status, native `NOT_FOUND`, a health-check failure or a timeout. No new public error family or durable ledger is needed. Input contents and payload-derived messages are excluded from tracing/diagnostics; use fixed safe messages.

## Native evidence and open boundaries

Inspected October 3, 2026, without guest or paid calls:

| Provider | Actual source/docs evidence                                                                                                                                                                                                                                                                                 | Decision / unknowns                                                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2B      | Runtime pin `e2b@2.51.0`: `dist/index.js` `Commands.start`, `sendStdin`, `closeStdin`, and `CommandHandle` forwarding. `stdin` defaults false; string writes become UTF-8 bytes in unary `SendInput`, both operations select PID and await void RPC acknowledgement. `ENVD_ENVD_CLOSE = "0.5.2"` gates EOF. | Suitable for paired pipe write/EOF with template-version preflight. No retry/guest-consumption/partial-byte guarantee. Deployed EOF, blocked-write cancellation, repeat server EOF and PID lifetime behavior have not been live-qualified. Repeat EOF is handled locally.    |
| Daytona  | Sandbar uses v0.218 REST/toolbox with no `session.processes` implementation. Inspected published `@daytona/sdk@0.218.0` `esm/Process.js`: `sendSessionCommandInput` awaits `sendInput(sessionId, commandId, { data })`. Current official reference and interactive examples describe string session input.  | Native input exists; Sandbar support does not. No verified non-PTY half-close path in the inspected SDK; empty input/Ctrl-D/session deletion are not EOF substitutes. Session streaming/cleanup and pipe semantics would require their own evidence. Defer Daytona entirely. |

Evidence: [pinned E2B package](https://registry.npmjs.org/e2b/-/e2b-2.51.0.tgz), [E2B SendInput](https://docs.e2b.dev/api-reference/process/sendinput), [E2B CloseStdin](https://docs.e2b.dev/api-reference/process/closestdin), [E2B documentation index](https://docs.e2b.dev/llms.txt), [Daytona TypeScript Process reference](https://www.daytona.io/docs/en/typescript-sdk/process/), [Daytona interactive command guide](https://www.daytona.io/docs/en/process-code-execution/#execute-interactive-commands), [published Daytona inspection pin](https://registry.npmjs.org/@daytona/sdk/-/sdk-0.218.0.tgz). Current E2B docs index advertises JS SDK 2.52.0 and Daytona docs v0.220; neither silently upgrades these inspection/runtime pins. The Daytona SDK is inspection evidence only, not Sandbar's dependency.

The official E2B EOF endpoint explicitly describes non-PTY EOF; the unary write docs do not establish consumption, bounded buffering or partial-write receipts. [StreamInput](https://docs.e2b.dev/api-reference/process/streaminput) documents ordering within a client input stream, but the pinned public write API uses unary `SendInput`. Do not borrow that stronger guarantee or introduce raw RPC transport in this slice. Sequential unary dispatch is the selected practical contract; guest-observed concatenation belongs in finite qualification.

## Proposed usage (compile and execute in the implementation PR)

For an existing E2B `box` whose image contains Python, count UTF-8 bytes with a filter that exits only after EOF:

```ts
const job = await box.processes.start({
  command: {
    kind: "argv",
    argv: ["python3", "-c", "import sys; print(len(sys.stdin.buffer.read()), flush=True)"],
  },
  stdin: "pipe",
  maxOutputBytes: 4096,
});
const output = (async () => {
  for await (const chunk of job.output()) console.log(chunk.stream, chunk.text);
})();
void output.catch(() => undefined); // observe immediately; await original below
try {
  console.log(await job.writeStdin("hello\n")); // acknowledged, bytes: 6
  console.log(await job.writeStdin("🌊\n")); // acknowledged, bytes: 5
  await job.closeStdin(); // real EOF; Python prints 11
  await output;
  console.log(await job.wait()); // independently confirmed exit
} finally {
  await job.detach(); // local cleanup, not EOF or remote termination
}
```

For a line-oriented job, `await job.writeStdin(JSON.stringify(request) + "\n")` sends one line; its acknowledgement is not the response. Read the guest's response before sending the next logical request when the protocol requires it. Do not blindly retry after `OUTCOME_UNKNOWN`; inspect application evidence or deliberately end the owned sandbox. This proposal does not make those jobs indefinite or remove output caps. Sandbox lifetime and explicit owned cleanup remain the caller's responsibility.

## Delivery and acceptance

One implementation PR includes public types, SDK admission/state handling, E2B hooks/version preflight, fake/custom-adapter fixtures, provider docs and compiled packed examples. Do not split write from EOF. A second native compatibility fix is warranted only if fixtures reveal a material pinned-client limitation; stop and amend this brief rather than growing a process platform. Daytona is no prerequisite or implicit next slice.

Finite offline plan (no new harness):

- Extend `packages/sdk/src/processes.test.ts`: omitted/closed/pipe validation; Unicode, multibyte byte counts, literal newline/NUL/Ctrl-D, lone-surrogate/empty/oversized rejection; unsupported provider/option sends zero starts; missing paired adapter hooks after start disposes observation without replay.
- Hold native requests to prove one <=64 KiB admission, no queued promises, concurrent write/close `CONFLICT`, two awaited writes in dispatch order, identical writes dispatch twice, single cached EOF, repeated EOF after exit/detach, writes after EOF rejected. Validate no-effect pre-abort and authority recheck immediately before dispatch.
- Deterministic signals/deadlines/noncooperative hooks: before dispatch zero IO; after dispatch uncertain write seals lane, late success cannot replay/reopen; EOF caller abort leaves shared request intact; shared deadline/closure/fencing caches uncertainty. No unhandled late rejection or indefinite local waits. Preserve output/exit after input failure and output-cap failure revokes input.
- Extend `packages/providers/e2b/src/processes-native.test.ts` using the **actual pinned client** and fake authenticated HTTP: Start stdin true/false, envd 0.5.1 rejected before Start, 0.5.2 accepted, absent/malformed version unavailable; exact base64 UTF-8 SendInput payload and captured PID; one CloseStdin selector; acknowledged/lost/rejected responses; no Connect/Resume/renew/kill/mutation retry or invented exit; tolerate and assert only the pinned read-only health check on failure. Include envd-version regression without weakening old closed-stdin fixtures (which use 0.5.0), simulated PID reuse and pause/auto-resume boundaries.
- Adapter/custom consumers compile with the additive marker and paired hooks; closed-only adapters remain valid. Packed Node/Bun consumers execute finite Unicode input/EOF against deterministic fixtures through only public exports, checking concurrent output and ordinary exit. Docs recipe must compile; generated support evidence distinguishes implementation/native fixture/packed/live and does not promote #68 streaming to a stdin pass.

For the future coding PR use Bun 1.3.14 and frozen install, focused tests first, then required sequential package builds and CI gates: check, lint, focused format check, offline suites, packed smoke/observability and docs/examples. This design PR runs only file-level formatting/link/diff inspection; no install, builds or paid calls are required or run.

Future live workflow requires separate explicit authorization: one run-owned E2B sandbox on a borrowed compatible template (record template/build/envd), <=120-second TTL, <=60-second workflow wall budget, <=3 finite guest commands, <=16 KiB total UTF-8 input, <=4 KiB output per command, no volumes/snapshots/builds/public services. Use one Python byte-count/hash filter with two sequential Unicode writes and EOF, one flushed line-response exchange before EOF, and one read-blocked child to observe local cancellation conservatively. Each native start has no runtime-deadline claim; the sandbox TTL and runner budget bound resources. Record acknowledgements separately from guest receipts, exact observed concatenation/hash and confirmed exit, repeat EOF without another request, default closed stdin, cleanup and any uncertainty. Stop on unexpected behavior; never replay uncertain input or create replacement compute. Always destroy the run-owned sandbox in runner cleanup and confirm cleanup independently; failed/unconfirmed cleanup is recorded, not hidden. Do not live-probe PID reuse or flood pipe buffers merely to fill coverage.

Coordinator integration only: link this proposal from ROADMAP.md and specs/README.md; update the two older process briefs' stale qualification/storage-status prose against #68/#69 and narrow their stdin scope cut to this proposal. Those shared files are intentionally untouched. The separate sustained-output brief owns retention/completeness research.
