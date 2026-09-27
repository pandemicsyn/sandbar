# Sandbar API and provider integration design

Draft 0.1 · September 25, 2026 · Proposed contracts, not an implemented SDK

## Decision

Build a TypeScript SDK with a small execution core and optional provider interfaces. Use the same core in a later local daemon or self-hosted gateway. Keep compute, reusable environments, sandbox checkpoints, and durable workspaces as separate resources.

The application chooses required behavior; an adapter translates that behavior into native operations. Unsupported guarantees fail before a mutation whenever they can be determined in advance. Dynamic capacity and races can still fail during execution. Never silently weaken memory preservation, network policy, storage isolation, or retention requirements.

The companion `sandbar-api.ts` is the proposed public API and provider SPI. It contains declarations only. Examples below show intended usage; package names are provisional.

## 1. The four resources

| Resource | Meaning | Portability |
|---|---|---|
| Environment | Versioned recipe/contract mapped to a prepared artifact on each provider | Application-level; each backend builds its own artifact |
| Sandbox | A running or suspended execution environment | Bound to a provider account/project and runtime |
| Checkpoint | Captured root filesystem, optionally with supported process memory | Native artifact bound to its provider scope |
| Workspace | Durable project files, independently mounted into compatible sandboxes | Depends on storage backend and verified mount compatibility |

A workspace version and a VM checkpoint are different types. A workspace version does not capture RAM, packages installed outside its directory, external services, or network connections. A VM checkpoint must declare how mounted storage is treated. Never assume that capturing a VM also atomically captures external volumes.

## 2. Application-facing API

### Configure adapters once

```ts
import { Sandbar } from "@sandbar/sdk";
import { daytona } from "@sandbar/provider-daytona";
import { e2b } from "@sandbar/provider-e2b";
import { tensorlake } from "@sandbar/provider-tensorlake";

const sandbar = new Sandbar({
  providers: [
    daytona({ id: "daytona-prod", apiKey: secrets.daytona }),
    e2b({ id: "e2b-prod", apiKey: secrets.e2b }),
    tensorlake({ id: "tensorlake-prod", apiKey: secrets.tensorlake }),
  ],
  environments, // versioned provider artifact mappings; see section 4
});
```

Provider instance IDs are stable configuration names. Registering two accounts or regions of one provider is supported. Credentials remain in provider configuration; resource references and traces never contain them. Factories should also accept an existing native SDK client for testing and application-managed authentication.

### Allocate and execute

```ts
const box = await sandbar.create({
  placement: { order: ["daytona-prod", "e2b-prod", "tensorlake-prod"] },
  environment: "coding-agent@3",
  resources: { cpu: 2, memoryMiB: 4096 },
  network: { outbound: "allow" },
  requirements: { checkpoint: "filesystem+memory" },
});

try {
  await box.files.write({ path: "/workspace/main.py", data: sourceBytes });
  const result = await box.exec({
    command: { argv: ["python", "/workspace/main.py"] },
    cwd: "/workspace",
    timeoutSeconds: 60,
    maxOutputBytes: 1_048_576,
  });
  // Nonzero exit is a command result, not a provider/network exception.
} finally {
  await box.destroy();
}
```

The router filters candidates by environment, account/runtime capabilities, resource constraints, policy, and mount compatibility. It selects the first eligible candidate. Fallback is initially explicit and ordered; latency/cost optimizers are a later policy module, not the default.

The baseline is Linux, bounded buffered execution, binary file read/write, inspect, create, and destroy. `argv` never interpolates a shell. An explicit `{ shell: "..." }` uses the adapter's declared POSIX shell. Adapters with shell-only native APIs must safely encode arguments and pass conformance fixtures, or reject argv execution.

`exec` has a process deadline. `CallOptions.deadlineMs` limits the caller's wait. An expired client wait or disconnected output stream does not prove the remote process stopped. Output caps bound collection without silently killing the process; truncation is reported. If an adapter cannot safely bound native buffered output, it must stream/spool through a helper or reject the request.

### Checkpoint and restore

```ts
const checkpoint = await box.checkpoint({
  preserve: "filesystem+memory",
  scope: { rootFilesystem: true },
  disruption: "pause",
  consistency: "caller-quiesced",
  retention: { minimumSeconds: 86_400 },
});

// Persist the ref plus descriptive metadata in the application's database.
const branch = await sandbar.restore(checkpoint.ref);
```

