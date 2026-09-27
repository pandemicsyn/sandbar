# Sandbar architecture

Draft 0.3 · September 26, 2026 · Recorded baseline, not an implemented service

## Current status

V1 is confirmed self-hosted and includes a management UI for provider keys, fleet management, and related settings. The user reopened the Worker/celld runtime decision and explicitly requested strategy documentation before selecting an alternative. The topology below remains the recorded baseline; no Hono/Bun retooling has been adopted.

The refined behavioral proposals are [contracts](contract-recommendations.md), [storage/snapshots/images](storage-and-images.md), [observability/accounting](observability-and-accounting.md), and [management UI](management-ui.md). These take precedence for API semantics; the runtime discussion remains separate.

## Purpose and decisions

Sandbar provides a consistent control API over sandbox providers while preserving differences in isolation, lifecycle, storage, snapshots, networking, and credentials. Initial provider targets are Daytona, E2B, Modal, and Tensorlake.

Product requirements and recorded architecture direction:

- Implement the service in TypeScript. The recorded Worker programming model is under architecture review.
- The recorded deployment proposal is Cloudflare and self-hosted celld; qualify actual runtime targets after the architecture discussion.
- The recorded state proposal uses SQLite-backed Durable Objects with no D1 dependency. A server/SQL alternative has been raised but not selected.
- Ship the management UI and dynamic write-only provider connection configuration in self-hosted v1.
- Expose a language-neutral HTTP/JSON API specified with OpenAPI, plus separately specified streaming protocols.
- Treat TypeScript, Rust, and Python as first-class SDKs. Generate wire models and transport plumbing; hand-write ergonomic public APIs.
- Implement provider integrations once in the service. Clients do not replicate routing, reconciliation, or policy enforcement.
- Keep a small mandatory provider core and optional capability drivers.
- Fail unsupported guarantees explicitly. Never silently weaken a requested policy during fallback.

An embedded TypeScript core remains possible. The recorded durable runtime is the Worker service, hosted or local; deployment support remains subject to the pending architecture decision. Direct SDK-only execution must not imply durable cross-process coordination.

## Resources and boundaries

| Resource | Meaning |
|---|---|
| Provider instance | A configured provider account/project/region scope with a stable Sandbar ID |
| Environment | Versioned logical recipe mapped to prepared provider artifacts |
| Sandbox | Logical execution resource, mapped to one native provider resource |
| Operation | Durable record of a requested mutation and its known outcome |
| Checkpoint | Captured sandbox state with explicit filesystem/memory and mount boundaries |
| Storage/workspace | Independently owned persistent files and optional version history |
| Pool | Capacity and allocation policy for fresh sandbox acquisition |
| Endpoint/session | Authorized access to a service, process, terminal, or tunnel |

Environment images, runtime checkpoints, suspended sandboxes, and workspace versions are different resources. A filesystem snapshot does not imply process memory preservation. A VM checkpoint does not imply an atomic snapshot of mounted storage. Native checkpoint portability is restricted to the verified provider scope.

## Service topology

| Component | Responsibility |
|---|---|
| API Worker | Authentication, project authorization, validation, HTTP routing, webhook ingress |
| SandboxDO, one per sandbox | Desired state, observed state, provider mapping, operation journal, idempotency records, durable outbox, cleanup deadlines |
| ProjectDO, one per project | Sandbox directory, searchable summary index, labels, provider configuration references, project-scoped creation routing |
| PoolDO, when implemented | Desired warm capacity and allocation coordination |
| Alarms | Durable follow-up, reconciliation, and outbox delivery |
| Queues, when justified | Bulk scans, fan-out, and asynchronous ingestion |
| Object storage, when justified | Large artifacts and retained output, not per-chunk lifecycle records |

Keep provider drivers separate from the storage implementation. Drivers perform provider operations; Durable Objects own operation progression and recovery.

### Ownership and indexes

SandboxDO is authoritative for Sandbar's intentions and operation history. Native inspection supplies observed provider reality. ProjectDO holds a queryable projection, so listings may lag individual resource detail.

Each DO has a private SQLite database. SQL cannot directly join across objects. A listing such as running sandboxes with a given label queries the project index instead of waking every sandbox.

Commit each sandbox state change and pending index event in one local transaction. Deliver through a durable outbox, retry until acknowledged, and apply idempotently in ProjectDO. Every sandbox event carries a monotonic revision; retain deletion tombstones sufficiently to prevent stale events resurrecting removed rows. Index delivery failure must not erase the pending event.

Creation idempotency must work before SandboxDO exists. ProjectDO durably maps a project-scoped idempotency key and canonical request hash to allocated sandbox/operation IDs, then dispatches through its own durable outbox. A retry resolves to the same IDs. Duplicate dispatch must be safe at SandboxDO. Anonymous creates still receive stable internal IDs before contacting a provider.

ProjectDO is a throughput and storage boundary. Begin with one per project; shard only when measurements justify it. Cross-project analytics may later use a separate read store. D1 would not remove the need for coordination with sandbox objects.

### Concurrency and operation recovery

