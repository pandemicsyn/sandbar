# Sustained output and interactive processes

Proposed delivery plan · October 8, 2026 · Baseline `af316b2`; no runtime implementation in this change

## Outcome and baseline

Applications should start a build, display progress, run a server, send repeated input to a child process, inspect whether it is still running, request termination and obtain a confirmed exit without changing application logic between Daytona and E2B. Output must remain useful beyond 1 MiB without accumulating forever in the SDK or its native client. A process is not a terminal; PTY support is a separately named extension.

The minimum target is sustained separate stdout/stderr text, incremental byte/text stdin with EOF, read-only status, wait, local detach, explicit remote termination, and a compiled server/preview workflow on both built-ins. A provider-specific slice can merge, but does not complete this target. Existing finite `exec`, [finite stdin](process-stdin.md), [local streaming](interactive-execution-and-access.md), [termination](preview-and-process-control.md) and [output/error semantics](output-and-timeouts.md) remain valid until an explicit migration implements this proposal.

Today E2B streams through a local handle with a cumulative 1 MiB cap because its pinned native client retains output. Daytona has no public process-stream mapping. Process stdin is closed, handles cannot reopen, and termination is E2B-only with documented PID races. These are implementation gaps to address, not desired permanent ergonomics.

## Portable abstraction acceptance rule

Design the public SDK and public adapter hooks for Daytona, E2B and future providers such as Tensorlake. The initial built-ins are implementation targets, not the definition of the interface. Future provider support is a design requirement, not a claim that its native behavior has already been researched or qualified.

Application methods express intent and observable results. Adapters own native endpoints, SDK clients, sessions, transport selection, staging, helper commands and cleanup of their implementation resources. A provider needing several native calls for one SDK operation is adapter work, not a reason to make the application orchestrate those calls. Keep provider-name branching out of the portable runtime and application examples.

Options belong in the public method only when the caller has a meaningful choice about behavior. Provider configuration may expose genuine deployment prerequisites or policy choices; it must not require selecting native RPCs, session protocols or unavoidable internal steps. Resolve those mechanics automatically. Low-level adapter hooks normalize outcomes and errors without leaking native response shapes, credentials or transport tokens into ordinary application code.

Missing a native convenience endpoint does not by itself mean the SDK operation is unsupported. Implement a faithful adapter workflow where feasible. Report unsupported before effects when the required behavior truly cannot be delivered; never silently weaken a requested guarantee. Express unavoidable differences as useful facts such as unknown metadata, incomplete output or unsupported signals, rather than provider-specific control flow.

Acceptance includes the same compiled application workflow against both built-in fixtures, plus an independently authored fake adapter with different mechanics. Substituting adapter setup must not require changing method names, supplying native options, or importing a provider SDK. New adapters implementing existing behavior must not require changes to the portable runtime. Add a generic capability only when a new observable behavior genuinely needs one. Review the ordinary example before accepting the internal implementation.

## Target application API

Reuse `box.processes.start`, the command union, `output`, `wait`, `terminate` and `detach`; do not add a competing `runCommand` or process framework. The following additions are proposed, not exported:

```ts
const child = await box.processes.start({
  command: { kind: 'argv', argv: ['python', '-u', '/workspace/worker.py'] },
  stdin: 'pipe', // omitted: closed; same as finite exec without supplied input
  output: { mode: 'stream' }, // sustained text; see compatibility below
});

// Begin consuming promptly and retain the promise, including its rejection.
const output = (async () => {
  for await (const chunk of child.output()) {
    await render(chunk.stream, chunk.text);
  }
})();
const completion = Promise.allSettled([output, child.wait()]);
try {
  await child.write('first request\n');
  await child.write(new TextEncoder().encode('second request\n'));
  await child.closeStdin();
  console.log(await child.status());
  // Await and handle output and exit independently; one can fail while the other succeeds.
  console.log(await completion);
} finally {
  await child.detach(); // local cleanup; use terminate()/sandbox destroy for remote cleanup
}
```

| Addition | Proposed contract |
| --- | --- |
| `stdin: 'closed' \| 'pipe'` | Closed by default. Reject unsupported pipe mode before starting a process. No implicit terminal or input echo. |
| `write(string \| Uint8Array, { signal? })` | Strings are UTF-8, bytes are exact. Resolve when the native input transport acknowledges acceptance, not when the program consumes or acts on it. Serialize accepted calls; preserve call order without unbounded buffering. |
| `closeStdin({ signal? })` | EOF after accepted prior writes. Cached acknowledgement makes repeated successful close local/idempotent. Writes after EOF reject before dispatch. Unknown close is not automatically retried. |
| `status({ signal? })` | Current observation `{ state: 'running' \| 'exited' \| 'unknown', exit?: ProcessExit, observedAt: string }`. Never fabricate running because a handle exists; preserve confirmed exit. No output transcript on every status call. |
| Sustained `output({ signal? })` | One async text consumer, separate stdout/stderr, ordered within each stream. No cross-stream order promise and no hidden full transcript. Preserve complete-delivery reporting and early output. |
| Existing `wait({ signal? })` | Await confirmed exit independently of output consumption/failure. Nonzero exit is an ordinary process result. Abort ends only that wait. |
| Existing `terminate` | Default native termination request, followed by independently observed exit when requested by the application. Do not claim successful kill from local cancellation or request acknowledgement. |
| Existing `detach` | Idempotent local disposal, no implicit kill, resume, renewal or sandbox destruction. Close local input/output transport; document native consequences of disconnect without promising the remote process always continues. |

