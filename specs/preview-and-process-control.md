# Preview access and useful process control

Accepted priority · Preview slice implemented in this branch; process API sketches pending native evidence · October 2, 2026

Schedule after [default creation and everyday files](sandbox-basics-dx.md), before new adapters. Applications should be able to start a server, obtain usable access information and deliberately stop their command. Keep provider choices in setup and common calls short. This brief does not enlarge the shipped [finite streaming contract](interactive-execution-and-access.md) or claim new native support.

## Preview access

Settled preview call and return shape (deterministic coverage; live validation not run):

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

Evidence: [Daytona preview authentication and lifetime](https://www.daytona.io/docs/en/preview/), [published pinned SDK](https://www.npmjs.com/package/@daytona/sdk/v/0.218.0), [last public Daytona server source](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/api/src/sandbox/services/sandbox.service.ts#L1876) (v0.190, corroboration rather than proof of deployed v0.218), [E2B public access enforcement](https://docs.e2b.dev/network/restrict-public-access), [pinned E2B SDK](https://www.npmjs.com/package/e2b/v/2.51.0). SDK source inspection confirms the creation flag, plain GET detail schema, hostname formula and mutating connect path. Current documentation is distinct from pinned native source and from unrun live evidence.

**P1 — E2B protected access (product decision / native feasibility):** fresh protected access after reopening cannot be delivered through the pinned read-only API. Decide whether to wait for an upstream read-only credential endpoint or explicitly scope a future feature to locally retained creation credentials with separately proven resume/expiry behavior. This slice does neither, does not persist credentials as identity and never silently returns public access. Protected creation is enforceable; usable protected preview access remains unsupported.

**P2 — Daytona public access (product decision):** the pinned visibility setting publishes sandbox ports globally, while the existing adapter verifies private visibility across creation/reopening/state operations. Supporting public mode requires accepting that sandbox-wide exposure and reconciling those guarantees, not toggling visibility from `preview(port)`. It remains explicitly unsupported in this slice. Signed credential URLs, per-port share grants and revocation APIs are deferred.

The standard Daytona credential is for the caller's own HTTP client, never an end-user share link. Requests carrying its custom header must reject redirects, as the compiled recipe does, to prevent a cross-origin redirect from disclosing sandbox-wide authority. Both return branches carry ephemeral access information, not durable identity or readiness. Credentials and URLs are excluded from telemetry; response validation failures use fixed messages. Reopening uses the ordinary reference and asks for access again. No grant inventory, gateway, tunnel or implicit server management is introduced. See the compiled [preview recipe](../apps/docs/examples/sandbox-preview.ts) and [provider guide](../apps/docs/src/content/docs/docs/guides/preview-access.md).

## Process control that means what it says

Keep the existing `processes.start`, `output`, `wait` and `detach` vocabulary. Proposed additions:

```ts
// Proposed on ProcessHandle, only after native identity/termination review:
terminate(options?: { signal?: AbortSignal }): Promise<void>;

// A later, separate stdin extension:
// start({ command, stdin: "pipe" })
writeInput(text: string, options?: { signal?: AbortSignal }): Promise<void>;
closeInput(options?: { signal?: AbortSignal }): Promise<void>;
```

```ts
const job = await box.processes.start({
  command: { kind: "argv", argv: ["node", "job.js"] },
});
const drain = (async () => {
  for await (const chunk of job.output()) console.log(chunk.text);
})();
try {
  // Application cancellation deliberately ends the remote command.
  await job.terminate(); // proposed; not a shipped method
  const exit = await job.wait();
  console.log(exit.exitCode);
  await drain;
} finally {
  await job.detach(); // release local observation; never a remote kill
}
```

The sketch separates requesting termination from observing exit. The implementation must specify native hard/graceful behavior per provider. `terminate()` success means a confirmed request targeting that execution, not proof that all descendants exited. If identity or request outcome cannot be confirmed, report it directly; never kill a possibly reused PID, replay command start, or destroy the whole sandbox as fallback. Aborting a termination wait does not undo a possibly dispatched termination request. Preserve already confirmed exit if observation later fails; never manufacture an exit code or add a fabricated zero exit for signal termination. If a provider reports only a signal, revise the exit result explicitly before enabling that mapping.

Start with a local handle and one useful termination operation, not arbitrary signals, process inventory or persisted process references. Native evidence must establish how the handle still targets its execution after exit, PID reuse, sandbox suspend/resume and transport loss. The existing streaming spec records PID-only limitations: do not bypass them with an invented generation token. An unsupported provider/handle gives a clear error without remote effect.

For stdin, default remains closed. An explicitly piped process may accept UTF-8 text and an explicit EOF. Successful input acknowledgement does not prove application consumption; a lost acknowledgement must not cause automatic replay. Calling `writeInput` after closing input rejects before dispatch; a failed close does not falsely mark remote EOF confirmed. Caller cancellation stops waiting, not the workload. Byte input, PTYs, terminal resize and interactive shells are separate work.

## Long-running server workflow and output limits

The end-user target is a configured client, ordinary sandbox creation, `processes.start` for the server, `preview(port)` for access, and explicit termination/cleanup. Deliver a compiled recipe when supported. Do not present today's finite E2B stream as an indefinite server-log solution: it has a cumulative 1 MiB cap as well as queue limits because the native client retains output.

Before advertising long-running output, verify a bounded native transport or upstream support. Specify slow-consumer behavior and completeness; never silently drop logs or remove the cumulative cap while native allocations keep growing. Preview access can ship independently for a server started by the user's image or another supported execution path. It does not depend on solving terminal emulation or unlimited log retention.

## Scope and delivery

1. **Preview access.** Resolve the native access evidence above, finalize the smallest return/config shape, then ship supported provider mappings, docs and tests. Include invalid ports, protected/public differences, missing readiness, expired access and no hidden lifecycle changes.
2. **Termination through existing handles.** Resolve native execution identity and exit representation, then ship one verified operation with fixtures covering exited commands, reused identifiers, lost acknowledgements and local cancellation. A provider that cannot prove targeting remains unsupported. Native feasibility is a prerequisite, not an invitation to add a process supervisor.
3. **Input and sustained observation.** Scope separately after the first two decisions. Implement input only with delivery semantics documented; change streaming budgets only with evidence of bounded retention. No dependency on this slice for preview access.

These are small delivery candidates, not one combined implementation PR. Update this brief with evidence and settled signatures before delegating dependent coding work. The main SDK contract owns results; adapters own native mechanics. Run deterministic tests, packed consumer examples and docs checks. Maintain ordinary provider acceptance scenarios, with live runs separately authorized and support claims tied to actual evidence. No new qualification framework or generic recovery journal.
