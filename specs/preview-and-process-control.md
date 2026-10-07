# Preview access and useful process control

Implementation contract · Preview merged in #60; E2B termination merged in #66; finite exec stdin merged in PR #71 · October 6, 2026

Preview access and [default creation and everyday files](sandbox-basics-dx.md) are merged. E2B local-handle termination and finite stdin for ordinary `exec` are implemented; incremental process input and sustained output remain separate future work. Applications should be able to start a server, obtain usable access information and deliberately stop their command. Keep provider choices in setup and common calls short. This brief does not enlarge the shipped [finite streaming contract](interactive-execution-and-access.md).

## Preview access

Settled preview call and return shape (deterministic coverage; supported Daytona/E2B preview modes passed at `3188e33` in #68):

```ts
const preview = await box.preview(3000);
// Discriminated result:
// { access: "public", url: string }
// | { access: "protected", url: string, headers: Record<string, string> }
```

```ts
const preview = await box.preview(3000);
const response = await fetch(preview.url, {
  headers: preview.access === "protected" ? preview.headers : undefined,
  redirect: "error",
});
```

A protected result is for an HTTP client that can supply the required headers; it is not automatically a browser-openable link. Public results may be opened in a browser, but expose the service to whoever can reach that URL. If native protection instead requires a browser sign-in or URL credential, settle that representation explicitly before implementing that provider; do not disguise it as header authentication.

Adapter setup is `preview: { access: "protected" | "public" }`, defaulting to protected. The implemented mappings are Daytona protected and E2B explicit public. Unsupported choices fail clearly: Daytona public setup rejects before connection IO; E2B protected `preview()` rejects without native lookup. Newly created/restored E2B sandboxes nevertheless set `allowPublicTraffic: false` by default, independently of outbound network policy, and verify observed visibility before confirming creation or restore. Missing or mismatched visibility leaves an uncertain outcome while retaining confirmed resource identity. Existing sandboxes are not privatized by connecting; E2B public lookup requires current native public visibility and auto-resume off.

`preview(port, { signal? })` validates an integer port from 1 through 65535 and resolves access to existing running compute. It does not start a server, resume compute, change outbound policy, extend lifetime or replace compute. Daytona's native GET may activate the requested preview route. Producing access information does not prove a listener is ready; connection refusal or proxy errors remain possible. Local cancellation stops waiting, not compute; native reads may finish afterward. The result is not stored in sandbox references, operation recovery or diagnostics.

### Native evidence and decisions

Inspected October 2, 2026, against Sandbar base `52a95be`, published `@daytona/sdk@0.218.0` (inspection only, not runtime dependency) and runtime `e2b@2.51.0`. No paid calls were run.

| Provider | Default exposure before lookup | Native mapping and enforcement | Expiry, mutation and lifecycle |
| --- | --- | --- | --- |
| Daytona | Existing Sandbar create sends `public: false`; native detail must continue to report private visibility. A lookup does not repair changed visibility. | `GET /sandbox/{id}/ports/{port}/preview-url`, returns URL/token; fetch supplies `x-daytona-preview-token`. Standard token authenticates all sandbox ports, including terminal/toolbox command and file access. It is a sandbox-wide credential, not a shareable viewing grant. | Pinned SDK warns that GET can open a preview route. Standard token cannot be individually revoked; official docs say stop/start rotates it, pause/resume retains it. Only running, scoped compute is accepted; no start/connect call is sent. No common expiry promise. |
| E2B | Native URLs are public by default. This implementation explicitly sets `network.allowPublicTraffic: false` for protected/default creation and restore, or true for explicit public setup. | Public lookup reads scoped detail, requiring running state, `network.allowPublicTraffic: true`, domain `e2b.app` and `lifecycle.autoResume: false`; URL matches pinned `getHost(port)`. No endpoint mutation or guest attachment. | GET detail has no `trafficAccessToken`; create/connect return it. Pinned connect is `POST /v2/sandboxes/{id}/connect`, which may resume or alter session lifetime, so it is not used for preview. Public URL is usable only while native compute/listener remains available; request fresh access after reopening. |

Evidence: [Daytona preview authentication and lifetime](https://www.daytona.io/docs/en/preview/), [published pinned SDK](https://www.npmjs.com/package/@daytona/sdk/v/0.218.0), [last public Daytona server source](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/api/src/sandbox/services/sandbox.service.ts#L1876) (v0.190, corroboration rather than proof of deployed v0.218), [E2B public access enforcement](https://docs.e2b.dev/network/restrict-public-access), [pinned E2B SDK](https://www.npmjs.com/package/e2b/v/2.51.0). SDK source inspection confirms the creation flag, plain GET detail schema, hostname formula and mutating connect path. Current documentation is distinct from pinned native source and from the separately recorded live evidence.

**P1 — E2B protected access (product decision / native feasibility):** fresh protected access after reopening cannot be delivered through the pinned read-only API. Decide whether to wait for an upstream read-only credential endpoint or explicitly scope a future feature to locally retained creation credentials with separately proven resume/expiry behavior. This slice does neither, does not persist credentials as identity and never silently returns public access. Protected creation is enforceable; usable protected preview access remains unsupported.

**P2 — Daytona public access (product decision):** the pinned visibility setting publishes sandbox ports globally, while the existing adapter verifies private visibility across creation/reopening/state operations. Supporting public mode requires accepting that sandbox-wide exposure and reconciling those guarantees, not toggling visibility from `preview(port)`. It remains explicitly unsupported in this slice. Signed credential URLs, per-port share grants and revocation APIs are deferred.

The standard Daytona credential is for the caller's own HTTP client, never an end-user share link. Requests carrying its custom header must reject redirects, as the compiled recipe does, to prevent a cross-origin redirect from disclosing sandbox-wide authority. Both return branches carry ephemeral access information, not durable identity or readiness. Credentials and URLs are excluded from telemetry; response validation failures use fixed messages. Reopening uses the ordinary reference and asks for access again. No grant inventory, gateway, tunnel or implicit server management is introduced. See the compiled [preview recipe](../apps/docs/examples/sandbox-preview.ts) and [provider guide](../apps/docs/src/content/docs/docs/guides/preview-access.md).

## Process control that means what it says

### Decision: one native termination request through an active local handle

`terminate()` on the existing `ProcessHandle` shipped for E2B in #66, following the design in #64. It refines the older termination gate in [the streaming contract](interactive-execution-and-access.md): the first useful operation accepts the native PID-selection race described below; it does **not** promise immutable execution targeting. Requiring proof that a PID can never be reused would leave E2B unsupported despite its documented, useful kill operation. Applications that require that stronger guarantee cannot use this mapping. Do not manufacture generation proof to satisfy them.

```ts
// Exported public result; existing ProcessExit stays unchanged.
type ProcessTermination = {
  status: "requested" | "not-found" | "exited";
};
// On ProcessHandle:
// terminate(options?: { signal?: AbortSignal }): Promise<ProcessTermination>;
```

`requested` means the native termination request was acknowledged. It does not confirm exit, the original execution's identity at signal delivery, or descendant cleanup. `not-found` means the native selector was absent, not that this command's exit was observed. `exited` means this handle already has a validated terminal result and sent no request; `wait()` retrieves it. A returned request status remains historical even if exit arrives immediately afterward. Only `wait()` supplies the ordinary `ProcessExit`, including `outputComplete`.

Keep arbitrary signals, graceful escalation timers, process inventory, public PIDs and persisted process references out of this slice. The E2B default is its native SIGKILL operation: abrupt termination, no application cleanup guarantee, no process-tree promise. Recommend no additional adapter permission/capability switch: deliberately calling `terminate()` is the user's choice to request this documented native behavior. Provider mechanics and limitations belong in adapter documentation. Supporting a future stronger identity mode would require new evidence and an explicit setup choice, not a silently stronger label on today's PID request.

### Evidence at the native boundary

Inspected October 2, 2026, against freshly fetched main `e52c7f4`, installed `e2b@2.51.0` and published reference `@daytona/sdk@0.218.0`. Daytona is not an SDK runtime dependency. No live provider calls were run. Current official documentation and public server source corroborate behavior but do not establish the deployed guest/server version.

| Boundary | Evidence | Decision |
| --- | --- | --- |
| E2B termination | Installed `dist/index.js`: `CommandHandle.kill()` delegates to `Commands.kill(pid)`; the latter sends `SendSignal` with PID selector and numeric signal 9, returning true on acknowledgement and false on RPC NotFound. `CommandHandle.kill()` has no request options; `Commands.kill(pid, { signal, requestTimeoutMs })` does. | Viable as a documented native PID request through the captured handle connection. Use the latter public method internally for bounded cancellation; no new connect/start or shell `kill` command. |
| E2B terminal event | Pinned decoder reads EndEvent's integer `exitCode` and error, stores the result before final callback delivery, then `wait()` returns it or throws `CommandExitError` for nonzero. The wire also has `exited`/`status`, but the public handle does not expose those as structured signal evidence. Proto3 defaults an omitted scalar `exitCode` to zero; the public handle cannot prove wire-field presence. | Preserve validated native terminal integers, including -1. Do not turn acknowledged SIGKILL into an exit result or infer signal 9 from error text. |
| Daytona termination | Pinned `esm/Process.js` delegates `deleteSession(sessionId)` to DELETE session; session command IDs support status/log reads. There is no ordinary session-command kill method. PTY kill is a different execution mode. Current docs describe session deletion as termination and removal. | Deferred for current handles: Daytona does not implement `processes.start`. A dedicated one-command session is a plausible later mapping, but deletion may erase the status/log evidence needed by wait. No per-command or confirmed-exit claim from DELETE alone. |

Reproducible pinned evidence: [E2B 2.51.0 tarball](https://registry.npmjs.org/e2b/-/e2b-2.51.0.tgz), installed `dist/index.js` SHA-256 `2279dd39f81fa4211e8206961fb73f478ae7b73d58f21db4c5370bf9f7fc9bfc`; [Daytona 0.218.0 tarball](https://registry.npmjs.org/@daytona/sdk/-/sdk-0.218.0.tgz), tarball SHA-256 `403c89ad9c9e292c27b12a953229d050dd09f6635b25e089e60767318cdbf803`. Inspect E2B `Commands.kill`, `CommandHandle.kill/iterateEvents/handleEvents`, generated EndEvent declarations; Daytona `Process.deleteSession/getSessionCommand/getSessionCommandLogs` and generated process API paths.

Official [E2B background commands](https://docs.e2b.dev/commands/background) demonstrate run/kill; they do not establish an immutable selector. Public envd source at commit `f2fc4829bd1e8a74d4212c08a0ae4bc3bbd119d2` shows [PID lookup and removal](https://github.com/e2b-dev/infra/blob/f2fc4829bd1e8a74d4212c08a0ae4bc3bbd119d2/packages/envd/internal/services/process/service.go) and [signal dispatch](https://github.com/e2b-dev/infra/blob/f2fc4829bd1e8a74d4212c08a0ae4bc3bbd119d2/packages/envd/internal/services/process/signal.go): the caller supplies a PID, not the identity of a retained handler. Compare-and-delete protects server bookkeeping from deleting a successor; it does not bind a stale caller to the original process. This is corroboration, not a pinned server guarantee.

The same commit's [handler implementation](https://github.com/e2b-dev/infra/blob/f2fc4829bd1e8a74d4212c08a0ae4bc3bbd119d2/packages/envd/internal/services/process/handler/handler.go) cancels output on termination signals and emits `ProcessState.ExitCode()` after Wait. [Go documents -1 for signal termination](https://pkg.go.dev/os#ProcessState.ExitCode). Therefore a native terminal -1 is useful terminal evidence, but not a conventional shell status such as 137 or proof of which signal caused exit. Normal and nonzero terminal results remain ordinary `wait()` values. A transport that supplies only a signal without a terminal integer cannot fit today's exit shape: it must reject observation rather than synthesize an integer; a structured signal-only result requires a separately reviewed exit-type change before that mapping ships. Native pipe cancellation also prevents an all-produced-output guarantee; `outputComplete` retains the existing meaning of all native text delivered, not all bytes the workload attempted to write.

Official [Daytona process reference](https://www.daytona.io/docs/en/typescript-sdk/process/), [process guide](https://www.daytona.io/docs/en/process-code-execution/) and [toolbox schema](https://www.daytona.io/docs/toolbox-openapi.json) establish session and command operations. The current schema is mutable (`v0.0.0-dev`); current SDK docs identify v0.220. Neither proves 0.218 deployment behavior. Enabling session deletion would first need evidence about running commands, descendants, deletion acknowledgement, status/log retention, session-ID reuse and lifecycle interruption. A single-command session avoids terminating another command by design, but is not yet evidence that deletion preserves this observation contract. No Daytona user option is needed now; the mapping remains unsupported. PTYs, injected supervisors and whole-sandbox destruction are outside this operation.

### Target identity and local lifetime

Only an established local handle can issue the operation. Capture the original E2B SDK connection and private native PID; do not reacquire credentials by calling mutating `Sandbox.connect`, reattach by PID, or consult process inventory to pretend to prove identity.

| Situation | Required behavior and practical limit |
| --- | --- |
| Already confirmed exit, even after output failure/detach | Refresh synchronous validated native exit evidence first. Return `exited`, zero signal calls; repeated `wait()` preserves the terminal integer. Pre-aborted callers still reject before work. |
| Active stream, exit not yet observed | One native PID signal request. Remote exit/removal and PID reuse can occur before the client sees the terminal event or between local checking and native lookup. The wrong successor may be signalled. Local checks narrow this window; they cannot eliminate it. |
| Observed transport loss, output overflow, iterator return/abort, explicit detach or client close without confirmed exit | Invalidate termination authority on that handle; reject before dispatch (`UNAVAILABLE`, or `CLIENT_CLOSED` for a closed client). Do not retain a detached PID as a remotely usable handle. This means a caller should terminate before releasing observation. |
| Sandbox pause/resume, stop/start, restore, expiration or external lifecycle-policy change | Do not reconnect or carry authority into reopened compute. Invalidate on a locally known lifecycle transition or stream interruption; maintain the existing running/scoped/auto-resume-off guest rules. An external transition can race dispatch without local notification. Same sandbox ID or running preflight is not generation proof. No lifecycle change is induced by terminate; no external lifecycle watcher or generic registry is required. |
| Request acknowledged but stream ends without terminal evidence | Return `requested`; `wait()` rejects `UNAVAILABLE`. Do not assume SIGKILL acknowledgement is terminal evidence. |
| Response lost or local cancellation after possible dispatch | Request outcome is unknown. Do not retry, send a second signal, restart the command, reconnect or destroy the sandbox. Continue using any still-working output/wait stream to learn exit. |

The remaining active-handle race is an explicit native limitation, not a guarantee that the SDK can detect every reused PID. Deterministic fixtures must demonstrate it honestly. If an application cannot accept signalling a successor during that window, E2B's current public selector is unsuitable; safe portable termination must wait for upstream execution-bound selectors. Do not add a mandatory generation protocol, hidden helper process or generic recovery journal to make this narrow operation available.

### Request, cancellation and error behavior

Use a fixed 30-second shared request deadline and client-close signal, independent of the command stream. Each caller signal bounds only that caller’s local wait; it must not abort the shared native request or another waiter. Pre-abort rejects `WAIT_ABORTED` with effect `none`; unsupported native method and locally invalidated authority reject before dispatch. Once native mutation may have been submitted, cancellation, deadline, malformed acknowledgement or transport failure rejects `OUTCOME_UNKNOWN` with effect `possible` and existing minimal provider/sandbox context. A native false/NotFound maps to `not-found`, never an invented exit. Only an adapter rejection that proves no effect may claim effect `none`. Request deadline/client close attempt to stop request IO; caller abort stops only its wait. Neither can undo a dispatched signal. Termination cancellation must not detach the process output stream (client close retains its existing local-detach behavior). Late response handling must release local resources without changing the settled caller result. Cache separately observed terminal evidence even if termination's acknowledgement is lost.

Allow at most one native termination attempt per local handle. Concurrent callers share the request promise with independently cancelled local waits. Subsequent calls reuse a known `requested`/`not-found` acknowledgement; refresh terminal evidence first so a known exit returns `exited`. If the shared request itself settles `OUTCOME_UNKNOWN`, cache that uncertainty without redispatch. A caller-only abort does not poison a still-pending request: later callers may obtain its eventual acknowledgement. Pre-aborted calls reject without allocating or consuming the attempt. Do not label valid duplicate calls `INVALID_ARGUMENT`. Cache one promise/result rather than introducing a waiter registry or durable idempotency framework. Once dispatched, local detach or observation failure does not erase the cached request outcome; no new dispatch is permitted from an inactive handle. Independent `wait()` calls remain repeatable and caller-cancellable. No stream lock should make output delivery wait for termination IO.

The adapter addition is an optional native `terminate(ctx: ReadContext): Promise<{ status: "requested" | "not-found" }>` on `NativeProcess`; reuse the context's cancellation/deadline machinery for local waiting only. The SDK supplies `exited`, validates results, shares and caches the one request attempt and rejects unsupported adapters without dispatch. The method name describes a mutation even though its context reuses local IO bounds; do not assign read-only error/effect semantics to it. No durable operation reference is introduced.

### Concrete workflow (shipped API, finite output)

```ts
import { SandbarError } from "sandbar-sdk";

const job = await box.processes.start({
  command: { kind: "argv", argv: ["node", "job.js"] },
});
// One budget bounds termination, exit observation and output draining.
const observation = AbortSignal.timeout(10_000);
// Handle output failure immediately so it cannot become an unhandled rejection.
const drain = (async () => {
  for await (const chunk of job.output({ signal: observation })) {
    (chunk.stream === "stdout" ? console.log : console.error)(chunk.text);
  }
})().then(
  () => ({ ok: true as const }),
  error => ({ ok: false as const, error }),
);
try {
  // Application decides to stop its job. SIGKILL on E2B; PID race applies.
  try {
    const request = await job.terminate({ signal: observation });
    console.log(request.status); // requested / not-found / exited; not an exit code
  } catch (error) {
    if (!(error instanceof SandbarError) || error.code !== "OUTCOME_UNKNOWN") throw error;
    console.error("Termination acknowledgement is unknown", error);
    // Observe independently below; never repeat the termination request.
  }
  const exit = await job.wait({ signal: observation });
  console.log(exit.exitCode, exit.outputComplete); // native -1 is possible
  const output = await drain;
  if (!output.ok) console.error(output.error);
} finally {
  await job.detach(); // release local observation; never terminate remotely
}
```

If `terminate()` rejects `OUTCOME_UNKNOWN`, handle that error in application code and try `job.wait({ signal: ... })` to observe independently. Repeated terminate calls reuse the existing attempt and never send another signal. A confirmed terminal result remains readable even after output failure. A `wait()` abort only ends that waiter. The output abort releases observation when the shared example budget ends, including when exit is already confirmed but the stream never closes. Native requests may finish after local cleanup; detach never kills remotely. Termination need not produce a terminal event before the wait deadline; `not-found` also cannot supply one. An output failure may invalidate termination before the application calls it, so cleanup must report that limitation rather than fall back to sandbox destruction. The compiled [public-package recipe](../apps/docs/examples/text-streaming.ts) exercises shipped termination.

### Future incremental input

`processes.start` continues to use closed stdin. Ordinary `box.exec` accepts an optional finite UTF-8 string or byte array, ends guest input with EOF, and retains its normal separate output and exit result. See the [finite stdin contract](process-stdin.md) for bounds, adapter opt-in, mappings and deterministic evidence. This does not add stream input or an interactive handle. Future incremental process input still needs a separate contract for concurrent output, backpressure, acknowledgement, cancellation and EOF; PTYs, resize and interactive shells also remain separate.

## Long-running server workflow and output limits

The end-user target is a configured client, ordinary sandbox creation, `processes.start` for the server, `preview(port)` for access, and explicit termination/cleanup. Deliver a compiled recipe when supported. Do not present today's finite E2B stream as an indefinite server-log solution: it has a cumulative 1 MiB cap as well as queue limits because the native client retains output.

Before advertising long-running output, verify a bounded native transport or upstream support. Specify slow-consumer behavior and completeness; never silently drop logs or remove the cumulative cap while native allocations keep growing. Preview access can ship independently for a server started by the user's image or another supported execution path. It does not depend on solving terminal emulation or unlimited log retention.

## Scope and delivery

Preview access merged in #60: the settled return/config shape, supported provider mappings, docs and deterministic/packed tests are shipped. Daytona protected and E2B explicit public preview passed at `3188e33` in #68; E2B private-default ingress denial remains unqualified; unsupported access choices above remain separate decisions. Keep the existing roadmap ordering and shipped preview design. E2B termination merged in #66; finite exec stdin merged in PR #71 and has no live qualification; incremental process input and sustained output remain future slices:

1. **E2B termination — merged in #66.** The public/adapter method, one pinned `Commands.kill` request, acknowledgement cache, local cancellation/deadline, lifecycle fencing, fixtures, packed coverage and compiled recipe are shipped. The bounded live case passed at `131a8c6` with borrowed `base` on Bun 1.3.14/darwin-arm64: ready output, request acknowledgement/reuse, independently observed nonzero terminal result, confirmed cleanup and client close. The prior `4cc6a20` attachment failure remains recorded. PID reuse, descendant cleanup, other images/platforms and signal-delivery races are not qualified; Daytona termination remains unsupported. This pass does not qualify the separate full streaming scenario.
2. **Finite exec stdin — merged in PR #71.** Follow the [finite stdin contract](process-stdin.md). Daytona and E2B are launch built-ins; experimental Modal also implements the adapter contract. Shared deterministic and packed tests exercise bytes and EOF. Live qualification has not run. Future providers are not implemented by this slice.
3. **Incremental process input and sustained output.** Establish byte delivery, bounded transport/retention, acknowledgement and initial-log completeness before changing process APIs or streaming limits. Session deletion requires the additional evidence above and its own reviewed termination contract; defer it if it cannot preserve usable wait behavior. Keep the future investigation separate from finite exec input.

Merged termination acceptance boundaries: zero native signal calls for pre-abort, known exit (including a flush failure), detached/lost-stream/closed-client handles and unsupported mappings; exactly one PID + SIGKILL RPC for active E2B; true acknowledgement, NotFound, RPC rejection, malformed result, lost acknowledgement, 30-second timeout and caller abort; exit-before-dispatch and exit-during-request; concurrent callers with independent aborts, cached acknowledgement/absence/unknown outcome, pre-abort not consuming the attempt; exit-confirmed while stream never closes with bounded drain and local cleanup; negative native terminal integer and adapter-level signal-only/missing terminal evidence (do not claim the pinned decoder detects an omitted proto3 scalar); output continues during request; known lifecycle invalidation with no connect/resume; successor PID fixture explicitly demonstrates that an unobserved remote reuse cannot be detected by this selector. Assert no retries, start replay, supervisor, reconnect, sandbox kill or fabricated exit. Preserve existing `outputComplete` behavior under native output cancellation.

Run Bun 1.3.14 frozen install, sequential package builds/checks, offline tests, lint/format, packed consumer checks for the API change and docs checks. Maintain existing live acceptance scenarios; additional live kill/exit configurations require separate authorization and recorded evidence. Future slices require independent native-correctness and DevEx/complexity reviews before merge; no direct push to main.
