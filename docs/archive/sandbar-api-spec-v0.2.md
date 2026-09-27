# Sandbar public API specification

Draft 0.2 · Proposed contract · Not yet a complete OpenAPI document

## Contract strategy

Use versioned HTTP routes and JSON for control operations. OpenAPI is the canonical wire specification once implementation starts; examples and SDK models must derive from or be validated against it. Specify streaming frame schemas separately. Do not generate OpenAPI from a bespoke TypeScript SDK's live handles, iterators, or byte arrays.

The service owns placement, policy, provider authentication, durable operations, and reconciliation. SDKs own ergonomic resource handles, language-native iteration, cancellation of waiting, local tunnel listeners, and convenient operation waiting.

First-class clients:

| SDK | Public design target |
|---|---|
| TypeScript | Promise-based handles, AsyncIterable output, AbortSignal, Uint8Array |
| Rust | Typed builders/enums/errors, async streams, owned resource handles and explicit cleanup |
| Python | Async API with ergonomic context managers; scope of synchronous facade to be decided |

Generate transport models, serialization, and low-level requests internally. Keep the public surface hand-written and idiomatic. Resource cleanup helpers are best effort when a process exits; provider TTLs and durable service policies provide the stated lifecycle guarantees. Dropping a Rust value must not imply a completed remote destroy.

## Identity and authorization

All resources have opaque logical IDs and a verified project scope. Server-internal provider references include provider instance, native account/project scope, native resource ID, and schema version. Do not accept caller-supplied native IDs as authorization.

Each request authenticates to Sandbar, not directly to every provider. Exact token issuance/identity-provider integration remains an implementation decision. Provider credentials are resolved server-side through configured references; they do not appear in resource responses.

## Proposed routes

All routes below are scoped under `/v1/projects/{projectId}`. Route names are provisional until OpenAPI review.

| Method and relative route | Purpose |
|---|---|
| `POST /sandboxes` | Validate and submit creation |
| `GET /sandboxes` | Paginated project index; filter by declared labels/state/provider |
| `GET /sandboxes/{id}` | Sandbox detail, desired/observed state, freshness |
| `DELETE /sandboxes/{id}` | Submit compute destruction |
| `POST /sandboxes/{id}/exec` | Submit bounded command execution |
| `POST /sandboxes/{id}/processes` | Start an optionally attachable process |
| `POST /sandboxes/{id}/checkpoints` | Capture explicit filesystem/memory state |
| `POST /checkpoints/{id}/restore` | Create a new sandbox from a checkpoint |
| `POST /sandboxes/{id}/suspend` | Suspend under an explicit preservation contract |
| `POST /sandboxes/{id}/resume` | Continue a suspended sandbox |
| `POST /sandboxes/{id}/fork` | Create one independent child within declared storage scope |
| `GET /operations/{id}` | Inspect an operation and its recovery state |
| `POST /operations/{id}/cancel` | Request cancellation only where the operation supports it |
| `POST /plans` | Read-only capability/effect planning |
| `GET /sandboxes/{id}/files?path=...` | Stream a file as binary content |
| `PUT /sandboxes/{id}/files?path=...` | Write binary content with explicit completion semantics |

Directory operations, environment management, pools, storage, credential bindings, access grants, and provider registration receive schemas as their drivers are implemented. Reserve no promise that every proposed route ships in the first vertical slice.

## Creation request

Conceptual fields:

- `placement`: pinned provider instance or explicit ordered candidates.
- `environment`: versioned logical environment ID.
- `resources`: CPU, memory, optional disk; runtime OS/architecture and accelerators are capability constraints.
- `requirements`: necessary preservation, isolation, streaming, and storage guarantees.
- `network`: explicit policy reference or inline policy with declared semantics.
- `credentialBindings`: authorized secret references and delivery modes, never echoed secret values.
- `mounts`: storage IDs, target paths, access modes, optional pinned versions.
- `lifecycle`: maximum lifetime and precisely defined idle behavior.
- `labels`: searchable metadata with documented limits.
- `allocation`: optional pool and warm preference/requirement.
- `providerOptions`: versioned validated extension, accepted only for pinned placement.

Resolve environments to immutable provider artifacts when possible. Equal image names do not establish equivalent environments. Unsupported constraints fail during planning where determinable; capacity and concurrent changes can still fail during execution.

## Durable operation protocol

Asynchronous mutation acceptance returns HTTP 202 with a stable operation resource and `Location`. Acceptance means the intent and recovery scheduling were durably recorded, not that the native mutation completed. SDK conveniences wait on this resource; callers may explicitly request a handle without waiting.

