# Sustained output and interactive processes

Current contract · Updated October 10, 2026 · P0–P4 implemented in #76–#79; cancellation corrections in #80

## Outcome and baseline

Applications should start a build, display progress, run a server, send repeated input to a child process, inspect whether it is still running, request termination and obtain a confirmed exit without changing application logic between Daytona and E2B. Output must remain useful beyond 1 MiB without accumulating forever in the SDK or its native client. A process is not a terminal; PTY support is a separately named extension.

Both built-ins implement sustained text and original-byte output, incremental stdin/EOF, independent status/exit, signals, explicit terminals, scoped references/reopening, and bounded diagnostic helpers. Legacy finite process output and ordinary finite `exec` retain their separate compatibility contracts. Public signatures and examples live in the [streaming guide](../apps/docs/src/content/docs/docs/guides/text-streaming.md) and [SDK exports](../packages/sdk/src/index.ts). Implementation and exact-revision live qualification are separate facts.

## Portable abstraction acceptance rule

Design the public SDK and public adapter hooks for Daytona, E2B and future providers such as Tensorlake. The initial built-ins are implementation targets, not the definition of the interface. Future provider support is a design requirement, not a claim that its native behavior has already been researched or qualified.

Application methods express intent and observable results. Adapters own native endpoints, SDK clients, sessions, transport selection, staging, helper commands and cleanup of their implementation resources. A provider needing several native calls for one SDK operation is adapter work, not a reason to make the application orchestrate those calls. Keep provider-name branching out of the portable runtime and application examples.

Options belong in the public method only when the caller has a meaningful choice about behavior. Provider configuration may expose genuine deployment prerequisites or policy choices; it must not require selecting native RPCs, session protocols or unavoidable internal steps. Resolve those mechanics automatically. Low-level adapter hooks normalize outcomes and errors without leaking native response shapes, credentials or transport tokens into ordinary application code.

Missing a native convenience endpoint does not by itself mean the SDK operation is unsupported. Implement a faithful adapter workflow where feasible. Report unsupported before effects when the required behavior truly cannot be delivered; never silently weaken a requested guarantee. Express unavoidable differences as useful facts such as unknown metadata, incomplete output or unsupported signals, rather than provider-specific control flow.

Acceptance includes the same compiled application workflow against both built-in fixtures, plus an independently authored fake adapter with different mechanics. Substituting adapter setup must not require changing method names, supplying native options, or importing a provider SDK. New adapters implementing existing behavior must not require changes to the portable runtime. Add a generic capability only when a new observable behavior genuinely needs one. Review the ordinary example before accepting the internal implementation.

## Process pipes and controls

Use the existing `box.processes.start` command union and handle methods. Begin consuming output promptly and retain its rejection independently of `wait()`. The compiled [streaming guide](../apps/docs/src/content/docs/docs/guides/text-streaming.md) owns application recipes.

| Operation | Contract |
| --- | --- |
| `stdin: 'closed' \| 'pipe'` | Closed by default. Reject unsupported pipe mode before starting a process. No implicit terminal or input echo. |
| `write(string \| Uint8Array, { signal? })` | Strings are UTF-8, bytes are exact. Resolve when the native input transport acknowledges acceptance, not when the program consumes or acts on it. Serialize accepted calls; preserve call order without unbounded buffering. |
| `closeStdin({ signal? })` | EOF after accepted prior writes. Cached acknowledgement makes repeated successful close local/idempotent. Writes after EOF reject before dispatch. Unknown close is not automatically retried. |
| `status({ signal? })` | Current observation `{ state: 'running' \| 'exited' \| 'unknown', exit?: ProcessExit, observedAt: string }`. Never fabricate running because a handle exists; preserve confirmed exit. No output transcript on every status call. |
| Sustained `output({ signal? })` | One async consumer in the selected text/byte profile, separate stdout/stderr, ordered within each stream. No cross-stream order promise and no hidden full transcript. Preserve complete-delivery reporting and early output. |
| Existing `wait({ signal? })` | Await confirmed exit independently of output consumption/failure. Nonzero exit is an ordinary process result. Abort ends only that wait. |
| Existing `terminate` | Default native termination request, followed by independently observed exit when requested by the application. Do not claim successful kill from local cancellation or request acknowledgement. |
| Existing `detach` | Idempotent local disposal, no implicit kill, resume, renewal or sandbox destruction. Close local input/output transport; document native consequences of disconnect without promising the remote process always continues. |

