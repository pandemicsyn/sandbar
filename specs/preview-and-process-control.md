# Preview access and useful process control

Implementation contract · Preview merged in #60; E2B termination merged in #66; finite exec stdin merged in PR #71 · October 6, 2026

The [current process IO contract](process-io-dx.md) owns sustained processes, incremental input, signals, byte output, terminals and reopening. This document owns preview access and retains the legacy finite E2B termination contract. Exact signatures live in the [SDK exports](../packages/sdk/src/index.ts).

Preview access and [default creation and everyday files](sandbox-basics-dx.md) are merged. E2B local-handle termination and finite stdin for ordinary `exec` are implemented; incremental process input and sustained output are implemented through the additive process profiles. Applications should be able to start a server, obtain usable access information and deliberately stop their command. Keep provider choices in setup and common calls short. Use the [legacy finite streaming contract](interactive-execution-and-access.md) for the original E2B profile and the current process IO contract for newer profiles.

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

The original October 2 source audit used published `@daytona/sdk@0.218.0` (inspection only) and runtime `e2b@2.51.0`; dated live preview evidence is recorded separately below.

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

### Legacy native boundary

Pinned `e2b@2.51.0` `Commands.kill(pid, { signal, requestTimeoutMs })` sends PID-selected signal 9, returning true for acknowledgement and false for RPC NotFound. The captured connection supports bounded cancellation without connect/start or a shell kill. The native terminal decoder stores its integer result before final callbacks; preserve valid negative integers such as -1, including through output failure. Do not infer signal 9 or shell status 137 from termination acknowledgement or error text. Proto3's default zero does not establish exit-field presence. A signal-only observation without a terminal integer cannot satisfy this legacy exit shape.

PID reuse can signal a successor; neither public connection selectors nor server bookkeeping prove immutable execution identity. Output cancellation can prevent delivery of attempted workload bytes: legacy `outputComplete` means all native text was delivered, not all bytes the workload attempted to write. Native evidence and deterministic fixtures do not establish deployed descendant cleanup.

Daytona had no legacy finite-process mapping. Current Daytona control uses the retained child in its adapter-owned supervisor, as specified in [process IO](process-io-dx.md); session deletion is not that mapping and cannot by itself prove command exit or preserve logs/status.

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

## Current process workflows and qualification

The legacy finite E2B profile retains its cumulative 1 MiB output cap because the native client accumulates output. Current explicit sustained output uses bounded transports on both built-ins; incremental exact-byte input/EOF, status, byte output, signals, terminals and reopening are implemented separately. See the [process IO contract](process-io-dx.md), [process guide](../apps/docs/src/content/docs/docs/guides/text-streaming.md) and compiled [interactive workflow](../apps/docs/examples/interactive-processes.ts). Preview resolves access independently and does not manage the server.

Preview access (#60) has deterministic/packed coverage; Daytona protected and E2B explicit public modes passed at `3188e33` in #68. E2B private-default ingress denial remains unqualified. Unsupported preview access modes above remain separate product decisions.

Legacy E2B termination (#66) passed at `131a8c6` on borrowed base with acknowledgement reuse, separately observed nonzero terminal result, owned cleanup and client close. The prior `4cc6a20` attachment failure remains recorded. PID reuse, descendant cleanup, other configurations and signal-delivery races are not thereby qualified. Current process-profile live evidence is recorded in process IO and [provider support](../apps/docs/src/content/docs/docs/providers/support.md).

Ordinary finite `exec` input (#71) retains its own [bytes-and-EOF contract](process-stdin.md), deterministic/packed evidence and no live qualification. Incremental process input does not retrospectively qualify that different staging/router path.

Regression fixtures retain zero calls for pre-abort, known exit and invalidated authority; one native attempt across concurrent/repeated calls; cached acknowledgement, absence and uncertainty; independent waiter cancellation; confirmed negative exit through output failure; lifecycle fencing without reconnect; and an explicit successor-PID race. No retries, start replay, sandbox kill or fabricated exit may be introduced. New live configurations require separate authorization.