`preserve` is always explicit. The disruption value is the maximum accepted effect, ordered none < pause < stop < terminate. The adapter must explain the actual effect and resulting source state. Restoring creates a new sandbox; it does not rewind an existing handle. Resuming continues a suspended sandbox. Native checkpoints are never automatically routed to a different provider or account.

`caller-quiesced` means the caller has already stopped writes and flushed application buffers. It is an assertion, not a promise that Sandbar makes a database-consistent backup. `crash-consistent` is an acceptable lower-level capture contract where the provider actually supports it. Connection continuity is separate from process memory preservation.

Attached mounts are excluded from the requested root-only checkpoint contract. The adapter reports included/excluded paths and restoration behavior. It must reject a request if it cannot honor or determine the storage boundary. Warm restores that retain mounted filesystem clients require provider-specific validation; Sandbar must not assume detaching and remounting them is safe.

### Plan without mutating

```ts
const plan = await sandbar.plan({
  kind: "checkpoint",
  sandbox: box.ref,
  request: {
    preserve: "filesystem+memory",
    scope: { rootFilesystem: true },
    disruption: "pause",
    consistency: "caller-quiesced",
  },
});
```

Plans report eligibility, source disruption, connection effects, native vs. composed implementation, and policy enforcement location. Planning does not reserve capacity or authorize a weaker operation. Direct SDK calls perform the same validation internally. Execution revalidates state-sensitive conditions; a stale plan is informational, not a bypass token. Experimental features require both caller opt-in and successful runtime validation.

### Suspend, reconnect, fork

```ts
await box.suspend({ preserve: "filesystem+memory" });

// In another process, using the same configured provider instance and account:
const existing = await sandbar.connect(box.ref);
await existing.resume();

const child = await existing.fork({
  checkpoint: {
    preserve: "filesystem+memory",
    scope: { rootFilesystem: true },
    disruption: "pause",
    consistency: "caller-quiesced",
  },
  mounts: "reject-attached",
});
```

Connect only attaches a handle: it never creates or resumes a sandbox. Suspend preserves the requested state and stable logical identity; it cannot secretly destroy/recreate a sandbox. Filesystem-only suspension resumes by rebooting, while memory suspension requires supported process preservation.

Fork returns one independent child. Independence applies to captured private state, not shared external services or explicitly shared mounts. Default application examples reject attached writable storage. Native forks are preferred. A composed checkpoint-plus-restore fork is allowed only when its effects and guarantees satisfy the request; temporary artifact ownership and cleanup must be tracked. An uncertain restore must be reconciled before deleting an artifact it may still be using.

Multiple forks use explicit concurrent calls or a later batch API with one result per child. No all-or-nothing success claim for a partially completed batch.

### Optional process and terminal interfaces

`box.processes.start()` returns a process handle with byte streams, stdin, wait, and signals. Reattachment and output replay depend on provider support; missing data is reported as a gap. Byte chunks have no line or UTF-8 character boundary guarantee. Slow consumers require bounded buffering/backpressure. The core should drain native streams independently of whether the caller is currently reading, or clearly report a gap/disconnection.

`box.terminal.open()` exposes a PTY with resize and input/output. PTY output combines stdout and stderr; it is not an exec result. Closing the transport does not imply successful process termination. Provider adapters must document terminal closure behavior. Neither interface exposes a native SDK object as its portable return type.

## 3. Durable workspaces

```ts
const workspace = await sandbar.workspaces.create("tensorlake-storage");
const box = await sandbar.create({
  placement: { provider: "daytona-prod" },
  environment: "coding-agent@3",
  resources: { cpu: 2, memoryMiB: 4096 },
  network: { outbound: "allow" },
  mounts: [{ workspace: workspace.ref, path: "/workspace", access: "read-write" }],
});
const version = await workspace.checkpoint();
```

This is a target API, not a verified Daytona/Tensorlake integration. A mount bridge validates the specific compute/storage pair: OS, privileges, client installation, network access, versioning, and credential delivery. Reject unsupported combinations before boot when possible. A provider's broad portability claim is insufficient to advertise a tested pair.

A workspace checkpoint must wait for remote durability of writes from the mount session it owns. The initial contract requires a single owned writer, or all writers quiesced through application coordination. It cannot claim a global atomic multi-writer snapshot from one client's flush. If no reliable barrier exists, report unsupported rather than declaring durability.

