# Provider driver design and research

Draft 0.3 · Research-backed design targets; no adapter has passed live conformance yet

## First real adapter implementation wave

Modal and Daytona were selected first on September 26, 2026. This Daytona adapter implements the verified shared resource subset for direct TypeScript and the service; Modal integration follows in a separate child stack. Registration takes provider credentials plus explicit native configuration, verifies scope through read-only native calls, and returns a driver lease. Service connections encrypt credentials and pin the verified native scope and endpoint; direct callers hold credentials in their own process. Daytona status is implemented and fixture-tested until separately authorized live qualification. OCI builds, retained snapshots, volumes, accounting, registry publication and production deployment are outside this initial adapter slice.

The provider lease distinguishes caller-owned and borrowed drivers. Releasing an owned lease cleans only local transport state. It never destroys remote compute and never authorizes replay of an uncertain mutation. A capability check cannot implicitly create an app, snapshot, image or paid sandbox.

Refined contracts: [storage/images](storage-and-images.md), [observability/accounting](observability-and-accounting.md), and [security/operations](contract-recommendations.md). The selected runtime and persistence model are described in [architecture](design.md).

## Integration architecture

Provider packages implement translation once for both direct TypeScript and service execution; the SPI keeps provider semantics separate from the selected Bun/Hono and SQL implementation. Provider drivers must not depend on service authentication, SQL rows or durable scheduling. See the accepted [direct SDK design](direct-typescript-sdk.md). Native inputs and normalized driver results require runtime schemas; TypeScript interfaces alone are insufficient. Keep the mandatory execution interface small. Optional driver presence is necessary but insufficient for a capability: a request-specific prepare/inspect step must check scope, region, runtime, image, resources, mounts, and account enablement.

The baseline compute adapter implements `prepare`, `create`, `inspect`, `destroy`, `exec`, `readFile`, and `writeFile`. Drivers may return completed results or durable operation tokens. Any pending/ambiguous operation requires an explicit observation/reconciliation path; lack of reconciliation must surface as unknown rather than automatic replay.

## Driver catalog

Names and methods below express responsibilities; the exact SPI schema is not finalized.

| Driver | Responsibilities and contract boundaries |
|---|---|
| OperationDriver | Observe/reconcile submitted mutations without resubmitting them |
| InventoryDriver | Paginated discovery, filters, native identity/scope, labels where supported; distinguish discovered from managed/adopted resources |
| FileSystemDriver | Optional list/stat/mkdir/move/remove/permissions and streaming above binary core |
| ProcessDriver | Start/attach, stdin, wait, signal, output replay/gaps; process-start ambiguity joins the durable operation model |
| TerminalDriver | PTY open/input/output/resize/close; combined output and explicit closure effects |
| LifecycleDriver | Suspend/resume and optional stop/start/archive/recover/resize, each with explicit effects |
| CheckpointDriver | Capture/inspect/restore/delete with preservation, disruption, retention, and mount scope |
| ForkDriver | Native child creation; composition only when checkpoint+restore satisfies the same contract |
| NetworkDriver | Validate/apply/inspect supported ingress and egress policy semantics |
| CredentialBindingDriver | Bind/revoke credentials with declared delivery visibility, scope, and lifecycle |
| ImageDriver | Import/build/resolve/inspect/delete provider-prepared artifacts from OCI/context/native sources and observe build operations; logs where supported |
| PoolDriver | Configure/inspect/resize/drain and acquire with honest warm guarantees |
| EndpointDriver | Expose services and manage scoped grants, expiration, and revocation |
| TunnelDriver | Authenticated byte channel to a port; SDK owns its local listener |
| StorageDriver | Persistent storage create/inspect/delete, mount descriptors, consistency/durability characteristics |
| VolumeVersionDriver | Optional version/history/historical reads/fork with per-mount durability barriers; not a universal global-writer snapshot |
| MountDriver / MountBridge | Manage attachment/session flush/refresh/checkpoint/detach; verify the exact compute/storage pairing |
| ProviderEventDriver | Verify signatures, decode and normalize events; endpoint registration only if an API supports it |
| TelemetryDriver | Optional metrics/log readers and explicitly authorized export configuration; bounded telemetry is not billing authority |
| AccountingDriver | Read verified billing scope, meters/rates, and source usage/charge records; centralized dedupe, allocation, and corrections |
| DesktopDriver | Optional screenshots, pointer/keyboard, display/recording/accessibility as separate capabilities |
| InterpreterDriver | Optional persistent language contexts, rich results, interruption and context cleanup |

Secret resolution/storage is a service concern, distinct from native credential binding. Runtime catalogs expose supported OS, architecture, accelerator, isolation, and region constraints; GPU presence does not require a separate generic GPU driver. Quota is not live available capacity.

## Daytona and Tensorlake findings

### Warm pools

Daytona automatically claims matching warm sandboxes during ordinary creation. Matching is constrained by snapshot, region, default resources/user, and absence of custom environment variables, volumes, and secrets. Tensorlake exposes explicit pool claims; configuration is inherited from the template and mounts may be supplied at claim time. A Tensorlake claim can cold-start if warm capacity is unavailable.

Sandbar should express `warm: preferred | required`, acquisition/template constraints, and native-versus-composed allocation behavior. An adapter unable to guarantee warm allocation must reject required. Do not offer return-to-pool reuse of dirty sandboxes without a separately verified reset contract.

