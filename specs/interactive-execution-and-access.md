# Interactive execution and access

Initial design draft · September 28, 2026 · Not implemented; follows state portability

Extend the current bounded `exec`, `readFile` and `writeFile` API with interactive processes and scoped network access. This draft starts the contracts; it does not select native transports, promise provider parity, or authorize implementation before [state portability](provider-state-portability.md).

## Scope and resource model

| Resource | Meaning | Proposed surface |
| --- | --- | --- |
| Process | One command execution, potentially with streaming output and stdin | `box.processes.start`, `client.processes.get` |
| Terminal | A PTY session with terminal behavior and combined output | `box.terminals.open` |
| Endpoint | Access to a sandbox port with an explicit audience and lifetime | `box.endpoints.create` |
| Tunnel | An authenticated connection forwarding bytes to a sandbox port | `box.tunnels.open` |

Existing `box.exec()` stays the simple bounded, wait-for-completion API. Streaming is an explicit choice. A process handle is distinct from the operation that starts it: the start operation establishes identity once; later attachment and observation must never run the command again.

## Processes and output

Illustrative signatures; they are not current exports:

```ts
interface StartProcessInput {
  command: ExecCommand;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "closed" | "pipe"; // default: closed
  deadlineSeconds?: number;
}

interface ProcessHandle {
  readonly reference: ResourceReference<"process">;
  inspect(): Promise<ProcessInfo>;
  output(options?: { cursor?: string; signal?: AbortSignal }): AsyncIterable<ProcessEvent>;
  writeStdin(bytes: Uint8Array, options?: WaitOptions): Promise<InputReceipt>;
  closeStdin(options?: WaitOptions): Promise<InputReceipt>;
  wait(options?: WaitOptions): Promise<ProcessExit>;
  signal(name: "interrupt" | "terminate" | "kill", options?: WaitOptions): Promise<SignalReceipt>;
}

type ProcessEvent =
  | { kind: "stdout" | "stderr"; bytes: Uint8Array; cursor?: string }
  | { kind: "gap"; reason: "expired" | "overflow" | "disconnected"; cursor?: string }
  | { kind: "exit"; result: ProcessExit; cursor?: string };

const process = await box.processes.start({
  command: { kind: "argv", argv: ["node", "server.js"] },
});
for await (const event of process.output()) {
  // Bytes remain bytes. Decode for display only when requested.
}
```

`ResourceReference`, capability checks and wait behavior follow the state-portability conventions. Process references additionally bind the execution generation so a recycled PID or resumed sandbox cannot accidentally refer to another process. A PID alone is insufficient identity. `start` also has `submitStart`, returning the existing operation handle; unknown start results remain unknown and cannot be retried implicitly.

Contracts:

- Preserve stdout/stderr bytes and within-stream ordering. Do not promise precise cross-stream ordering unless native evidence supplies it. Cursors are opaque scoped positions, not fabricated global offsets.
- Output subscription, retained capture, and process completion are separate. Losing a subscription does not kill the process. Confirmed exit does not establish that all output was delivered; output loss remains visible even after a successful `wait()`.
- Providers declare whether output is live-only, retained/replayable, reconnectable, or not available. Supplying a cursor on a live-only transport rejects. Reattachment never reexecutes a command; providers without stable process discovery do not advertise it.
- Bound buffering and define slow-consumer behavior before implementation. If the transport can backpressure, propagate it. Otherwise report a gap or terminate the subscription with an explicit error; never silently discard bytes or buffer without limit. Do not kill workload compute merely because a subscriber is slow.
- Stdin is an effectful byte delivery operation. An acknowledgment states only what the provider confirmed, not application consumption. Lost acknowledgment remains unknown; do not resend input automatically. Exactly-once input is not a portable default. Closing stdin and signaling also require honest effect/acknowledgment semantics.
- A signal receipt distinguishes requested from confirmed; confirmed delivery does not prove termination. Use observed process exit to confirm termination. Never replace unsupported process signaling with whole-sandbox destruction.
- Aborting output/waiting or closing the client detaches local resources. Remote termination is explicit. A required process deadline must be natively enforceable or rejected; a client-side timer is not sufficient.

`ProcessInfo` should expose observed lifecycle, scope/generation and supported attachment behavior. `ProcessExit` should distinguish normal exit, signal termination and incomplete native evidence, separately from output availability. Exact retention budgets and wire streaming framing remain open design choices. Do not assume the current `StreamFrame` schema establishes an implemented streaming transport.

## Terminals