Pinned workspace versions mount read-only in v1. For a writable branch, fork the version into a new workspace. Concurrent-write semantics remain explicit: last-writer-wins, disjoint-path merging, or unsupported. Compute destruction never deletes separately owned workspaces or checkpoints.

Do not implement an atomic combined workspace+VM checkpoint in v1. Later, an application-level recipe can quiesce writes, commit workspace versions, capture VM state, and save a manifest with both references. That is an orchestrated consistency protocol with failure recovery, not a universally atomic snapshot.

## 4. Environments and provider escape hatches

Keep a logical environment catalog, keyed by provider instance:

```ts
const environments = {
  "coding-agent@3": {
    "daytona-prod": {
      artifact: { snapshot: "coding-agent-v3" },
      revision: "build-2026-09-25.1",
      contract: { os: "linux", arch: "amd64", workingDirectory: "/workspace" },
    },
    "e2b-prod": {
      artifact: { template: "coding-agent-v3" },
      revision: "build-2026-09-25.1",
      contract: { os: "linux", arch: "amd64", workingDirectory: "/workspace" },
    },
  },
};
```

Artifact schemas belong to adapters; adapter factories provide typed builders and runtime validators. Production bindings should resolve mutable names to immutable artifact identifiers when available. The environment contract must be tested, not assumed from equal names. A later build tool can produce these bindings from one recipe; image-building is not required to ship the execution SDK.

Provider-specific options are accepted only when placement is pinned. They are schema-validated and cannot override normalized policy secretly. Provider-specific helpers live in the corresponding adapter package, retain native types, and are visibly outside the portable contract. Avoid an untyped `native` object on every sandbox.

## 5. The small provider core

A basic adapter implements seven methods:

| Method | Responsibility |
|---|---|
| `prepare` | Read-only validation and effects for a resolved action |
| `create` | Provision, returning a normalized result or operation token |
| `inspect` | Fetch current state, scope, configuration, and capabilities |
| `destroy` | Stop compute, report retained resources and recoverability |
| `exec` | Bounded command execution with explicit deadline behavior |
| `readFile` | Bounded binary file read |
| `writeFile` | Binary file write with honest completion semantics |

Core handles registration, environment resolution, routing, plan aggregation, validation, wait loops, standard errors, tracing, and resource handles. Adapters translate native SDK/HTTP behavior. An adapter never selects another provider.

```ts
const acmeProvider: ComputeProvider = {
  id: "acme-prod",
  name: "acme",
  apiVersion: "sandbar.provider.v1",
  prepare, create, inspect, destroy, exec, readFile, writeFile,
  // Add only what is implemented and verified:
  checkpoints: acmeCheckpoints,
  lifecycle: acmeLifecycle,
};
```

Optional interfaces are separate modules:

| Interface | Operations |
|---|---|
| `CheckpointDriver` | Capture, inspect, restore, delete |
| `LifecycleDriver` | Suspend, resume |
| `ForkDriver` | Native independent child creation |
| `OperationDriver` | Observe/reconcile submitted mutations |
| `ProcessDriver` | Start, attach, stream, signal |
| `TerminalDriver` | PTY open, input/output, resize, close |
| `WorkspaceProvider` | Create, inspect, checkpoint, fork, delete durable storage |
| `MountBridge` | Validate and prepare a particular compute/storage combination |

No optional implementation means unavailable. Presence alone does not establish support for every configuration. `prepare()` and `inspect()` refine availability for account, SDK/API version, region, runtime, image, resources, current state, mounts, and feature rollout. Store restrictions as structured fields where routing needs them; descriptive strings are for explanations only. The prototype contract leaves provider-specific restrictions descriptive; implement structured constraints as each operation lands.

## 6. Async operations, retries, and identity

Every mutation starts with a Sandbar operation ID. Driver results are `succeeded`, `pending`, `failed`, or `unknown`. Providers returning pending tokens implement `operations.observe()`. An adapter that cannot reconcile ambiguity may return unknown and leave the operation unresolved; the core must never reissue it just to obtain a result.

SDK convenience methods wait for the final result. On deadline or transport loss, a public error carries a serializable recovery token and effect classification. The next implementation pass should expose `sandbar.operations.inspect/reconcile()` using that token and a JSON-safe result union. The current TypeScript file defines the SPI token but deliberately does not claim a finished public durable-operations API.