Input defaults: 64 KiB maximum accepted write and 256 KiB maximum outstanding input including in-flight writes, with a bounded call count. Oversized chunks/capacity fail locally before enqueue; developers can split and await writes. Snapshot byte buffers on admission so later caller mutation cannot change queued data. Zero-byte writes are no-ops after state validation, not EOF. Start/close/exit/detach races must have deterministic local ordering.

An abort before a queued input write dispatches is effect-free. After dispatch, a lost acknowledgement is unknown input delivery: preserve confirmed byte-prefix counts only if native evidence supports them. Do not retry the chunk. Mark input unusable after an uncertain write/EOF, retaining output/status/wait/termination where usable. A later successful command response does not prove exactly which input arrived. No per-chunk persisted operation history or claim of exactly-once delivery.

## Output, buffering and observation

Sustained output bounds retained memory, not total bytes emitted over a process lifetime. The local queue is bounded to 64 KiB/256 chunks, with emitted chunks at most 16 KiB. No unbounded native text accumulation, callback backlog or promise chain is acceptable. A single incoming native frame may allocate before admission; document and test the actual transport bound.

Default slow-consumer behavior is explicit output failure and local output detachment. Preserve confirmed exit and independently usable status/wait/control; if the provider loses exit observation with the stream, report that limitation rather than invent an exit. Never silently discard output, kill the process or restart it to recover observation. Async consumption supplies local backpressure; only claim guest-level backpressure if the full native path establishes it.

Preserve `outputComplete`: false until all admitted output is delivered and native end is confirmed without a gap; false after overflow, disconnect, decoding failure or truncation. Earlier result objects remain historical. Validate initial output emitted before `start` resolves, multi-byte UTF-8 across frames, separate stderr, final output after exit notification and bounded drain when the transport never closes. Native text remains text, not byte-faithful output.

Diagnostic helpers retain only bounded local windows, as specified below. Callers needing all logs must stream to their own sink; retained remote logs, offset cursors and transcript replay are not implied.

Keep start/setup deadlines, local wait cancellation, input delivery deadlines, remote runtime deadlines and sandbox lifetime distinct. Local control operations have a 30-second budget. Do not give sustained output a short total deadline or idle timeout that kills a quiet server. Retain unsupported runtime-deadline rejection until a mapped native deadline has verified termination semantics.

## Adapter transport and cleanup

Native transports and helper lifecycle belong inside adapters. Do not re-encode native text to claim original bytes or require applications to select native protocols. Current implementations use these boundaries; provider documentation and maintained qualification records own dated native evidence.

| Boundary | E2B | Daytona |
| --- | --- | --- |
| Version/endpoint | Pinned `e2b@2.51.0`; public envd Connect JSON `process.Process/Start`, with existing authenticated, running, auto-resume-off guest attachment | Existing single-attempt toolbox `/process/execute`; reference native session API lacks exact byte input, EOF and child-specific termination |
| Initial output | Consume Start RPC from its first frame, before resolving start event | Supervisor launches child with private stdout/stderr pipes before first output read; no session-log attachment gap |
| Frame/admission bounds | Connect envelope capped at 1 MiB before payload allocation; fetch can supply an already allocated incoming chunk; SDK 64 KiB/256 chunks | Python pipe reads at most 16 KiB, queue at most 64 KiB, read replies at most three frames/48 KiB raw and bounded JSON/native response |
| Retention | No native `CommandHandle`, cumulative `_stdout` or `_stderr`; only parser, decoder and SDK queue | No session log transcript; private bounded queue and OS pipes; pipe reading pauses when full |
| Input/ACK/EOF | Native exact-byte SendInput and CloseStdin, envd >=0.5.2; unary ACK means acceptance, not application consumption | Base64-framed bytes over private Unix socket; `os.write` acceptance followed by ACK; explicit pipe close provides EOF |
| Status/exit | List proves scoped tag presence; absence is unknown; EndEvent confirms exit separately from stream end | Retained child `Popen.poll()` supplies running or confirmed exit independently of output RPC |
| Termination | Native tag-selected SIGTERM/SIGKILL; tag reuse and descendant limitations remain explicit | Supervisor retains child generation and requests SIGTERM/SIGKILL under its control lock; no session delete or sandbox fallback |
| Cleanup | Output detach stops delivery while RPC continues observing exit; full detach cancels local stream; no implicit remote termination | Local detach discards output, closes stdin; supervisor removes its private directory after child exit; owned sandbox destruction cleans interrupted helpers |
| Runtime deadline | Raw Start omits a transport total timeout; no idle/60-second process deadline is added; requested runtime guarantees remain unsupported | Native request/setup limits bound RPC only; helper/child lifetime remains separate and sandbox TTL applies |

