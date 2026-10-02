# Preview access and useful process control

Accepted next priority · Design brief; API sketches pending native evidence · October 2, 2026

Schedule after [default creation and everyday files](sandbox-basics-dx.md), before new adapters. Applications should be able to start a server, obtain usable access information and deliberately stop their command. Keep provider choices in setup and common calls short. This brief does not enlarge the shipped [finite streaming contract](interactive-execution-and-access.md) or claim new native support.

## Preview access

Proposed ordinary call and return shape:

```ts
const preview = await box.preview(3000);
// Proposed discriminated result:
// { access: "public", url: string }
// | { access: "protected", url: string, headers: Record<string, string> }
```

```ts
const preview = await box.preview(3000);
const response = await fetch(preview.url, {
  headers: preview.access === "protected" ? preview.headers : undefined,
});
```

A protected result is for an HTTP client that can supply the required headers; it is not automatically a browser-openable link. Public results may be opened in a browser, but expose the service to whoever can reach that URL. If native protection instead requires a browser sign-in or URL credential, settle that representation explicitly before implementing that provider; do not disguise it as header authentication.

The desired provider setup option is `preview: { access: "protected" | "public" }`. Protected access is the intended default where enforceable; public exposure requires an explicit setup choice. This is a proposed policy, not a claim that both current providers can implement it. An adapter unable to enforce the requested mode reports `UNSUPPORTED` with an actionable reason; it never silently publishes an unauthenticated URL. Do not implement a shared gateway merely to hide native differences.

`preview(port)` validates an integer port from 1 through 65535 and resolves native access to the existing sandbox. It does not start a server, open outbound internet access, resume compute or create replacement compute. Producing access information does not prove the port is listening. A connection-refused response after obtaining the URL remains possible; document that distinction in the basic recipe rather than hiding an unbounded readiness loop.

URLs and credentials are ephemeral access information, not durable sandbox identity. Document native expiry, invalidation on suspend/resume and revocation behavior per provider; do not invent a common lifetime guarantee. Redact credentials and credential-bearing URLs from diagnostics. Reopening a sandbox uses its ordinary reference and requests fresh access information. No grant inventory, revoke API, TCP tunnel or port-forwarding service is required for the first slice.

Before coding, record the pinned native endpoint/SDK mapping, default port exposure (including exposure before this method runs), authentication enforcement, expiry and any mutation for Daytona and E2B. Setup alone must not promise that native ports are private. If either provider cannot satisfy the default safely, document the limitation and require an explicit supported choice. Add support reporting and qualification cases for the actual selected access modes.

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