| Situation | Behavior |
|---|---|
| Read-only lookup failed transiently | Retry with bounded exponential backoff and jitter |
| Create definitively rejected for capacity | May try the next eligible provider |
| Create response lost after submission | Reconcile; no automatic second allocation |
| Command response lost | Execution outcome unknown; do not rerun |
| Checkpoint partly completed | Inspect artifact and source before retry/cleanup |
| Provider rejected a policy | Fail; do not weaken it for fallback |
| Nonzero process exit | Return exit result |
| Destroy acknowledged | Report compute stopped and native retention separately |

An idempotency key is a request, not a guarantee. Use native idempotency when available; otherwise a durable gateway ledger can coordinate participating clients. It cannot repair arbitrary native exactly-once gaps. Scope keys by tenant, provider instance, operation, and canonical request hash; reject reuse with different input. SDK-only mode makes no cross-process deduplication promise without a shared store.

Resource references include kind, stable provider instance, verified account/project scope, and native ID. They survive client restarts and contain no credentials. A gateway wraps them in authorized logical IDs and validates ownership on every request; a resource ID is not authority to access it. Native IDs supplied by a caller must not bypass scope checks.

v1 public `destroy()` means cease execution and release active compute. It is not a certified data erasure operation: provider recovery windows, snapshots, logs, and storage retention remain explicit. This matters for Tensorlake's documented restart window. A future purge capability would need a stronger contract.

## 7. Shared adapter helpers

Provide these in `@sandbar/provider-kit` so adding a provider does not mean rebuilding the SDK:

- `defineProvider`: version/schema validation and capability/interface consistency checks.
- `completed` / `pending` / `unknown`: typed operation result constructors.
- `pollOperation`: bounded polling with native retry hints, jitter, deadline, and cancellation.
- `mapError`: provider error mapping with effect classification; preserve redacted native codes.
- `collectOutput`: bounded byte capture from native process streams.
- `quotePosixArgv`: shared, tested bridge for shell-only execution APIs.
- `composeFork`: checkpoint+restore with ownership, partial-failure, and cleanup tracking.
- Trace hooks: creation latency, ready latency, command outcome, source disruption, provider error, and cleanup outcome.

Trace payloads exclude file contents, command env, credentials, signed URLs, and command output by default. User-requested command content logging is a separate opt-in. Polling and cleanup continue only while a runtime owns them; provider-enforced expiration protects against client death where supported.

Helper names are design targets, not implemented exports. Keep helpers independent of any particular provider SDK.

## 8. Provider onboarding workflow

1. Create a small package from a provider template; pin supported native SDK/API versions.
2. Implement the seven core methods and error mapping using an injected native client.
3. Map one known Linux environment and document resource/lifecycle/network semantics.
4. Run the deterministic provider contract fixtures with a fake client.
5. Run an opt-in real-provider smoke suite with a spending cap, labels, TTL, and cleanup.
6. Add optional interfaces one at a time, with semantic fixtures for each claim.
7. Publish a manifest with adapter version, tested runtimes/regions, known limitations, and last verified date.

A provider doesn't need snapshots, GPUs, desktop control, pools, or volume mounts to join. A requirement that needs a missing feature simply excludes it from that allocation.

Conformance should verify behavior, not just matching method names:

| Suite | Meaningful checks |
|---|---|
| Core | Binary files; cwd/env/argv escaping; nonzero exits; bounded output; inspect/reconnect; repeated destroy |
| Failure | Lost create response; ambiguous command execution; deadline without assumed kill; partial cleanup; auth vs. capacity |
| Checkpoint | Modified root file survives; process counter survives only in memory mode; source disruption; expired ref; excluded mounts |
| Suspend | Identity stable; preservation verified; unsupported mode rejected before side effects |
| Fork | Children private writes diverge; shared mounts explicit; no leaked temporary artifacts |
| Streams | UTF-8 split boundaries; backpressure; lost connection; replay gap; signal result |
| Workspace | Remote durability barrier; pinned immutable versions; fork isolation; multi-writer rules |
| Policy | Unsupported outbound restriction rejected; actual enforcement observed; no silent idle/lifetime conversion |

Do not label an adapter supported merely because create and exec succeeded. Report levels independently: core verified, checkpoint verified, lifecycle verified, and so on.