The Daytona helper footprint is: one Python 3 standard-library supervisor per process, one private mode-0700 `/tmp` directory, one mode-0600 Unix socket, ordinary child pipes and short bounded Python RPC invocations. It performs no downloads, background service installation, TCP binding, preview exposure or network-policy changes. Python 3 and writable private `/tmp` are prerequisites. A detached running child retains its supervisor until exit or owned sandbox destruction. This is adapter work, not an application orchestration requirement.

## Compatibility and deferred behavior

Explicit `output: { mode: 'stream' }` selects sustained output; legacy `maxOutputBytes` finite semantics remain distinct, and supplying both rejects. Older adapters reject unsupported profiles before starting rather than falling back or replaying. Text remains the default; original bytes require the byte profile.

`box.exec(input, { onOutput, signal })` uses one process dispatch, awaited live text callbacks and bounded original-byte capture. Input delivery and callback failure are observed concurrently. Failure preserves already confirmed exit and available capture. This does not resolve every ordinary bounded-`exec` output-retrieval failure; retain the separate [output and timeout contract](output-and-timeouts.md).

Preserve exact argv and explicit shell execution. Payloads, input and guest output stay out of telemetry. Remote runtime deadlines, transcript retention/replay, gap-free reconnect and descendant termination are not implemented guarantees. Making sustained output the default would require an explicit compatibility decision.

Abandoned Daytona setup writes a private cancellation marker before releasing its local transport. A bootstrap delayed beyond the lost HTTP acknowledgement checks that marker before launching a child. If no bootstrap arrives, the small cancellation directory remains until owned sandbox destruction; it is not a running service or a retained provider artifact.

## Qualification boundary

P0–P3 are implemented additively: sustained bounded text output and status on both built-ins, incremental exact-byte stdin/EOF, independent exit/output completion, local detach, explicit termination, and bounded original-byte exec capture with awaited text callbacks from one dispatch. Shared compiled build/worker/owned-server examples and packed Node/Bun consumers exercise an independently authored adapter. The extension contracts below are also implemented.

Independent Luna static SDK/provider reviews identified and verified fixes for final output after exit, detach/control cancellation, callback close races, malformed status and delayed Daytona setup. E2B live qualification additionally found synchronous coalesced-frame output admission; bounded 16 KiB deliveries now yield between segments, with fast/slow consumer regressions. The maintained ordinary Bun suites passed for both built-ins at `ecc73de` on October 9, 2026, with >32 MiB stdout, separate stderr, exact text/binary incremental stdin and EOF, status, termination and confirmed exit. The initial E2B failure at `37dd9c2` remains recorded. All three owned test sandboxes were destroyed and clients closed; no snapshots, volumes, builds or preview exposure were allocated. Provider support records retain exact revision/configuration and distinguish fixtures from live qualification.

## Original-byte pipe output

Select original bytes before dispatch with `output: { mode: "stream", format: "bytes" }`. The default remains text. The same single-consumer `output()` iterator yields `{ stream, bytes: Uint8Array }` for the byte profile; its public type follows the selected format. Each admitted chunk owns its bytes. Byte boundaries are arbitrary and do not imply characters, lines, records or provider frames. Invalid UTF-8 and NUL remain intact. Stdout and stderr remain separate, with no promised cross-stream ordering beyond observed delivery.

Both built-ins already transport base64-encoded native pipe bytes. E2B bypasses its incremental decoder and delivers bounded segments of decoded Connect data; Daytona bypasses its decoder for the existing supervisor's bounded base64 read batches. Neither reconstructs bytes from text or adds a guest helper. The existing bounded stream queue, local cancellation, output completion, status and input contracts apply. Adapters explicitly advertise byte output; older adapters reject that selected profile before starting a process. Exec callback output remains text.