DO request handlers can interleave at await points. Persist operation admission and conflict checks before external calls, using explicit revisions and operation state transitions. Do not hold a database transaction across network I/O or assume single-threaded execution makes an external mutation exactly-once.

Every mutation receives a stable operation ID before provider submission. Persist the intent and arrange durable recovery before acknowledging acceptance. A timeout after submission can mean the provider applied the action. Reconcile through a native operation ID, idempotency key, or provider-supported discovery; never repeat create or exec merely because its response was lost.

Represent queued, running, succeeded, failed, and unknown outcomes separately. Unknown is not permission to retry. Client cancellation of waiting or a disconnected stream does not prove a remote process stopped. Capability-specific cancellation is explicit.

### Streaming and data transfer

Coordinate and authorize sessions through the sandbox object. Carry file bytes, process output, and tunnel traffic through streams or scoped direct connections where supported. Avoid storing every chunk in the lifecycle database.

Use bounded buffers, backpressure, and explicit truncation/gap reporting. Reconnect with stable session and operation IDs. Log cursors can support replay only where output was retained. Reopening a tunnel cannot preserve the original TCP session.

SDK-local TCP listeners belong on the caller's machine. The service supplies authorization and the remote channel. Mount helpers and local executables likewise run in the caller, an optional helper, or a separate build/execution environment.

## Provider integration model

The mandatory adapter implements prepare, create, inspect, destroy, exec, readFile, and writeFile. Optional drivers cover inventory, processes, terminals, lifecycle, checkpoints, forks, networking, credentials, images, pools, endpoints, tunnels, storage, volume versions, events, telemetry, and accounting. The newer strategy separates Volume, Mount, VolumeVersion, and Checkpoint instead of a mandatory versioned-workspace interface. See [driver contracts](provider-drivers.md).

Drivers target fetch, WebSockets, Web Streams, and Web Crypto. Use vendor SDKs only after verifying their dependencies on both runtimes. Prefer direct provider APIs where a vendor SDK requires unsupported Node or native functionality. Provider adapters never choose another provider.

Capability evaluation is specific to the provider account, region, runtime, artifact, resources, mounts, and current state. Static feature booleans alone are insufficient. Plans report eligibility, implementation, enforcement location, source disruption, storage effects, and limitations. Execution revalidates mutable conditions.

Fallback is explicit and ordered. A definitive capacity rejection may allow another eligible candidate. An ambiguous submission requires reconciliation before any further allocation.

## Security and credential boundaries

Authorize every operation against a project and resource ownership. Logical IDs and native references are locators, not credentials. Resource IDs, plans, index entries, and traces must not expose provider keys or secret values.

Separate secret resolution from credential binding. A binding declares whether a credential is visible to sandbox code as an environment variable/file or injected outside the sandbox into scoped requests. These modes offer different guarantees and cannot silently substitute for one another.

Network policies distinguish egress from ingress and declare domain/IP/port semantics, precedence, DNS handling, enforcement location, and mutable-policy support. The adapter must prove an equivalent mapping or reject the request. Environment proxy variables alone are not mandatory egress enforcement.

Checkpoint, suspend, restore, fork, and pool allocation must account for credentials retained in files or process memory. Reauthorize bindings and state what rotation/revocation can actually guarantee; do not claim to scrub arbitrary captured memory. Shared URLs are scoped access grants and must be redacted from logs.

## Storage and lifecycle semantics

- Compute destruction does not delete separately owned storage or checkpoints.
- Destroy releases active compute; it is not certified data erasure. Report recovery windows and retained resources.
- Resume continues the logical sandbox under the promised preservation contract; restore creates a new sandbox.
- Fork independence applies to private captured state, not explicitly shared mounts or external services.
- Mount bridges validate the exact storage/compute pair, including runtime privileges, client availability, networking, and authentication.
- A workspace checkpoint requires a documented durability barrier. Single-session flushing is not a global multi-writer snapshot.
- Pinned workspace versions mount read-only initially; fork a version to obtain an independent writable branch.
- Atomic VM-plus-volume snapshots and cross-provider RAM migration are outside v1.

## Runtime portability

celld documents Worker, DO, D1, KV, Queue, R2, Workflow, and Cron support, with meaningful runtime differences. This is a target compatibility surface, not evidence that Sandbar already runs on both platforms.

Known design inputs: Node compatibility is partial; WebSocket transport does not migrate on cell-owner failover; cancellation signals do not transparently cross all RPC boundaries. Use explicit durable cancellation requests where appropriate. Pin runtime versions and run restart, failover, reconnect, and streaming tests on both deployment targets.

Local mode uses a local Worker-compatible service. Self-hosting also requires qualified durable object storage and operating the celld fleet; a local development store is not a production durability claim.

## Sources

- [Cloudflare SQLite-backed DO storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [celld overview and operations](https://celld.dev/docs/)
- [celld compatibility](https://celld.dev/docs/cloudflare-compat/)
- [celld Durable Objects](https://celld.dev/docs/services/durable-objects/)

Provider research sources are recorded in [provider-drivers.md](provider-drivers.md). Documentation was reviewed during the September 25–26, 2026 design discussion; capabilities still require live validation.