## 9. Initial provider mapping

These are documentation-derived implementation notes, not live-tested certifications. Reverify against the adapter's pinned SDK and actual account before declaring support.

| Provider | Adapter design consequence |
|---|---|
| Daytona | Distinguish container and VM runtime capabilities. Cold/hot checkpoint requirements differ; some cold captures require stopped state. Resolve those effects before capture. |
| E2B | Distinguish pause/resume of one sandbox from reusable snapshots. Snapshotting interrupts active client connections even when the source resumes afterward. |
| Modal | Filesystem snapshots exclude mounted volumes. Experimental memory snapshots have source-termination, process, retention, and restore restrictions; treat them as opt-in. |
| Tensorlake | Explicit filesystem vs. memory checkpoint selection; memory restore restricts configuration changes. Native copy can avoid temporary checkpoint artifacts. |

Sources: [Daytona snapshots](https://www.daytona.io/docs/snapshots/), [Daytona persistence](https://www.daytona.io/docs/en/persistence/), [E2B snapshots](https://docs.e2b.dev/sandbox/snapshots), [Modal snapshots](https://modal.com/docs/guide/sandbox-snapshots), [Tensorlake snapshots](https://docs.tensorlake.ai/sandboxes/snapshots).

Tensorlake also distinguishes named suspendable sandboxes from ephemeral ones, and idle timeout from wall-clock lifetime. Its volume storage can be integrated separately from compute. Sources: [Tensorlake lifecycle](https://docs.tensorlake.ai/sandboxes/lifecycle), [Cloud Volumes](https://docs.tensorlake.ai/filesystems/introduction), [mounts](https://docs.tensorlake.ai/sandboxes/mount-filesystems).

## 10. Deployment and package boundaries

```text
Application / CLI / local daemon / HTTP gateway
                     |
                 @sandbar/sdk
      routing · validation · handles · operation waits
                     |
              @sandbar/provider-kit
                     |
   Daytona     E2B      Modal      Tensorlake      others

Workspace providers + mount bridges are optional adjacent modules.
```

Proposed packages: `@sandbar/sdk`, `@sandbar/provider-kit`, one package per compute provider, `@sandbar/workspace-tensorlake`, `@sandbar/cli`, and later `@sandbar/gateway`. Compute adapters do not depend on one another. Provider-kit conformance fixtures can be a separate dev-only export.

The SDK calls providers directly. Durable sandbox/checkpoint refs live in the application's database. It does not require a daemon. A daemon or gateway adds a persistent operation ledger, reconciliation, credential scoping, quotas, and provider-independent cleanup. If a policy relies on that service staying alive, its enforcement is reported as gateway-managed; SDK-only mode cannot promise it survives process death.

Later HTTP shape: POST `/v1/sandboxes`, GET `/v1/sandboxes/:id`, POST `/v1/sandboxes/:id/exec`, POST `/v1/sandboxes/:id/checkpoints`, POST `/v1/checkpoints/:id/restore`, POST `/v1/sandboxes/:id/suspend`, POST `/v1/sandboxes/:id/resume`, DELETE `/v1/sandboxes/:id`, and GET `/v1/operations/:id`. Long mutations return operation IDs. Streams use explicitly negotiated transports. Files use binary bodies; byte arrays and live handles are not blindly serialized as JSON.

## 11. Build sequence and open decisions

First vertical slice: contracts/schema + provider-kit, then core create/exec/files/destroy across all four providers. Next: explicit root filesystem and memory checkpoint modes where verified, restore, and capability planning. Then: suspend/resume and native/composed fork. Add workspace storage/mount bridges and the durable gateway once core semantics have passed live tests.

Resolve during implementation:

- Canonical JSON schemas and generated Python models; TypeScript is the initial reference.
- Public operation recovery interface and durable store adapter, including process-start uncertainty.
- Exact distinction between native policy guarantees and best-effort timers in each provider.
- Provider-specific memory snapshot limits, retention, mounted-filesystem behavior, and capture consistency.
- Authentication delivery for external mounts without storing secrets in resource refs or plans.
- Large file streaming and directory operations beyond the bounded binary core.

Avoid promising cross-provider RAM migration, transparent replay of arbitrary commands, atomic VM+volume snapshots, universal GPU snapshots, or identical isolation from every backend. Those would be separate verified capabilities.
