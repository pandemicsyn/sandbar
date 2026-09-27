# V1 contract recommendations

Draft 0.3 · September 26, 2026 · Proposed decisions after an iterative design review

The user confirmed self-hosting and a management UI as v1 requirements, then selected the [Hono/SQL architecture](design.md). The behavioral recommendations below refine the earlier API sketch; they are not claims of shipped or verified behavior. Numeric limits are product defaults to test and tune, not provider limits.

## Review method and decisions changed

Three specialists covered security contracts, environment/SDK design, and operations/recovery. The primary agent challenged initial proposals, sent cross-cutting constraints, and requested additional cross-review. Each specialty went through multiple exchanges.

| Initial proposal or tension | Refined recommendation |
|---|---|
| Deployment-configured provider keys | Dynamic write-only connections through the UI and management API |
| Generic HTTPS header injection | Separate literal placeholder substitution from a future exact-header gateway |
| Confirmation flag on every credential-bearing restore | Inherit bindings with current authorization; retain sensitivity lineage; no repetitive consent flag |
| Immutable environment revision implies reproducible bytes | Manifest immutability and upstream artifact pinning are separately reported |
| Resolve everything before accepting create | Reserve identity and freeze local references first; remote resolution is an explicit operation phase |
| Live-only output by default | Bounded captured prefix so fast execution and completed-job inspection work |
| Same async Operation wrapper for every write | Operations for asynchronous/ambiguous effects; ordinary configuration writes and file receipts remain simpler |
| Nested exec.run namespace | Basic sandbox.exec plus an explicit submitExec form |
| Arbitrary expiring dedupe keys | Timestamped invocation keys with server-side expiry rejection |
| Encryption key bundled with deployment/database backups | Separately permissioned mounted key or qualified host secret source; independently test recovery |

## 1. The normal user path

1. Operator starts Sandbar and completes first-run identity setup.
2. Project administrator adds a provider connection and verifies its native scope.
3. The UI offers Use provider starter, resolves an available artifact, and drafts starter@1 automatically.
4. Administrator explicitly selects the default network preset, reviews default resources, and publishes.
5. The UI generates a project-scoped Sandbar token and copyable SDK examples. Provider keys stay server-side.
6. Fleet detail shows effective environment, policy, operation state, output availability, and cleanup status.

The service URL, project, and Sandbar token are configured once in the SDK. The ordinary path should remain this small:

```ts
const client = Sandbar.fromEnv();
const box = await client.sandboxes.create({ environment: "starter@1" });
try {
  const result = await box.exec(["echo", "hello"]);
  console.log(result.stdoutText());
} finally {
  await box.destroy();
}
```

```python
client = AsyncSandbar.from_env()
box = await client.sandboxes.create(environment="starter@1")
try:
    result = await box.exec(["echo", "hello"])
    print(result.stdout_text())
finally:
    await box.destroy()
```

```rust
let client = Sandbar::from_env()?;
let box_ = client.sandboxes().create("starter@1").await?;
let execution = box_.exec(["echo", "hello"]).await;
let cleanup = box_.destroy().await;
let result = execution?;
cleanup?;
println!("{}", result.stdout_text_lossy());
```

These are proposed signatures, not compilable examples against an existing package. Rust cleanup is attempted even when execution returns an error; dropping a handle alone does not imply remote cleanup. A creation wait error carries the allocated operation/sandbox IDs for inspection and cleanup. Provider lifetime limits remain important after client death.

create and exec wait by default. submitCreate / submitExec (submit_create / submit_exec in Python and Rust) return typed operation handles immediately. Do not impose an arbitrary whole-operation wait timeout shorter than a valid process deadline; callers can set waitTimeout or cancel waiting. Individual HTTP requests remain bounded and safely retryable. Unknown effects return a recoverable OutcomeUnknown error, not an endless wait or transparent resubmission.

Background processes remain a separate optional processes.start interface. A basic exec still receives a Sandbar execution ID when the provider has no native PID or attachment support.