Sources: [Daytona pools](https://www.daytona.io/docs/en/warm-pools/), [Tensorlake pools](https://docs.tensorlake.ai/sandboxes/pools).

### Images and storage

Both providers document image preparation workflows. Keep builds/imports separate from runtime checkpoint capture. Daytona persistent volumes use object-storage-backed FUSE and document limitations for workloads requiring block storage. Tensorlake Cloud Volumes add asynchronous persistence, version history, snapshots, and forks, and document mounts outside Tensorlake compute.

Storage should be selectable independently of compute, but every mount pairing requires validation. Basic persistent storage must not be forced to implement snapshots/forks merely to satisfy a universal workspace interface. Preserve a distinction between current writable state, retained historical version, and whole-sandbox checkpoint.

Sources: [Daytona builder](https://www.daytona.io/docs/en/declarative-builder/), [Tensorlake images](https://docs.tensorlake.ai/sandboxes/images), [Daytona volumes](https://www.daytona.io/docs/en/volumes/), [Tensorlake Cloud Volumes](https://docs.tensorlake.ai/filesystems/introduction).

### Access and transport

Daytona ordinary preview tokens and signed URLs have different scope; signed URLs are bound to a port and support expiration/revocation. Tensorlake tunnels connect a local TCP listener through an authenticated WebSocket to a sandbox port without public exposure.

Represent preview grants separately from private tunnels. Redact access URLs. Standardize service-side session authorization and implement local listeners in each SDK. Provider credential scope must not leak through the portable endpoint response.

Sources: [Daytona previews](https://www.daytona.io/docs/en/preview/), [Tensorlake tunnels](https://docs.tensorlake.ai/sandboxes/tunnels).

### Fleet, events, and observability

Daytona documents resource listing/labels, lifecycle events, and OpenTelemetry collection. Tensorlake documents signed project-scoped webhooks with at-least-once, unordered delivery, stable event IDs, and source ordering metadata.

Events feed reconciliation. Verify before processing; deduplicate, preserve source revision where provided, acknowledge only durable acceptance, and recover gaps with inspection/polling. Native webhook configuration may require operator setup rather than an API. Sandbar tracing is available independently of optional provider telemetry.

Sources: [Daytona sandboxes](https://www.daytona.io/docs/en/sandboxes/), [Daytona webhooks](https://www.daytona.io/docs/en/webhooks/), [Daytona OTEL](https://www.daytona.io/docs/en/observability/otel-collection/), [Tensorlake webhooks](https://docs.tensorlake.ai/platform/webhooks/overview).

### Security, credentials, and lifecycle

Normalize network policy meaning, not similarly named fields. Domain versus CIDR enforcement, allow/deny precedence, internal routes, authenticated ingress, and policy mutation differ. Reverify current provider behavior before implementing NetworkDriver; do not treat these notes as a completed security capability matrix.

Distinguish in-sandbox environment/file credentials from external request credential injection. Verify supported modes per account/runtime. Captured files or memory may retain prior values; restoring a checkpoint requires an explicit binding decision rather than a blanket claim that credentials were rotated.

Daytona documents multiple lifecycle transitions and runtime/resource options. Tensorlake resource changes and restart behavior need their own mapping. Preserve native stop/recovery/retention semantics; never equate release of compute with permanent erasure.

Sources: [Daytona network limits](https://www.daytona.io/docs/en/network-limits/), [Daytona secrets](https://www.daytona.io/docs/en/secrets/), [Tensorlake networking](https://docs.tensorlake.ai/sandboxes/networking), [Tensorlake lifecycle](https://docs.tensorlake.ai/sandboxes/lifecycle). Exact API versions and account availability are implementation verification tasks.

### Optional higher-level tools

Both document computer-use interfaces; accessibility and recording should remain granular capabilities. Daytona documents stateful Python interpreter contexts distinct from repeated process execution.

Daytona Git helpers operate on repositories in a sandbox. Tensorlake also offers a hosted repository/storage system with different publication semantics. A future RepositoryProvider can model hosted repositories; ordinary Git, LSP, browser tooling, agent frameworks, and MCP do not become mandatory sandbox drivers.

Sources: [Daytona desktop](https://www.daytona.io/docs/en/computer-use/), [Tensorlake desktop](https://docs.tensorlake.ai/sandboxes/computer-use), [Daytona execution](https://www.daytona.io/docs/en/process-code-execution/), [Daytona Git](https://www.daytona.io/docs/en/git-operations/), [Tensorlake Git](https://docs.tensorlake.ai/git/introduction).

## Provider kit and onboarding

Provide shared schema validation, operation result constructors, bounded polling, error/effect mapping, byte capture, verified shell-argument encoding, redacted tracing, and checkpoint+restore composition helpers. Keep helpers independent of native SDKs.

1. Declare a provider instance schema and supported API versions.
2. Implement core operations against an injected transport for deterministic tests.
3. Map one tested environment and its resource, network, isolation, and lifecycle constraints.
4. Pass shared failure and semantics fixtures.
5. Run an opt-in live suite with an explicit spending budget, TTLs, resource labels, and cleanup.
6. Add optional drivers with conformance cases for each claimed guarantee.
7. Publish tested runtime/account assumptions, limitations, and verification date.

E2B and Modal remain first-class targets. Their complete current capability mapping is pending the implementation research pass; this document does not imply parity with Daytona or Tensorlake.