Input defaults: proposed 64 KiB maximum accepted write and 256 KiB maximum outstanding input including in-flight writes, with a bounded call count. Oversized chunks/capacity fail locally before enqueue; developers can split and await writes. Snapshot byte buffers on admission so later caller mutation cannot change queued data. Zero-byte writes are no-ops after state validation, not EOF. Start/close/exit/detach races must have deterministic local ordering.

An abort before a queued input write dispatches is effect-free. After dispatch, a lost acknowledgement is unknown input delivery: preserve confirmed byte-prefix counts only if native evidence supports them. Do not retry the chunk. Mark input unusable after an uncertain write/EOF, retaining output/status/wait/termination where usable. A later successful command response does not prove exactly which input arrived. No per-chunk persisted operation history or claim of exactly-once delivery.

## Output, buffering and observation

Sustained output bounds retained memory, not total bytes emitted over a process lifetime. Retain the current 64 KiB/256-chunk local queue and 16 KiB emitted text chunks as the initial proposal; the transport investigation can adjust measured limits with rationale. No unbounded native text accumulation, callback backlog or promise chain is acceptable. A single incoming native frame may allocate before admission; document and test the actual transport bound.

Default slow-consumer behavior is explicit output failure and local output detachment. Preserve confirmed exit and independently usable status/wait/control; if the provider loses exit observation with the stream, report that limitation rather than invent an exit. Never silently discard output, kill the process or restart it to recover observation. Async consumption supplies local backpressure; only claim guest-level backpressure if the full native path establishes it.

Preserve `outputComplete`: false until all admitted output is delivered and native end is confirmed without a gap; false after overflow, disconnect, decoding failure or truncation. Earlier result objects remain historical. Validate initial output emitted before `start` resolves, multi-byte UTF-8 across frames, separate stderr, final output after exit notification and bounded drain when the transport never closes. Native text remains text, not byte-faithful output.

An optional bounded tail is useful for diagnostics, but is not required to stream: design `tail({ maxBytes })` separately with explicit `shortened`/gap facts and no full-history promise. A caller needing all logs should stream to its own sink. Durable remote log retention, offset cursors and replay are separate products of native support, not implied by a local ring buffer.

Keep start/setup deadlines, local wait cancellation, input delivery deadlines, remote runtime deadlines and sandbox lifetime distinct. Use the existing 30-second local control-operation budget initially. Do not give sustained output a short total deadline or idle timeout that kills a quiet server. Retain unsupported runtime-deadline rejection until a mapped native deadline has verified termination semantics.

## Provider feasibility and transport decision

P0 must produce a small decision table for E2B and Daytona: exact supported version/endpoint, initial-log delivery, frame bounds, native retention, stdin encoding/ACK/EOF, status/exit evidence, termination selector and cleanup. The decision is attached to this spec, not another parallel plan. Check installed dependencies and upstream primary sources; modern docs may describe behavior our pin does not implement.