```ts
const terminal = await box.terminals.open({
  command: { kind: "argv", argv: ["/bin/sh"] },
  size: { columns: 100, rows: 30 },
});
await terminal.write(inputBytes);
await terminal.resize({ columns: 120, rows: 40 });
await terminal.close();
```

A PTY has one combined output stream and can transform bytes according to terminal settings. It must not be presented as binary-faithful separate stdout/stderr capture. Resize and terminal-mode capabilities are explicit. Shell availability is image-specific; do not silently replace the requested command.

Define `close()` as closing the native terminal session, reporting confirmed/unknown outcome and any process consequences. Local subscription cancellation only detaches. Reconnection and concurrent attachment are optional capabilities. Terminal input and resize mutations share the uncertain-delivery rules above; replaying keystrokes after a connection loss is unsafe.

## Endpoints and tunnels

```ts
const endpoint = await box.endpoints.create({
  port: 3000,
  access: "authenticated",
  expiresInSeconds: 900,
});
const grant = await endpoint.grant({ expiresInSeconds: 60 });
await grant.revoke();
await endpoint.delete();

const tunnel = await box.tunnels.open({ port: 5432 });
const listener = await tunnel.listen({ hostname: "127.0.0.1", port: 0 });
await listener.close();
await tunnel.close();
```

Endpoints default to authenticated access. Public access requires an explicit request; missing authentication support cannot silently produce a public URL. A grant must be limited to the requested resource/port and lifetime. Credentials or signed access URLs are sensitive values returned separately from serializable metadata; they do not belong in recovery references or generic logs. If a provider cannot enforce requested expiration or revocation, reject those requirements rather than implying them.

Expose transport limitations such as HTTP-only access, WebSocket support, or raw TCP independently. An HTTP preview URL is not a TCP tunnel. Endpoint deletion must report which access is confirmed disabled; it cannot claim revocation of untracked native URLs. Port readiness is separate from endpoint provisioning. An existing endpoint does not prove a server is listening.

Tunnel listeners live in the SDK caller's Node.js/Bun process and bind loopback by default. A non-loopback bind is explicit. A remote service client must use an authorized service/provider session, never receive account-wide provider credentials. Stream authorization must bind to the project, sandbox generation, port and session lifetime; metadata permission alone does not grant byte access.

Closing a listener releases its local socket. Closing a tunnel also releases its native session where applicable, reporting uncertain remote closure. Neither destroys compute or stops the server process. A library must not advertise revocation guarantees stronger than the native transport can establish.

## Provider differences and lifecycle integration

Reuse request-specific capability evaluation from state portability, with independent checks for process start/discovery, live output/replay, stdin, each signal, PTY, endpoint access, revocation and tunnel protocols. Account, image and sandbox state can affect support. Structural optional methods alone cannot establish guarantees.

Unsupported requests fail before mutation with `UNSUPPORTED`. Failed eligibility reads remain unknown/unavailable. No implicit shell-based process supervisor, hidden proxy deployment, network widening, or automatic provider switch. Any later emulation requires a separately specified contract and explicit selection.

Snapshot/suspend/restore can interrupt processes, subscriptions and access sessions. Bind attachments to execution generations and expose interruption rather than silently reconnecting to a different workload. A memory restore may contain a process, but does not automatically restore its former authenticated stream or endpoint grants. Reauthorize and verify identity before attachment. Reads and reattachment must not auto-resume a sandbox; use the explicit lifecycle API.

Both direct and service clients use the same adapter contracts. The service may persist operation and access metadata, but an open socket is not restart-durable. Expose retained replay only where actual stored output/native evidence supports it. Durable start admission does not make the running process immortal.

## Work needed before implementation

1. Verify pinned native process/PTY/access APIs and retry behavior for the adapters in scope. Publish a per-operation matrix; this draft makes no provider support claims.
2. Set output buffer/capture limits, cursor retention and slow-consumer behavior; choose the service wire transport and its authorization/reconnect rules.
3. Finalize process exit/input/signal receipts and generation-bound references. Decide which mutations can be observed after a lost acknowledgment and which must remain unknown.
4. Specify endpoint-grant expiry/revocation and tunnel closure guarantees, including what survives service or client restart.

Acceptance fixtures must cover one start after lost response, binary output and stream gaps, bounded slow consumers, stdin uncertainty without replay, EOF, unsupported/acknowledged signals, PTY resize/closure, expired cursors, PID/generation reuse, unauthorized attachments, scoped grants, failed revocation, and snapshot/suspend interruption. Run direct/service parity and native-boundary attempt counts. Provider specs, UI work, broad filesystem expansion and observability are outside this draft.