## 2. Provider connections and identity

Use project-owned ProviderConnection resources. Provider means the adapter family; connection means a specific native account/project/API endpoint scope. Region is a placement constraint rather than a substitute for account identity.

Proposed management request:

```json
{
  "name": "daytona-dev",
  "provider": "daytona",
  "configuration": { "region": "us" },
  "credentials": { "apiKey": "write-only-value" }
}
```

POST /provider-connections creates an unverified connection; POST /provider-connections/{id}/verify performs safe identity/capability checks. Credential/configuration fields are validated by the named adapter, not a universal apiKey assumption. Native SDK validation must not launch paid compute implicitly.

GET exposes verified scope, health, credential revision, and readiness, never credential values. PUT /provider-connections/{id}/credentials uses a revision precondition and verifies the same native scope before activation. A different account/project requires a new connection. Use current verified same-scope credentials for cleanup and reconciliation rather than pinning historical provider keys.

Draining stops new placement while allowing inspection and cleanup. Deletion is blocked while managed resources still depend on the connection unless an administrator explicitly detaches ownership after seeing the consequences. Discovered resources are read-only until explicit adoption.

Project resource routes are scoped beneath /v1/projects/{projectId}. Operator administration and billing-account imports are separate; project membership alone never grants full-account access. The UI and SDKs use the same authorization and mutation APIs.

## 3. Secrets and network policies

### Four separate credential classes

- Provider credentials authorize Sandbar to control a provider account.
- Workload secrets are versioned inputs intentionally bound to guest execution.
- Sandbar API tokens authenticate clients and are stored as hashes.
- Endpoint/session grants authorize narrow, expiring access and are separately revocable.

Reserve credentials for provider connection write endpoints. Use secrets in workload requests:

```json
{
  "secrets": [
    {
      "secret": "github@current",
      "delivery": { "kind": "env", "name": "GITHUB_TOKEN" }
    },
    {
      "secret": "service-config@3",
      "delivery": {
        "kind": "file",
        "path": "/run/secrets/service.json",
        "mode": "0400"
      }
    },
    {
      "secret": "llm-key@current",
      "delivery": {
        "kind": "https-placeholder",
        "env": "OPENAI_API_KEY",
        "hosts": ["api.openai.com"]
      }
    }
  ]
}
```

Use immutable versions internally. current is resolved once through the authoritative project catalog; retries do not advance it. Reject overlapping delivery paths/names and ambiguous conflicts with plain environment fields. Secret values do not appear in plans, resource responses, indices, default logs, or operation metadata.

Environment/file delivery exposes plaintext to guest code. A principal able to use such a secret and execute arbitrary code can read or exfiltrate it. Do not advertise use-without-disclosure permissions for these modes.

