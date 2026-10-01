# Output helpers and bounded-exec timeout clarity

Implementation contract · Updated October 1, 2026 · SDK helpers merged in PR #53; timeout documentation and offline fixtures merged in PR #54

Audited freshly fetched main `28acc98413022db9933bb9085a9a50747e512952`. This extracts delivery slice 3 from the [execution brief](interactive-execution-and-access.md#usage-and-delivery). Streaming and read cancellation remain independently owned there. The streaming slice still rejects `deadlineSeconds` before dispatch; this audit does not relax that contract. Follow the [ordinary results/error direction](sdk-recovery-dx.md), without expanding recovery machinery.

## Captured bytes and display today

The public [SDK implementation](../packages/sdk/src/resource.ts) returns `ExecOutput` with byte arrays, `exitCode`, `truncated`, and `stdoutText(maxBytes?)` / `stderrText(maxBytes?)`. Exported `outputText(bytes, maxBytes?)` implements both methods. Each defaults to **16,384 input bytes**, decodes that prefix with `new TextDecoder()`, and appends `…` when provided bytes exceed the prefix. Numeric limits are safe integers **0–1,048,576**; invalid limits throw `RangeError`. An intact 20 KiB stdout can therefore display an ellipsis while `truncated === false`.

`exec` capture defaults to **1,048,576 bytes combined**, accepting integers **0–1,048,576** (subject to the adapter's advertised maximum). `deadlineSeconds` defaults to **300**, accepting integers **1–3,600**. Invalid exec input uses existing `INVALID_ARGUMENT`; unsupported adapter limits use `UNSUPPORTED` before submission. These defaults and validation stay unchanged.

The [adapter collector](../packages/adapter/src/runtime.ts) preserves stdout first and allocates the remainder to stderr; this is not a chronological merge or an equal per-stream budget. Its collectors may temporarily hold separately bounded streams. `truncated` combines provider loss with collector loss or unproven EOF: a byte array exactly at the bound can be complete, but a stream reaching the bound is cancelled without waiting to prove EOF and is marked truncated. A zero-byte stream budget likewise leaves EOF unproven. `false` means no capture loss was reported or detected, not proof that the application produced all intended output, UTF-8 was valid, or a downstream display was complete.

| Built-in | Capture boundary at audited revision |
| --- | --- |
| E2B | [Wrapper/status and file reads](../packages/providers/e2b/src/index.ts) redirect raw stdout/stderr to private files, then read stdout up to the bound and stderr with the remainder. Read probes detect extra bytes. The bound limits returned capture, **not remote file growth**. |
| Daytona | [Capture wrapper/frame parser](../packages/providers/daytona/src/index.ts) keep at most bound+1 bytes per stream and drain the rest; frame counts detect loss. Returned output uses stdout then stderr remainder. |
| Modal | [Router wire collector](../packages/providers/modal/src/router-wire.ts) bounds collection, then trims stderr to the stdout remainder and carries loss flags. |
| Fake | [Fixture engine](../packages/providers/fake/src/engine.ts) selects stdout prefix then stderr remainder. This qualifies SDK behavior, not native deadlines. |

A display helper operates on captured bytes only. It neither reads more output nor contacts a provider. Capture truncation and display shortening are independent. No per-stream capture-loss flags, combined text helper, or streaming fidelity changes are added here.

## Selected helper API

PR #53 retains the existing no-argument and numeric signatures/defaults and exports these overloads/methods through `sandbar-sdk`:

```ts
export type OutputPreview = { text: string; shortened: boolean };

// Existing exported helper, with one new overload:
export function outputText(bytes: Uint8Array, maxBytes?: number): string;
export function outputText(bytes: Uint8Array, options: { full: true }): string;

// ExecOutput methods:
stdoutText(maxBytes?: number): string;
stdoutText(options: { full: true }): string;
stderrText(maxBytes?: number): string;
stderrText(options: { full: true }): string;
stdoutPreview(options?: { maxBytes?: number }): OutputPreview;
stderrPreview(options?: { maxBytes?: number }): OutputPreview;
```

`{ full: true }` decodes **all provided/captured bytes** with no synthetic suffix, still using `new TextDecoder()`. It does not require a numeric display bound or recover missing capture. The standalone full overload can decode any supplied `Uint8Array`; the exec capture cap is not an arbitrary decoder-input cap. Full decode allocates a string proportional to input size.

Preview defaults to 16,384 bytes, accepts the same numeric range including zero, and returns the exact text of the existing bounded helper, including `…` when shortened. `shortened = bytes.length > maxBytes` concerns this stream only and never incorporates `result.truncated`. For empty input it returns `{ text: "", shortened: false }`; nonempty input with zero returns `{ text: "…", shortened: true }`. Exact-bound input has no suffix and `shortened: false`, regardless of capture loss. Stdout/stderr use identical independent display rules.

All decoding is UTF-8 with replacement, not fatal decoding: invalid sequences and an incomplete multibyte sequence at a preview byte boundary produce U+FFFD. Full decode also replaces an incomplete captured suffix, including one caused by capture loss. The standard decoder consumes an initial UTF-8 BOM. Limits count input bytes, not characters or encoded bytes of the resulting string; replacement and the suffix can make rendered UTF-8 longer than the input limit. Do not change to code-point-aligned clipping in this compatibility slice. For strict parsing, callers can use `new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)`.

Only `{ full: true }` is accepted for the new full mode. Reject `full: false`, mixed `{ full: true, maxBytes: ... }`, unknown fields, null, and malformed option objects with `RangeError`; preview objects allow only optional `maxBytes`, using existing limit validation. Typed callers are constrained by the overloads; JavaScript input must also be validated. Omitted/undefined options keep defaults. No new SDK error class or provider mutation is involved.

Why this surface: the full overload extends the three existing decoding entrypoints consistently, avoiding a second family of `*FullText` names. Structured previews solve the separate need to detect display loss without inspecting a literal ellipsis. Keep the two convenient result methods; do not also export a standalone `outputPreview` without an actual use case. Existing text methods remain supported bounded-display conveniences, with no formal deprecation or default migration.

This is additive for ordinary consumers. It changes the structural `ExecOutput` type: code manually constructing it must implement the two new methods (including custom fixtures). Adapter authors continue returning `ExecValue` byte arrays, so their public contract does not change. Extend the central result constructor so recovered outputs and `NonzeroExitError.result` / `NoExitCodeError.result` receive the same methods. Existing functions accepting `ExecOutput` continue to work; preserve assignability of its old numeric methods.

### Before and after

Today, display shortening requires comparing lengths, and full parsing requires a decoder:

```ts
const result = await box.exec(["cat", "/home/user/report.json"]);
console.log(result.stdoutText()); // 16 KiB display, may append …
if (result.truncated) throw new Error("Captured report may be incomplete");
const report = JSON.parse(new TextDecoder().decode(result.stdout));
```

With the helper slice:

```ts
const result = await box.exec(["cat", "/home/user/report.json"]);
const preview = result.stdoutPreview({ maxBytes: 4096 });
console.log(preview.text);
if (preview.shortened) console.log("Display shortened; captured bytes remain available");
if (result.truncated) throw new Error("Captured report may be incomplete");
const report = JSON.parse(result.stdoutText({ full: true }));
const diagnostic = result.stderrPreview();
console.error(diagnostic.text);
```

`truncated === false` is necessary for this capture-completeness guard but does not establish valid JSON or UTF-8. Parsing may still fail normally. Never parse the bounded display string: even raising its bound cannot recover discarded capture. A genuine ellipsis in command output is not evidence of shortening.

## Four distinct timeout boundaries

| Boundary | Meaning in this SDK |
| --- | --- |
| Caller waiting | `exec(input, { signal })`, `submitExec` and operation `wait({ signal })` stop local waiting. After submission, `WAIT_ABORTED` carries effect possible and the existing reference. This does not kill compute. `exec` waits through submission and polling; there is **no automatic total wall-clock timer** derived from `deadlineSeconds`. |
| Request/RPC | Provider client/HTTP observation limits. Includes preflight/setup/read latency and can fail without exit evidence. An exception is not a termination receipt. |
| Remote execution | Daytona exposes a documented server execution timeout; Modal sends a native process timeout with a documented runtime bound. E2B's audited mapping has an RPC timeout, without established runtime enforcement. No portable process-tree termination promise follows. |
| Sandbox expiry | E2B and Modal `timeoutSeconds` (each default 300) and Daytona `ttlMinutes` (default 60) configure separate sandbox lifetime. Expiry may interrupt execution/output; command deadline does not configure or extend sandbox expiry. |

For a caller wall-clock budget today, provide a signal explicitly:

```ts
const result = await box.exec(
  { command: { kind: "argv", argv: ["node", "job.js"] }, deadlineSeconds: 10 },
  { signal: AbortSignal.timeout(15_000) },
);
```

The 15-second signal stops local waiting; it makes no remote termination guarantee. `deadlineSeconds: 10` retains provider-specific behavior below. The ordinary recovery API can observe a saved execution reference without replay; it is not a process handle, guaranteed output retention, or command termination API.

### E2B: exact pinned source versus descriptive docs

Sandbar pins **`e2b@2.51.0`** in [package.json](../packages/providers/e2b/package.json) and `bun.lock`; control-plane retries are disabled. [Transport `run`](../packages/providers/e2b/src/transport.ts) first uses the merged non-resuming guest attachment: a bounded authenticated detail GET, checks for running state, `autoResume === false`, token/version and trusted domain, and local `new Sandbox` construction. It then passes `deadlineSeconds * 1000` as both `timeoutMs` and `requestTimeoutMs` to foreground `commands.run`. It does not call `Sandbox.connect` or POST connect. This is the merged PR #38 attachment prerequisite; this spec does not redesign it or relax its external lifecycle-policy race limitation.

Read-only inspection of the installed [published 2.51.0 bundle](https://unpkg.com/e2b@2.51.0/dist/index.mjs) and [source map](https://unpkg.com/e2b@2.51.0/dist/index.mjs.map), checked September 30, 2026, establishes:

- `sandbox/commands/index.ts`: `run` calls `start` then `CommandHandle.wait`. `start` places `timeoutMs` in the **ConnectRPC call options**, not the process configuration payload.
- `connectionConfig.ts`: `setupRequestController(requestTimeoutMs)` bounds the start handshake. `clearStartTimeout()` runs when the process-start event/PID arrives. It is not a second full-runtime timer after that acknowledgement.
- `sandbox/commands/commandHandle.ts`: transport/iteration failure rejects wait; cleanup aborts the local controller. `handleKill` is a separate explicit method and is not invoked by these timeout paths. Error mapping describes `DeadlineExceeded` as a long-running-request limit.

The official [versioned 2.6.2 reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.6.2/commands), checked September 30, 2026, describes `timeoutMs` as a command timeout and `requestTimeoutMs` as an API request timeout. That older descriptive reference is **not the pin** and does not establish remote killing. A 2.51.0 reference page was unavailable during this audit; use the exact published artifact for version-specific evidence.

**Conclusion/inference:** the native client evidence establishes observation deadlines, not a command-runtime guarantee. It does not establish how every deployed envd reacts to RPC cancellation; remote termination at this boundary remains unverified. The command **may still run** after observation stops. Sandbar redirects output/status to files and returns pending on run/read errors, then polls the existing receipt. Polling can later succeed or remain pending; the original 300-second deadline is not a total SDK wait bound. Setup/attachment, status and output reads have their own timeouts and add latency.

### Daytona: documented termination, limited deployed evidence

There is **no pinned Daytona SDK** in this implementation. Sandbar uses direct REST, with [native DTO/fixture evidence](../packages/providers/daytona/src/daytona.test.ts) based on **REST 0.218.0**. [Driver exec](../packages/providers/daytona/src/index.ts) submits `/process/execute` with `{ command: captureWrapper, cwd, timeout: deadlineSeconds }`. The local HTTP abort is `(deadlineSeconds + 10) * 1000`, after preflight. [Adapter receiptDeadline](../packages/providers/daytona/src/adapter.ts) uses that same window after submission; it guides receipt observation, not remote killing or a total SDK wall-clock timer.

The official [TypeScript process reference](https://www.daytona.io/docs/en/typescript-sdk/process/), checked September 30, 2026 (unversioned current docs), explicitly documents termination when the execution timeout elapses and distinguishes it from client-wide request timeout. The official [troubleshooting REST example](https://www.daytona.io/docs/en/troubleshooting/) sends the same `timeout` field to `/process/execute` and identifies process execution timeouts. These are provider-documented intent, **not live qualification of Sandbar's wrapper** or proof for every 0.218 deployment.

**Conclusion:** Daytona has a documented server command-termination guarantee, and Sandbar sends its timeout field separately from HTTP waiting. This audit has not verified the deployed server implementation, process-group/descendant coverage, or wrapper cleanup/receipt behavior on forced termination. The wrapper runs capture readers, a child command, waits and frame emission; even documented wrapper termination does not prove every descendant stopped or that a usable command exit frame was delivered. HTTP timeout/loss alone establishes neither target exit nor absence of side effects. Sandbar catches that failure as an uncertain response and investigates the existing receipt; do not infer exit status or timeout cause.

### Modal: native process timeout and separate local observation

Sandbar pins **`modal@0.10.1`** in [package.json](../packages/providers/modal/package.json). The [adapter](../packages/providers/modal/src/adapter.ts) forwards `deadlineSeconds` to `transport.start({ timeoutSeconds })`, with a separate local `AbortSignal.timeout((deadlineSeconds + 5) * 1000)` shared by start and initial result observation. That timer begins before task/router lookup, not at confirmed process start. Later observations use their own adapter-context deadline; neither window is a total SDK wait limit. Sandbox creation independently passes `config.timeoutSeconds * 1000` (default 300; accepted 60–3,600 seconds) to native `experimentalCreate({ timeoutMs })`.

The [router wire](../packages/providers/modal/src/router-wire.ts) sends the process limit as protobuf field 6 of `TaskExecStart`. Read-only inspection of the [published 0.10.1 bundle](https://unpkg.com/modal@0.10.1/dist/index.js), checked September 30, 2026, identifies this field as `TaskExecStartRequest.timeoutSecs`; the native SDK's `buildTaskExecStartRequestProto` maps process `timeoutMs` to the same field. Sandbar uses the audited private router directly rather than the SDK's command-retry path. Local abort cancels router RPCs via `call.cancel()` and closes local channels; it does not call sandbox termination. Control-plane lookups check cancellation before/after awaits, without proving immediate cancellation of an in-flight lookup. The [official command guide](https://modal.com/docs/guide/sandbox-spawn), checked September 30, 2026 (unversioned current docs), documents that an exec command runs for at most its configured timeout. The [sandbox lifetime guide](https://modal.com/docs/guide/sandboxes) describes a separate maximum lifetime.

**Conclusion:** Modal has a documented process runtime bound and a distinct native timeout field, unlike E2B's RPC-only mapping. This is not live qualification of the pinned private-router integration or proof of descendant/process-group termination. A local timeout or lost start acknowledgement leaves effect possible and submission pending; observation reuses the original exec ID without another start. `result()` awaits exit evidence and both output streams together, so exit success plus lost output can still leave the public outcome unconfirmed. Missing exit/signal evidence rejects rather than inventing success. The [native-router fixtures](../packages/providers/modal/src/router-wire.test.ts) assert field 6, one start after lost acknowledgement, original-ID observation, and local abort/close without replay; [adapter fixtures](../packages/providers/modal/src/adapter.test.ts) cover reopened results. These are offline boundary evidence, not a live termination guarantee.

## Effects, completion and unavailable output

Keep existing `NonzeroExitError` (`NONZERO_EXIT`, result/effect applied), `NoExitCodeError` (`EXIT_STATUS_UNKNOWN`, result/effect applied), `OutcomeUnknownError` (`OUTCOME_UNKNOWN`, reference/effect possible) and post-submission `WaitAbortedError` (`WAIT_ABORTED`, reference/effect possible). A definitive pre-dispatch invalid/unsupported request has no command effect. A timer exception after dispatch does not prove an exit code, signal, runtime timeout cause, or permission to rerun.

Completion and output are separate evidence. An E2B command can exit 0 and write its status marker while a later stdout/stderr read fails. Today `readExecution` only returns a completed value after both reads; a failure can leave the public call pending/unknown despite actual success. Daytona can likewise complete while the HTTP response or receipt is unavailable/malformed; Modal can complete while a router output stream is unavailable. Conversely, receipt absence is not proof that a command never ran. Do not describe existing APIs as always exposing confirmed exit independently of output.

The two slices below do not alter result/error semantics. Document their limitation honestly. If a later change exposes exit evidence independently, it must preserve a validated confirmed exit through output failure, reuse existing typed error conventions, and receive a separate narrow design review. Never downgrade an already returned/cached confirmed result because a subsequent display/helper call fails. Helper validation/parsing errors are local application errors and cannot revise the exec outcome. No automatic resubmission, supervisor, destroy-on-timeout workaround, journal, persistence hook or generic recovery system is proposed.

## Delivery and acceptance

The completed slices below retain their acceptance criteria for regression coverage.

1. **SDK helper PR (merged in PR #53).** Owner: SDK result construction/public types and focused output guide/examples; no provider/adapter runtime changes. Implement exactly the overloads and two preview methods above; export `OutputPreview`. Tests cover unchanged defaults/numeric overloads, full decode of >16 KiB, all limit edges/invalid objects, each stream independently, empty/zero/exact bounds, true literal ellipsis, split/invalid UTF-8 and BOM. Exercise complete capture with shortened display and truncated capture with unshortened display; helpers never mutate bytes, truncation or exit. Construct ordinary, recovered and nonzero/missing-exit error results through the central helper. Compile and execute public Node/Bun packed-consumer examples, including old numeric usage and full JSON parsing with a capture guard. Update files/output docs and generated public references. Add no live output-helper scenario: helpers are entirely local, and existing capture acceptance remains applicable.
2. **Timeout documentation/fixture PR (merged in PR #54; live termination unverified).** Owner: bounded-exec provider docs, exec input documentation and maintained native-boundary tests. Keep signatures/defaults/errors unchanged; explain caller signal, per-provider mappings and lack of an established E2B runtime-termination guarantee. Deterministic tests assert exact timeout options/body and disabled retries, one dispatch after timeout/lost response, post-submission local abort without kill/destroy, delayed receipt success, and successful command status plus failed output retrieval remaining unconfirmed publicly. Inspect the actual pinned E2B client against fake transport when validating timer wiring; transport-interface mocks alone cannot prove it. Keep Daytona frame/receipt tests and preflight-relative receipt deadline tests. For Modal, assert the native field-6 process timeout and independent create-time sandbox lifetime, the local `(deadlineSeconds + 5)` start/result window (including lookup latency), and per-observation deadlines. Retain router lost-acknowledgement/original-ID and abort/close fixtures; cover a local deadline followed by later original-ID exit/output recovery without start replay or sandbox termination, and exit evidence plus failed output delivery remaining unconfirmed. No fixture timeout proves native process termination. Compile current caller-signal examples. No live behavior changes are promised; future enforcement changes must add scenarios to the maintained Bun acceptance suite, with paid runs separately authorized.

Run focused tests first, then relevant sequential shared builds, CI checks, packed consumers and docs/examples for coding PRs. The helper slice merged in PR #53 with deterministic tests and packed public examples. The timeout slice changes no public API or runtime behavior; its caller-signal example compiles against current public packages. Offline fixtures qualify native wiring and observation behavior, not deployed termination.

**Native enforcement is a later decision**, not a prerequisite or hidden third slice. Require exact deployed envd/server evidence for cancellation/kill and descendant scope, acknowledgement/exit certainty, and output loss before designing it. Select a product contract for explicit unsupported providers before changing the compatibility meaning of `deadlineSeconds`. The two slices above are merged; full/preview signatures, suffix behavior, bounds, defaults and local errors are implemented. Future enforcement work needs its own implementation handoff; no paid calls, publication, automatic merge or monitoring are authorized.