The P4 byte slice passed the maintained live suite on both built-ins at `5f2bd13` on October 9, 2026, with 256 KiB of all byte values on stdout and exact NUL/invalid UTF-8 stderr, alongside sustained text, stdin/EOF, status and termination. Both owned sandboxes were destroyed and clients closed; peak compute was one and no snapshots, volumes, builds or preview exposure were allocated. Sanitized provider evidence records retain the clean tested revision.

## Signals, terminals, reopening and diagnostics

The portable signal vocabulary is `SIGTERM` and `SIGKILL`. `signal()` returns acknowledgement separately from `wait()` exit evidence. `terminate()` remains the SIGKILL convenience; the same handle must not repeat an uncertain SIGKILL through its alternate method. No automatic escalation, sandbox kill or descendant guarantee is added. Adapter-owned targeting remains the launched process (E2B's scoped selector, Daytona's retained child).

`box.terminals.start({ command, columns, rows, cwd?, env? })` explicitly creates a terminal with exact requested argv or shell execution. A terminal has combined original-byte output, write, resize, status, wait, signals, termination and local disposal. It omits pipe EOF; control characters are terminal input. Dimensions and pending resize work are bounded. E2B maps the public envd PTY Start/Update and `data.pty`; Daytona extends the existing private Python supervisor with a controlling PTY, a single master output stream and window-size ioctls. No extra service, package install or network listener is required.

`reference()` returns a bounded versioned JSON process reference carrying provider, verified connection scope, sandbox, profile, input/output format, expiry and opaque adapter selector. It grants no immutable-generation claim unless the adapter can verify one. References expire no later than 24 hours after creation and can become unavailable earlier when the sandbox, process or native observation expires. Save the sandbox reference separately to reconnect in a fresh application process. References snapshot current input facts; pending EOF or uncertain input delivery rejects reference creation rather than exporting a writable pipe. Reopening synchronously snapshots validated JSON before any asynchronous native dispatch. `disconnect()` parks local observation without EOF or termination, fences the old handle and enables `box.processes.reopen(reference)` or `box.terminals.reopen(reference)`. A lost park acknowledgement is uncertain and cannot re-enable old controls. Reopening never submits Start or replaces a process.

Reopened handles expose `outputGap: true` and retain `outputComplete: false`, including after a confirmed exit. They observe the newly attached live stream only; there are no retained offsets, historical transcript replay or gap-free transcript promises. Native buffers may deliver bytes emitted before attachment; no exact emission-time cutoff is claimed. Concurrent active attachment may reject unavailable. E2B references use a random Sandbar-owned tag and direct tag selectors for Connect/input/control; native tag uniqueness is not enforced against other native clients, so tags are honestly scoped selectors rather than immutable identities. Daytona validates a private supervisor generation and attachment lease for every request, rotates the lease on reopen and rejects stale readers/controls. Explicit park enables immediate reopen; a lost client's lease becomes available after 30 seconds without requests. A disconnected supervisor discards output it observes while preserving input and removes its private files after child exit; abandonment cancellation markers remain until sandbox destruction to fence delayed setup.

`readProcessLines()` independently decodes each stdout/stderr stream incrementally, handles split UTF-8 and CRLF, emits final partial lines on normal end, clips oversized lines at code points and marks them `truncated`. It discards the rest of an oversized line until its newline. Abort releases local output observation; a quiet source otherwise waits for output. `createProcessTail()` retains a rolling byte/chunk window and returns immediate independent snapshots with bounded lines and per-line bytes. Snapshots include partial lines and a truncation flag; they never fetch provider logs or imply persistent storage. A window cut can begin mid-character or mid-line, and its global truncation marker is explicit. Neither helper owns compute or terminates a process.

The remaining P4 live suite passed on both built-ins at `aaba981` on October 9, 2026. A separate OS process reopened the existing byte pipe, sent exact binary input and EOF, and observed confirmed exit with an explicit output gap. Controlling terminals reported initial dimensions, resized and exited through SIGTERM. Both owned sandboxes were destroyed and clients closed; peak compute was one, with no snapshots, volumes, builds or preview exposure. SIGKILL and fault branches retain deterministic fixture coverage. Sanitized provider records preserve exact configuration and revision.