- [E2B streaming](https://docs.e2b.dev/commands/streaming) documents callbacks. [Background commands](https://docs.e2b.dev/commands/background), checked October 8, additionally discusses reconnect, input/output lifetime and timeout behavior. Its current timeout explanation differs from the older pinned-transport assessment in our timeout spec: verify the exact installed transport before changing any runtime guarantee. Documentation of PID reconnection does not establish immutable identity or historical log replay.
- [Daytona process docs](https://www.daytona.io/docs/en/process-code-execution/) are the starting point for sessions, async command output and input. Verify command/session cleanup and lossless initial-log attachment against the actual transport; do not infer safe per-command termination from session deletion.

Preferred order: supported bounded native client; isolated public lower-level transport; narrowly scoped adapter helper only if those cannot deliver the required workflow. An upstream dependency upgrade can be the whole prerequisite PR. Do not patch private client buffers. Native text-only input cannot satisfy byte input by UTF-8 replacement; choose a byte-capable boundary or reject byte requests explicitly before sending.

If a guest helper is necessary, propose its precise footprint, interpreter/binary requirements, startup effects, identity, authentication, bounded logs and removal behavior before implementation. No silent downloads, persistent background service installation, preview-port exposure or network-policy changes. Concentrate meaningful helper choices in adapter setup. A universal daemon, scheduler or durable workflow engine is not a prerequisite.

Ordinary provider differences must be handled by the adapter. Optional method absence alone is insufficient for output mode/input choices: add only the capability fields the delivered features need, validate before start and explain unsupported combinations. Avoid a speculative feature schema for all future process operations.

## Compatibility and improvements

- Introduce explicit `output: { mode: 'stream' }` for sustained operation while retaining legacy `maxOutputBytes` finite semantics. Supplying both is invalid. After both built-ins qualify, consider making sustained streaming the default in a coordinated documented API release; do not silently change old limits or third-party adapter behavior in the initial slice.
- Missing new adapter hooks rejects only the new feature. Preserve finite streaming, exec and other operations on older adapters. Binary output is a separate future profile; no text re-encoding masquerading as original bytes.
- Add an ergonomic bounded `exec` callback option after the transport is sound: proposed `box.exec(input, { onOutput, signal })` delivers live chunks and retains the normal bounded `ExecOutput`. It requires actual streaming support and must not rerun the command through another path if attachment fails. Await callback work within bounds; callback failure reports local observation failure with any confirmed result intact. The implementation brief must settle dispatch ownership before merging this convenience.
- Preserve argv execution and explicit shell mode. Keep payloads, stdin and guest output out of telemetry by default; use one process span plus bounded lifecycle diagnostics, not a span per chunk.
- Improve bounded exec's handling of confirmed exit plus failed output retrieval in a separate narrow PR. Preserve confirmed exit and mark output incomplete instead of erasing success evidence; retain uncertainty when native exit itself is unconfirmed. Do not tie this fix to a new result framework.

## Useful extensions after the baseline

| Extension | Required additional contract |
| --- | --- |
| Graceful termination/signals | Named supported signals, target scope, acknowledgement versus exit and optional explicit escalation; no implicit sandbox kill. |
| Reopen/status after application restart | Provider/sandbox plus a verified native process generation or honestly scoped selector, expiry and PID-reuse behavior; no replay on unknown identity. Reopening logs separately requires retained offsets/gap detection. |
| Byte-faithful output | Native byte framing, split-frame handling and flow control; separate from text and from a PTY. |
| PTY | Explicit terminal creation, combined terminal stream, resize, dimensions and cleanup. Do not reinterpret ordinary pipe stdin/output as terminal semantics. |
| Bounded tail and line helpers | Byte/chunk/line limits, split decoding, truncation markers and quiet/oversized-line behavior. Useful diagnostic helpers, not persistent log storage. |

These extensions are planned opportunities, not prerequisites for the initial end-to-end server/build/input workflows. Persistence/reconnection deserves a later focused slice because serverless callers benefit from it; do not fabricate safe identity to ship it early.

## Delivery slices and acceptance

1. **P0 — Transport decision and smallest prerequisite.** Verify the matrix above with installed source and deterministic probes; choose the bounded transport for each provider. Amend this spec with exact decisions, including any dependency upgrade and changed timeout evidence. No paid experiments required to draft the choice; unknown deployed behavior is explicitly queued for qualification. This is ready for research delegation, not an instruction to build all process features.
2. **P1 — Sustained output and status.** Shared additive contract plus E2B mapping, followed by Daytona mapping in a separate PR if needed. Preserve wait/exit through output failure where evidence permits. Prove bounded retention after at least 32 MiB of generated output, early/stderr/final output delivery, Unicode boundaries, fast and slow consumers, socket loss, client close and quiet processes. Keep input closed in this slice.
3. **P2 — Incremental stdin and EOF.** Add write/close to the existing handle and implement both mappings. Test exact binary bytes including NUL, ordered concurrent calls, queue rejection, awaitable progress, EOF, write-after-exit, input/output concurrency, uncertain ACK, aborted queued/in-flight writes, late handles and disposal. Qualify actual native input receipt separately from program consumption.
4. **P3 — Everyday process workflows.** Complete Daytona termination where native evidence supports its target; add bounded-exec callback convenience and the compiled build/server/interactive-worker examples as separate small PRs. Define statuses and errors without synthetic exit codes. The server recipe shows output, preview access, readiness probing, explicit termination, wait and owned sandbox cleanup, with bounded readiness time and no implicit public exposure.
5. **P4 — Selected extensions.** Scope signals, reconnection, binary output or PTY individually once baseline usability is demonstrated. Do not bundle them into a process-platform rewrite.

F1 from the [filesystem plan](filesystem-dx.md) can proceed alongside P0; large-file streaming and process streaming may reuse small cancellation utilities but must not block on a shared IO framework. Finite exec input qualification can proceed independently.

Reuse Bun integration suites, native-boundary fixtures, packed Node/Bun consumers and compiled documentation examples. Add separately authorized bounded live workflows on Daytona/E2B covering output beyond the old cap, incremental input/EOF, status, termination and cleanup. Record exact configuration/revision and unsupported or unqualified features honestly. No new custom live harness. Independent correctness and DX reviews must be clear before opening implementation PRs; the user manages final review/merge. Paid resources require their own explicit authorization.