An operation contains:

- `id`, `projectId`, `kind`, and logical target IDs.
- `status`: queued, running, succeeded, failed, or unknown.
- Creation/update timestamps, attempt metadata, and the known provider-submission phase.
- A typed JSON-safe result, or output/artifact references for binary/large data.
- A redacted error with standardized code, effect classification, and safe retry guidance.
- Available recovery/cancellation actions and optional retry-after hints.

Use idempotency keys scoped to the authenticated project and operation endpoint. Store the canonical request hash and reject reuse with different input. Persist create-key routing before contacting a provider. Retention and expiry of idempotency records must be documented before release.

| Situation | Required behavior |
|---|---|
| Definitive read-only transient error | Bounded retry with jitter |
| Create rejected before effect due to capacity | May try another eligible candidate |
| Create/exec response lost after submission | Unknown until reconciled; do not replay automatically |
| Caller deadline elapsed | Stop waiting; report operation ID and known effect |
| Nonzero command exit | Successful delivery of a command result, not a provider error |
| Cancellation requested | Report whether cancellation is supported, requested, or confirmed |
| Destroy succeeded | Report stopped compute and retained/recoverable resources separately |

Errors distinguish invalid argument, unsupported behavior, authentication/authorization, not found, conflict, capacity, rate limit, expiration, unavailability, timeout, output limit, unknown outcome, and internal failure. Native codes may be retained after redaction.

## Execution and files

Commands distinguish literal argv from explicitly requested shell interpretation. Shell-only providers must use verified encoding or reject literal argv. Define cwd, environment, process deadline, output budget, exit code, signal, timeout outcome, and truncation explicitly.

A process deadline differs from a client waiting deadline. An output budget bounds collected output without silently terminating the process. Provider implementations must avoid unbounded native buffering.

Files are binary. Define bounds for buffered SDK helpers and use streaming for larger content. Before implementation, specify overwrite/atomicity behavior, directory operations, symlink handling, file metadata, and cancellation effects. A completed root-filesystem write is not a durability guarantee for every externally mounted filesystem.

## Streams and sessions

Use HTTP streaming where suitable for file transfer and one-way output; WebSockets for bidirectional terminal, process input, and tunnel sessions. Negotiate a protocol version. Specify authorization, binary framing, event ordering, close/error behavior, and size limits.

Output events distinguish stdout, stderr, exit, and gaps. PTY output is a combined stream. Byte chunks have no line or UTF-8 boundary guarantee. Cursors are meaningful only when retention/replay is supported; a reconnect cannot silently imply complete output.

Local tunnel listeners are implemented separately in each SDK. The remote service authorizes a target port and carries the stream. Reconnect re-establishes access, not the original TCP connection. Never hand out a provider administrator credential to authorize a client tunnel.

## Checkpoint and workspace contracts

Capture requests declare filesystem versus filesystem-plus-memory preservation, root/mount scope, maximum disruption, consistency assumptions, and retention requirements. Results declare actual source state, expiration, restore restrictions, and connection effects.

`caller-quiesced` is a caller assertion that writes were stopped/flushed, not a Sandbar promise of database consistency. External storage capture is separate. Plans must reject unknown mount boundaries when the requested guarantee depends on them.

Restore creates a new sandbox in a compatible provider scope. Resume continues a suspended logical resource. Fork creates one child; explicitly shared storage and external services remain shared. Batch forks, if added, report per-child results without implying atomic success.

Workspace versioning is optional above basic persistent storage. Its durability barrier and multi-writer semantics must be declared. Credential rebinding and retained secrets must be considered on every restore/fork path.

## Observability

Carry request, operation, sandbox, project, and provider-instance IDs through structured events and traces. Track allocation/ready latency, execution outcomes, cleanup, reconciliation, and queue/backlog age. Provider telemetry is an optional enrichment.

Exclude secrets, signed URLs, file contents, command environment, and command output from default logs. Command text/content logging is a separate explicit opt-in. Fleet listings return freshness/revision metadata rather than implying a strongly consistent global view.

## Open contract decisions

- Exact public route/frame names and output retention budgets.
- Authentication/token issuance, RBAC, and provider credential storage backend.
- Operation and idempotency retention, cancellation semantics per operation.
- Versioning and compatibility policy for schemas and provider extensions.
- Python synchronous API scope; Rust async runtime support.
- Whether a subset of TypeScript core is exposed for embedding without service guarantees.

These are implementation decisions to resolve in the plan, not functionality already promised by an SDK.