https-placeholder is a distinct capability: the guest gets a placeholder that a verified proxy substitutes in outgoing HTTPS headers for listed hosts. Require a nonempty exact-host list in v1. Daytona documents arbitrary-header substitution, not confinement to one chosen header or port-specific HTTP authority. A future exact-header gateway must have its own contract and cannot silently fall back to placeholder or environment delivery. [Daytona secrets](https://www.daytona.io/docs/en/secrets/)

### Named immutable network policies

Normal creation uses network: {policy: "python-packages@1"}. Omission snapshots the configured project default. If no default exists, blocked is the effective policy; reject creation if a provider cannot enforce it. Onboarding explicitly offers blocked, development internet, or a custom policy. Changing the default affects future creates only.

The underlying v1 policy is a union of blocked, open, and default-deny allow. Avoid mixed allow/deny precedence in the portable contract:

```json
{
  "egress": {
    "kind": "allow",
    "destinations": [
      { "kind": "tls", "host": "pypi.org" },
      { "kind": "tls", "host": "files.pythonhosted.org" }
    ]
  }
}
```

Destination semantics must remain explicit:

| Kind | Requested guarantee |
|---|---|
| ip | CIDR restriction; initial profile allows transports/ports within that range unless a separate verified port constraint is requested |
| tls | Exact TLS server-name matching on port 443; no URL/header/HTTP authority promise |
| https | Exact HTTPS authority enforcement, only with a verified gateway implementation |

A provider implementing DNS-to-IP restrictions is not automatically equivalent to tls or https. Add an explicitly named DNS-derived-IP profile only if a real use case requires its weaker semantics. Do not coerce it into another matcher. Named policies keep ordinary user code simple even when the underlying guarantees differ.

Validate DNS behavior, IPv4/IPv6, direct-IP paths, reserved/internal routes, and rule combinations. Blocked means deny guest-originated egress. Provider control traffic outside guest reach may continue. Guest-reachable exceptions require an explicitly different policy/profile; a provider cannot satisfy blocked merely by disclosing exceptions afterward. An open policy does not promise access to every address or bypass native restrictions. Never automatically widen policy when package downloads or Git redirects fail.

Ingress is separate: create an Endpoint resource with a sandbox port and access: {kind:"authenticated"} by default. Explicit public access requires project permission. Session/grant issuance specifies scope and expiration; no endpoint response contains a provider-wide token. Native grant scope must be at least as narrow as the requested contract, or Sandbar must enforce the missing restriction through a verified gateway.

Provider evidence: [Modal SNI limitations](https://modal.com/docs/guide/sandbox-networking), [Daytona mutually exclusive policy options and account restrictions](https://www.daytona.io/docs/en/network-limits/), [Tensorlake network/DNS semantics](https://docs.tensorlake.ai/sandboxes/networking), [Daytona preview grants](https://www.daytona.io/docs/en/preview/).

### Restore and fork

Default same-project restore/fork uses secrets: {mode:"inherit"}: retain captured bytes and the source binding manifest, while checking current authorization for its recorded secret lineage. The normal SDK call remains checkpoint.restore().

Explicit secrets: {mode:"rebind", bindings:[...]} changes known delivery points only where the adapter can do so before workload execution. It does not remove copied values from arbitrary files or RAM. Reject requests requiring environment replacement inside already-captured processes if the provider cannot enforce it. An empty bindings array is not a sanitization guarantee.

Checkpoint metadata records known exposure lineage and otherSensitiveData: "unknown". Revoked access blocks new restore/fork/injection using that lineage, but does not block cleanup. Source bytes can remain usable until their upstream credential is revoked. Revoked or stale external placeholders must not be silently replaced under inherit while claiming identical execution input; report viability and require explicit rebind when appropriate.

### Identity and self-hosted key custody

Recommend two explicit human-login modes: single-operator access-key login and OIDC team login. Both issue same-origin secure HttpOnly sessions with CSRF/origin checks. Project roles are admin, member, and viewer; member includes execution and only granted workload-secret use. Generate setup/recovery tokens outside browser configuration, store only hashes, and make setup tokens single-use. Avoid a new password/reset/email system in v1.

Encrypt stored provider/workload secrets and captured sensitive payloads with authenticated encryption, a random nonce, key version, and context binding project/resource/version. Keep the internal KeyProvider boundary small. Rotate deployment keys independently from provider credentials and workload secret versions.

For the selected Bun/Hono deployment, use a separately permissioned mounted key file or qualified host secret source through KeyProvider. Keep the key out of database/artifact backups, frontend configuration and logs; retain explicit key-version rotation and recovery procedures. Protection against a database-only disclosure requires the key to be unavailable to that reader. Full-host compromise or a backup containing both key and ciphertext is outside that claim. Test this deployment boundary before release; it is not established merely by choosing an ORM or encrypting a column.

## 4. Environment and image selection

Use one environment field for six distinct source kinds: revision, channel, oci, dockerfile, native, and prepared. SDKs accept coding-agent@3 for a pinned revision and Image.oci(...) / Image.dockerfile(...) helpers; prepared-image handles serialize to stable references. Mutable channels are explicit.

The image review changed the earlier defer-builds proposal: OCI supply and bounded remote preparation belong in v1. Project onboarding chooses an explicit preparation policy and ordered placement connections so ordinary image-based creation works without manual provider template setup. Dockerfile/context handling requires adapter-verified remote builder semantics; never execute builds inside the API process.

An environment revision is an optional catalog of prepared bindings and resource recommendations. Adding mappings creates a new revision. Native/prepared sources pin compatible scope; conflicting placement is rejected. Provider family alone never selects an arbitrary account.

Manifest immutability does not establish immutable upstream bytes. Report source pinning, native output identity, and adaptation separately. Resolve explicit resource requests, then environment recommendations, then project defaults; use explicit vCPU terminology and preserve native conversions. Environments own neither workload secrets nor network authority.

The complete union, private-registry authentication, build contexts, preparation limits, cache/retention, provenance, and three-language examples are in [storage and images](storage-and-images.md). That document supersedes the earlier three-branch source union and deferred-build recommendation.

## 5. Admission, operations, and retry safety

### Freeze caller intent and effective input separately

1. Normalize SDK shorthands into the common wire schema. Hash/HMAC normalized caller intent without today's defaults; object key order is irrelevant, but omission versus explicit input remains distinct.
2. In the authoritative admission store, look up the idempotency record before resolving new aliases/defaults. Reject a differing request under the same key.
3. For a new invocation, atomically allocate operation/resource IDs and pin authoritative environment/policy/workload-secret version references. Keep current-version pointers in the admission transaction boundary; stage immutable encrypted secret versions before publishing their current pointer.
4. Dispatch through durable persisted work. Slow native artifact resolution appears as resolving, then provisioning or executing. Persist resolved identities before effectful provider submission.
5. Revalidate current authorization and capabilities at execution without silently expanding frozen candidates or selecting newer workload-secret versions.

HTTP 202 means durable accepted intent with recovery scheduled, not completed provider resolution. External native reads are not part of the local admission transaction. In the selected shared SQL store, admission freezes authoritative local project references and schedules durable work in one transaction. A mutable native alias that cannot be pinned remains explicitly mutable/unverified.

### Operations where they add value

Use Operation resources for asynchronous or potentially ambiguous external effects. Every exec has a stable Execution resource, even without native attachment. POST /sandboxes/{id}/executions returns operation and execution IDs; SDK exec submits, waits, and obtains the result. Keep configuration changes revisioned and synchronous. File writes return a completion/partial-transfer receipt unless a distinct async transfer feature is requested.

Execution exit status and provider operation success are separate: exit code 1 is a valid execution result. An output retrieval failure does not turn a completed execution into an unknown provider effect. Surface output availability separately.

### One idempotency-key profile

Require UUIDv7 Idempotency-Key values on effectful submissions. SDKs generate once per deliberate call and preserve the value across transport retries. Callers may supply/persist a valid key for process-restart recovery. Business correlation IDs are metadata, not a second dedupe contract in v1.

- Look up existing records first, even if their key is old.
- A previously unseen key is accepted only within 24 hours of its timestamp and no more than 5 minutes into the future.
- An absent expired key returns 410 INVOCATION_EXPIRED without performing the effect. The server does not infer whether it once existed and was pruned.
- Retain records 30 days after terminal outcome and retain compact unresolved evidence until resolved/project deletion.
- Never silently regenerate a key on expiry or ambiguity. Provide generation helpers and examples for raw HTTP callers.

This deliberately trades arbitrary opaque keys for safe rejection after finite record retention. Include cross-language canonicalization, clock-skew, and post-GC replay tests before freezing it.

## 6. Output, retention, and recovery defaults

| Setting | Proposed default |
|---|---|
| Captured output | First 1 MiB combined stdout/stderr per execution |
| Output age | Up to 24 hours; earlier explicit budget eviction possible |
| Sandbox capture budget | 16 MiB including running reservations |
| Project capture budget | 256 MiB including running reservations |
| Output storage | Encrypted, batched SQL segments in the selected dialect; object storage optional later |
| Terminal operation/execution metadata | 30 days |
| Invocation records | 30 days after terminal state |
| Unresolved-effect evidence | Compact record until resolved or project deletion |
| Bounded exec process deadline | 5 minutes, configurable within lifecycle constraints |
| Whole-operation client wait deadline | None implicit; explicit caller timeout/cancellation supported |
| Needs-attention threshold | 15 minutes unresolved; reconciliation continues |
| Unresolved-effect admission quota | 100/project, configurable |

Retention is a bounded cache, not guaranteed 24-hour availability. Reserve the maximum capture before executing. Evict oldest terminal captures first; never evict running reservations to silently satisfy admission. If capacity is still insufficient, reject with OUTPUT_CAPACITY before provider submission and offer a smaller budget or output: {capture:"none"}.

The admission store must enforce both project and sandbox reservations. The selected shared SQL implementation uses stable reservation IDs and reserves both levels in the admission transaction. Lost acknowledgments may temporarily withhold capacity, never authorize over-allocation. Release reservations only after verified completion/eviction or conservative recovery; do not free capacity solely on an expired delivery lease.

Overflow marks truncation and byte counts but never kills the process. Live streams may continue beyond the retained prefix. Report retained byte ranges, eviction/expiry, and replay gaps; preserve exit metadata after captured bytes disappear. SDK results should distinguish incomplete output from unknown execution. Process output can contain secrets: encryption and access control apply, and redaction cannot promise secrecy.

Client cancellation/drop stops waiting. Remote cancellation is explicit, capability-checked, and remains requested until confirmed. Partial effects remain possible. Required hard process deadlines must be enforced by the provider or a verified mechanism; otherwise reject the guarantee rather than silently substituting best effort.

Unknown operations retain phase, provider scope, operation/resource IDs, request fingerprint, native candidates, and exposure lineage. Remove materialized sensitive request data when no longer needed for safe submission/recovery. Do not retain raw secrets indefinitely in an uncertainty ledger.

At the unresolved quota, backpressure new allocations/exec; keep inspection, reconciliation, cancellation, and cleanup available. Archive means acknowledged unresolved, not failed or safe to rerun. Retain destroyed-resource tombstones while the project exists so arbitrarily late events cannot recreate index entries.

UI recovery actions: check provider again, inspect candidates, link a verified native resource with privileged scope checks, acknowledge uncertainty, or explicitly submit a new invocation with visible duplicate-effect risk. Never offer a mark-failed-and-retry shortcut. Destroy intent after unknown create means discover and clean up the possible allocation, not provision a replacement.

## 7. Implementation order and release gates

1. Qualify the selected Bun/Hono runtime, SQLite/MySQL transactions, mounted-key custody, streaming, durable dispatch and restart behavior. Implement Zod schemas at the documented IO boundaries.
2. Freeze the three-language golden flows and OpenAPI unions before generating clients.
3. Build identity, provider connections, secret storage, policy revisions, and management UI onboarding against a fake adapter.
4. Implement admission/idempotency, execution IDs, quota reservation, outboxes, output capture, and recovery UI.
5. Integrate Daytona and Tensorlake as contrasting providers, then E2B and Modal; run per-capability conformance before declaring support.
6. Add checkpoint lineage/rebinding, restore/fork, volumes/versions, and their UI flows. Implement image preparation and observability/accounting according to the companion strategy plans.

Release tests must cover: old key after GC, same key after channel/default change, immediate exec completion before subscription, 17 simultaneous default captures, quota reservation interruption, credential rotation within/wrong account, revoked secret access with cleanup permitted, copied secrets surviving rebind, DNS/SNI/authority mismatch, unsupported mixed rules, out-of-order events, and interruption of the selected runtime.

Remaining empirical questions are bounded: exact provider enforcement/pinning/rebind capability, billing-source semantics, and production behavior of the selected Bun/Hono and SQL stack. They should produce measured adapter capability reports or a documented deployment qualification result, not generic fallbacks that weaken these contracts.
