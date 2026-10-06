# Sandbox lifecycle

Accepted SDK experience · Updated October 2, 2026 · Reopen/inspect merged in PR #38; renewal merged in PR #55; suspend/resume merged in PR #57; Daytona live case passed at `6796b30`, E2B private-state case passed at `26f516d`

Follow [ROADMAP.md](../ROADMAP.md#current-finite-input-review-and-process-research) for remaining work. This refines [state portability §4](provider-state-portability.md#4-suspension-resumption-and-expiry), using its reference, scope and no-replay rules. Reopen/inspect and renewal are merged; suspend/resume is merged in #57. Do not introduce a generic lifecycle engine.

## Selected contract

Reopen Sandbar-created compute, inspect current state/deadlines, renew lifetime through the configured adapter policy, and explicitly suspend/resume the same logical resource. Initial suspension covers Daytona **containers** and E2B **memory pause**. E2B filesystem-only pause is a real native choice but deferred; Daytona VM/GPU/Windows suspension is also deferred. No snapshot/delete/recreate emulation, raw-ID adoption, streaming processes, PTYs/tunnels, new providers, automatic paid snapshot policy, mounted suspension, or volume cleanup-policy configuration.

Slice 1 exports sandbox references, `sandboxes.get`, enriched `inspect` and reopen/inspect capabilities. Renewal is exported on main by PR #55; suspend/resume signatures below are exported by PR #57. The merged [recovery DX contract](sdk-recovery-dx.md) supersedes earlier recovery-facts/expanded-persistence wording. Extend the direct `AdapterSandbox`/`AdapterDirectClient` with the legacy-adapter fallback below. Reuse exported `ResourceReference`, `Support`, `SandboxState`, `WaitOptions`, `AdapterOperation` and the recovery DX result/error model. Current exports are authoritative for lifecycle types through `sandbar-sdk` and `sandbar-adapter`.

### SDK experience and adapter setup

Applications should switch providers by changing adapter setup, while retaining their lifecycle workflow. Use `renew()`, `suspend()`, `resume()` and the existing `destroy()`, `get()` and `inspect()` methods. The adapter owns native reset/add/stop/pause/start mechanics. Ordinary calls do not select timeout scopes or negotiate preservation requirements. No `renewable: true` permission flag, mandatory requirements list, or background renewal loop is needed.

PR #55 exports `lifecycle.lifetimeSeconds`. PR #57 exports the suspension configuration:

```ts
interface AdapterLifecycleOptions {
  lifetimeSeconds?: number; // initial lifetime and default renew window
  suspension?: {
    preserve: Preservation; // minimum required preservation; omitted = native default
  };
}

// Existing bound adapter entrypoints; add lifecycle to their existing option types.
daytona({ apiKey, target: "us", lifecycle: { lifetimeSeconds: 600 } });
e2b({ apiKey, teamId, templateId: "base", lifecycle: { lifetimeSeconds: 600 } });
```

Omitting lifecycle settings preserves the existing provider defaults: Daytona `ttlMinutes`, E2B `timeoutSeconds`, and native suspension behavior. Explicit `lifecycle.lifetimeSeconds` uses seconds and takes the place of the existing provider lifetime option; reject supplying both rather than inventing precedence. The adapter converts units and may round up to its supported minimum/granularity, reporting the resolved setting. Do not silently round down or clamp an unsupported upper bound. Configured defaults survive reopening through the newly connected adapter; they are not copied into resource identity or silently applied by `get()`.

Filesystem preservation is a minimum when explicitly configured: E2B memory preservation can satisfy it. A memory requirement cannot be satisfied by a filesystem-only adapter. Reject known unsupported configuration during connection, before allocation; resource-specific restrictions still need validation before mutation. A requirement for fresh processes is a different choice from preserving files; do not invent a switch where the mapped provider offers no such mode. E2B filesystem-only mode remains deferred until implemented. Snapshot requirements keep their existing exact contract; this change concerns lifecycle suspension only.

Provider setup documentation must explain initial lifetime, renewal behavior and limits, expiry action, whether clocks continue during suspension, saved-state retention, process/connection effects and any real alternatives. These differences need not be erased or renegotiated on every call. Advanced capability inspection remains optional. A provider lacking an operation is still a valid adapter: advertise the limitation and throw the existing typed `UNSUPPORTED` error before effects when called. No hidden snapshot/delete/recreate fallback.

### Proposed interface

```ts
type SandboxReference = ResourceReference<"sandbox">;
type TimeoutScope = "running-session" | "sandbox";
type Preservation = "filesystem" | "filesystem+memory";
type Fact<T> = { status: "known"; value: T } | { status: "unknown"; reason: string };

type Deadline =
  | { status: "known"; at: string; action: "destroy" | "suspend"; scope: TimeoutScope }
  | { status: "none" } // provider affirmatively reports no deadline of this kind
  | { status: "unknown"; reason: string };

interface SandboxInfo {
  reference: SandboxReference | null; // legacy adapters may not issue verified references
  state: SandboxState;
  nativeState: string | null;
  observedAt: string; // client UTC when the native response was received
  expires: Deadline;
  idleStop: Fact<{ seconds: number; action: "stop" | "suspend" } | null>;
  retention: Fact<{ autoDeleteAfterStoppedSeconds: number | null }>;
  execution: Fact<{ nativeId: string }>; // only actual execution/session identity evidence
}

interface RenewRequest { forSeconds: number }
interface RenewResult {
  reference: SandboxReference;
  requested: { forSeconds: number };
  acknowledged: true;
  observation: SandboxInfo | null; // failed metadata read does not erase acceptance
}

interface SuspendResult {
  reference: SandboxReference;
  preserve: Preservation; // established by this acknowledged operation
  processes: "terminated" | "preserved";
  connections: "dropped";
  observation: SandboxInfo;
}
interface ResumeResult {
  reference: SandboxReference;
  execution: "fresh" | "resumed" | "unknown";
  executionIdentity: Fact<{ nativeId: string }>;
  connections: "dropped" | "unknown";
  observation: SandboxInfo;
}

// Additions/refinement on direct SDK handles:
interface LifecycleSandbox {
  readonly reference: SandboxReference | null; // null when verified identity is unsupported
  inspect(options?: WaitOptions): Promise<SandboxInfo>;
  renew(input?: RenewRequest, options?: WaitOptions): Promise<RenewResult>;
  submitRenew(input?: RenewRequest, options?: WaitOptions): Promise<AdapterOperation<RenewResult>>;
  suspend(options?: WaitOptions): Promise<SuspendResult>;
  submitSuspend(options?: WaitOptions): Promise<AdapterOperation<SuspendResult>>;
  resume(options?: WaitOptions): Promise<ResumeResult>;
  submitResume(options?: WaitOptions): Promise<AdapterOperation<ResumeResult>>;
}
// Added to client.sandboxes; returns the existing direct handle with the additions above:
// get(reference: SandboxReference, options?: WaitOptions): Promise<AdapterSandbox>
```

### Reopening and identity

`get` performs a bounded, authenticated native detail read and validates identity before returning a handle, including for stopped/suspended compute. It neither waits for running state nor creates/resumes/extends anything. Missing compute throws `NOT_FOUND`; it never returns a replacement. `inspect` also throws `NOT_FOUND` on authoritative scoped absence, replacing today's `{ state: "unknown" }` for a missing record. A provider-reported destroyed tombstone may be inspected as `destroyed`, but `get` refuses to open it for use. Transport failure is `UNAVAILABLE`, authorization failure is `FORBIDDEN`, identity/config mismatch is `CONFLICT`; a successfully read but unrecognized native state is `unknown`. An elapsed deadline alone does not prove deletion. A 404 cannot distinguish expiry from explicit deletion: say “missing, expired, or deleted,” not “expired” unless native evidence says so.

For adapters implementing reopening, issue a non-null `reference` on successful create/restore and recovered create/restore results using the existing version-1 resource envelope; persist with `JSON.stringify`. Use immutable native IDs, never Daytona names or E2B aliases. Retain only the native creation operation/submission selectors needed to verify Sandbar creation, encoded in the existing `receipt` field; compare them with current native metadata. Do not store history, timestamps, observations or workflow stages in ordinary sandbox references. Confirmed Daytona creation survives optional native identity-read failure as a handle with null reference; a later inspect may issue verified identity. Legacy adapters also retain null-reference fallback. `generation` is reserved for native resource-incarnation evidence if a locator is reusable, not a timestamp or counter invented to represent resume. No native execution generation is established for either target. Old operation references still recover under their existing rules; do not reinterpret an arbitrary `sandboxId` as this resource reference. A recovered legacy create may issue a reference only after the same native verification.

Validate the full envelope, kind, version and bounds at runtime even when TypeScript accepts it. Reuse `assertResourceScope`/`assertResourceIdentity`. Deep-copy the public reference and keep dispatch identity private. Native authorization and matching creation markers, not `ownership` or application history alone, authorize resource use. These are locators for an application-owned trusted store, not bearer capabilities or cryptographic proof against an authorized caller rewriting JSON. No key-based signatures or secret/session tokens in references.

Keep existing scope partitions in this slice:

- Daytona: verified organization, API endpoint, target/region, toolbox origin and existing network-policy partition. A new key in the same organization works with matching config; recheck native ID, organization, target and creation labels. Changing `ttlMinutes` or snapshot defaults does not change identity.
- E2B: verified team plus endpoint and configured template partition. Use `teamId` for credential-rotation support; the existing authenticated team-metrics read verifies access, then detail/creation metadata verifies the sandbox. API-key-scoped connections still work with the same key, but fail scope comparison after rotation. Do not guess or migrate their team. Retain the same `templateId` config across reopen, including the existing `base` exception and restored-template provenance checks. A removed private template can still prevent today's connection preflight; decoupling template selection and adopting existing external compute are deferred explicitly.

PR1 must attach through a read-only native path for **all** direct operations, including execution observation and staged-write cleanup. A running preflight followed by E2B `Sandbox.connect` is unsafe: a pause between them can resume compute. Read the native detail/token, construct the pinned SDK client locally, and call envd directly (recipe below). Check `autoResume === false` before guest access; missing/true is unavailable for guest operations, but does not block control-plane inspection. Explicitly send `lifecycle: { onTimeout: "kill", autoResume: false }` on new E2B create/restore. Reject unsupported externally changed lifecycle configuration rather than mutating it back. External actors changing policy after the check remain a documented race; no native transactional guard is established.

### State and clocks

Use the existing normalized state enum: Daytona `started` → `running`, `stopped` → `stopped`, `archived` → `suspended` (nativeState preserves the distinction), `starting`/`restoring`/`resuming` → `restoring`, `creating`/`destroying`/`destroyed` map directly; stopping/archiving/error/unrecognized states → `unknown` with their native string. E2B `running` → `running`, `paused` → `suspended`. Do not infer memory preservation from `suspended`.

Every successful inspection is a new observation, not a promise that state remains unchanged. Persisted history and recovery outcomes carry their own timestamp/provenance and are never substituted for current inspection. `observedAt` is local receipt time, not provider acceptance time. Expose the provider's absolute RFC3339 deadline unchanged when valid; malformed/omitted fields are unknown. Do not expose a falsely precise `remainingSeconds`: applications may calculate an approximate countdown from the deadline and their clock, subject to clock skew, transport delay and concurrent changes. Zero on that countdown does not establish a tombstone.

E2B `endAt` describes an active session; when paused it is not a saved-state retention deadline. For verified E2B paused state, return `expires: { status: "none" }` and `retention: { status: "known", value: { autoDeleteAfterStoppedSeconds: null } }` from the documented indefinite paused-retention policy; ignore stale `endAt`. This is a documented state-specific mapping, not a generic missing-field rule. Daytona `autoDestroyAt` is a sandbox-wide hard deadline, still active while stopped/archived. `idleStop` is a policy interval, not a calculated expiry: SDK interactions can reset Daytona activity. Expose its observed interval separately; do not derive expiry from `updatedAt`. Retention, idle stop and hard expiry can coexist. Keep auto-archive detail in provider docs for now; it is not deletion. `none`/null requires affirmative provider semantics, not missing JSON fields.

### Renewal

`renew({ forSeconds: N })` requests at least another N seconds before the adapter's configured lifetime policy expires, measured from provider processing of the renewal. `renew()` uses the configured initial lifetime. This is neither “add exactly N seconds” nor a guarantee never to shorten an existing longer deadline. The adapter may replace a deadline or add time, and may grant extra time for native granularity. No caller-selected native scope, automatic heartbeat, or promise to stop unrelated idle/retention policies. Explicit destruction, infrastructure failure, and concurrent external lifecycle changes remain possible. Do not describe this as a guaranteed period of execution.

Validate a positive safe integer and resolved adapter bounds before mutation. Initial mappings require running state. Known account limits reject before dispatch where possible; native rejection remains an error, not silently clamped success. Both providers below use kill/destroy on lifetime expiry in the initial mapping. The inspected clock scope remains useful descriptive information, not an application call option.

- E2B: POST `/sandboxes/{id}/timeout`, integer seconds. The native `Sandbox.setTimeout(id, seconds * 1000, { retries: 0, ... })` path is acceptable. Reset the active deadline from now; use observed `endAt` after ACK. Retain existing Sandbar 60–3600-second resolved bounds, with smaller positive requests rounded up to 60 seconds. Native continuous-runtime caps may prevent renewal. Paused retention is separate; resume starts a new session using the configured initial lifetime.
- Daytona: POST `/sandbox/{id}/ttl/{minutes}`. Round a positive request up to whole minutes, reset hard TTL from now, and use response/detail `autoDestroyAt`. Retain the current 24-hour resolved SDK ceiling; native organization/region/class limits may be tighter. The TTL keeps ticking while stopped/archived and can delete saved files; resume does not reset it. Document this at adapter setup. A request for 61 seconds becomes 2 minutes, rather than failing because application code used provider-independent seconds.

Future adapters can use a native additive extension if it meets the requested window. An idle policy qualifies only if its supported renewal mechanism and threshold provide that window; a random guest/SDK call is not sufficient evidence. Providers without a safe mapped renewal report unsupported. Do not approximate atomic additive extension or introduce scheduling/replacement machinery to implement this slice.

The result records provider acknowledgement and, when available, a current observation. Do not invent an exact acceptance timestamp or precise deletion scheduling. Failed inspection after ACK returns `observation: null`; a lost ACK remains uncertain even if a similar deadline is later observed. Neither the result nor capabilities reserve the sandbox against other controllers.

### Suspension and resumption

Default `suspend()` resolves native behavior from the actual sandbox: Daytona container stop preserves private filesystem and ends processes; E2B pause preserves filesystem and memory. Optional adapter `lifecycle.suspension.preserve` checks a minimum guarantee before mutation; extra memory preservation satisfies a filesystem requirement. Reject unmet/unknown guarantees. It is not a per-call native mode selector. E2B filesystem-only mode can later become a real adapter choice, but do not add an inactive option now. No per-call provider bag or profile-ID selection.

Only running sources qualify for first-release suspend. Resume applies the same provider eligibility and configuration checks to the inactive resource. Daytona requires known empty native mounts, a verified container class and auto-delete disabled (negative native interval); unknown mounts, ephemeral/immediate or timed deletion-on-stop are unavailable. Its independent hard TTL must be reported, not disabled. E2B rejects known nonempty native mounts as a conservative first-release subset, but missing mount metadata stays unknown and does not veto private filesystem/RAM preservation. Native mount enumeration is neither required nor proof of every guest filesystem: guest FUSE mounts can exist independently. Neither provider promises external-storage flush, durability, atomic consistency or remote connection continuity. Unknown required lifecycle policy/configuration still rejects before mutation. Snapshot methods retain their own separate contracts; do not run suspend/resume concurrently with snapshot capture, destroy or other lifecycle changes.

The E2B mapping follows inspected [native pause](https://github.com/e2b-dev/runtime/blob/1d5c80ac0106b2ea8fcd111c33a4d12b1cc4e82f/packages/api/internal/handlers/sandbox_pause.go), [stored pause configuration](https://github.com/e2b-dev/runtime/blob/1d5c80ac0106b2ea8fcd111c33a4d12b1cc4e82f/packages/api/internal/orchestrator/pause_instance.go), [resume](https://github.com/e2b-dev/runtime/blob/1d5c80ac0106b2ea8fcd111c33a4d12b1cc4e82f/packages/api/internal/handlers/sandbox_resume.go) and [detail](https://github.com/e2b-dev/runtime/blob/1d5c80ac0106b2ea8fcd111c33a4d12b1cc4e82f/packages/api/internal/handlers/sandbox_get.go) source: pause has no mount eligibility gate, resume restores configured mounts, and paused detail omits mount metadata. Official [cloud-bucket examples](https://docs.e2b.dev/storage/cloud-buckets) demonstrate guest mounts outside native enumeration. Creation history or mutable metadata is not a substitute for current native facts.

Daytona: POST stop with native default graceful behavior, poll GET until stopped; no force-kill fallback. Resume from stopped or archived container by POST start, poll until started. Same native UUID, fresh processes, dropped connections. Filesystem survives native archive/start as well, without Sandbar creating a reusable snapshot. E2B: POST pause with `memory: true`; on successful ACK plus paused observation return filesystem+memory/preserved processes. Resume from paused by **one explicit** POST `/v2/sandboxes/{id}/connect`, passing the resolved configured initial lifetime, with memory restore default and no reboot override. Poll GET for running. The resume operation itself resets the E2B session lifetime; Daytona keeps its current hard TTL. No resume timeout argument or hidden second renewal mutation; callers can explicitly renew once running.

E2B does not expose paused memory provenance or a stable execution-generation identifier in the inspected detail schema. Thus a fresh-process resume cannot certify actual process continuity from `state: paused`, or trust a saved suspension receipt as current evidence after an external pause cycle. Return `execution: "unknown"` and unknown execution identity in that case; native memory-pause documentation is a conditional guarantee, not proof of this resource's current pause mode. Historical acknowledged preservation remains accessible through the recovered suspend outcome. The first E2B implementation always returns `execution: "unknown"`: application serialization cannot itself prove absence of external lifecycle writers. Reserve `resumed` for future native evidence; do not implement a history-based continuity heuristic. Daytona container resume reports `fresh`, also without a fabricated execution ID. Connections must be reopened; neither result promises live TCP continuity.

Calls are explicit mutations, not “ensure state” helpers. Already suspended/stopped `suspend` and already running `resume` reject effect-free `CONFLICT`; they do not overwrite preservation facts or extend lifetime. Native 409 after a raced E2B pause is not proof our requested memory pause completed. Transitional states reject `UNAVAILABLE` before dispatch. Expired/deleted state fails `NOT_FOUND`. Observation can later show another actor reached the desired state without promoting our operation to confirmed preservation/continuity.

## Capabilities and adapter changes

Extend `client.capabilities()` and `box.capabilities()` with one small lifecycle record. Use existing `Support<T>` meanings; connection capabilities describe implemented profiles, box capabilities additionally resolve current scope/class/state/mount/config restrictions. Access failures are unavailable, incomplete native facts unknown, unimplemented mappings unsupported. Unsupported hooks must not affect unrelated create/exec/files/destroy use.

```ts
interface LifecycleCapabilities {
  reopen: Support<{}>;
  inspect: Support<{}>;
  renew: Support<{ minSeconds: number; maxSeconds: number; stepSeconds: number; scope: TimeoutScope }>;
  suspend: Support<{ preserve: Preservation; processes: "terminated" | "preserved"; connections: "dropped" }>;
  resume: Support<{ sourceStates: SandboxState[]; setsSessionTimeout: boolean }>;
}
```

Bounds above are the adapter's request bounds; they are not guaranteed account entitlement. Revalidate before mutation; capabilities are observations, not reservations. Keep the existing `suspension` capability synchronized with this new per-operation surface during migration (or replace it in the same unreleased SDK change with a documented type migration); do not advertise two contradictory sources of truth.

| Operation after its slice | Daytona container | E2B | Prerequisites / limits |
| --- | --- | --- | --- |
| Reopen, inspect | Native scoped GET | Native scoped GET | Valid creation correlation and original binding; E2B teamId for key rotation |
| Guest exec/files after reopen | Existing toolbox path | GET + local envd client | Running; E2B auto-resume off and detail token present |
| Renew | Reset hard TTL, round up to minutes | Reset active session deadline | Same SDK call; native scope, expiry and limits documented at setup; rounding never grants less time |
| Suspend | Native stop, filesystem | Native memory pause | No mounts; Daytona auto-delete disabled; E2B account/API must accept memory pause |
| Resume | Native start from stopped/archived | Native v2 connect from paused | Saved compute still exists; E2B new session timeout, process provenance may remain unknown |
| Memory suspend on Daytona / filesystem-only on E2B | Deferred VM mapping | Deferred real native mode | Not claims of native impossibility |

Use an optional public adapter hook `reopen(reference, ReadContext): Promise<SandboxInfo>` and enrich the existing `inspect` result with optional lifecycle fields, including a verified reference issued from scoped native detail. The direct SDK normalizes legacy inspect results to `reference: null`, `nativeState: null`, a receipt timestamp and unknown lifecycle facts; do not fabricate a reference from `id`. Existing third-party create/exec/files/destroy and inspect remain usable with `box.reference === null`; get and lifecycle mutations are unsupported without their hooks. Daytona/E2B create/restore decoders obtain verified detail before returning a non-null reference, retaining the allocation recovery reference if that read fails. Add `renew`, `suspend`, `resume` as the existing `Mutation<Input, Value, ...>` form. Mutation inputs carry the validated sandbox reference plus the corresponding request; results above are plain serializable values. Add only `sandbox_renew`, `sandbox_suspend`, `sandbox_resume` operation kinds and their result decoders. Keep provider-specific read/prepare/submit/observe code next to existing state-native fixtures. Do not route the new operations through legacy SPI orchestration or extract a new engine.

## Recovery, cancellation and concurrency

Depend on the merged [recovery DX](sdk-recovery-dx.md) for typed partial results, recovered result typing and application-owned resource/recovery references. Preserve existing checkpoint ordering; expanded persistence callbacks remain deferred. No competing journal, lock service, HMAC, operation object model or continuation protocol. Applications serialize lifecycle mutations per sandbox, including external controllers if they need continuity claims; Sandbar cannot provide distributed exactly-once execution or fence dashboard changes.

Each selected mutation has one native dispatch stage. Use the existing recovery reference, validated identity, requested semantics and dispatch barrier; recheck cancellation immediately before dispatch. Retain confirmed ACK and essential outcomes using the existing recovery representation; metadata/persistence failure must not relabel confirmed success as provider uncertainty. No hidden native retries, no retry after timeout/connection loss, no automatic inverse action. Before dispatch cancellation has effect `none`; after possible dispatch it only stops local waiting. Use existing aborted/unknown errors with recovery references and partial facts. Polls are reads and can be retried within existing bounded read policy.

| Operation | Completion and lost-ACK treatment | Explicit continuation |
| --- | --- | --- |
| get / inspect | Repeat reads safely; never changes lifetime/state | Not applicable |
| renew | ACK confirms acceptance; later GET is current deadline, not attribution. Without ACK, keep unknown and expose latest observation; do not reset again | None after possible dispatch; a new caller-selected renewal is a new mutation |
| suspend | ACK + target-state read establishes completion/profile. Lost ACK may prove stopped/paused, but not E2B requested preservation; retain partial state, never guess memory | No second stage; no resume compensation |
| resume | ACK + running read establishes completion; lost ACK may show running but cannot prove our transition or execution continuity | No second stage; never resubmit connect/start |

If the inherited runtime exposes a proven never-submitted continuation, it may dispatch the single stage only after renewed validation; do not add a lifecycle-specific continuation feature. A barrier with uncertain dispatch is not “never submitted.” Native current state alone cannot authorize replay or prove attribution. Even apparent native idempotence is insufficient: E2B connect on running can extend expiry, timeout resetting is time-relative, and stop/start can affect a later execution. Preserve retained mount/snapshot references from existing recovery facts; lifecycle operations neither delete nor adopt artifacts. Existing destroy remains the explicit cleanup operation.

## Application examples

The merged suspend/resume implementation compiles this workflow against packed public packages; Daytona live case passed at `6796b30`, E2B private-state case passed at `26f516d`. Lifetime configuration, renewal and reopening are implemented; see [the compiled renewal example](../apps/docs/examples/sandbox-renew.ts) for current usage. Keep the existing `Sandbar.connect` and bound adapter entrypoints; no client-construction redesign is needed. `Image.prepared`, exec arrays and store calls follow the existing public API. Applications own durable storage and per-sandbox mutation serialization. Implementation PRs must compile the completed examples against packed public packages.

```ts
import { Sandbar, Image, type SandboxReference } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";
import { e2b } from "sandbar-sdk/e2b";

// Only provider setup changes. Image selection is provider setup too.
const daytonaSetup = {
  adapter: daytona({ apiKey: daytonaKey, target: "us", lifecycle: { lifetimeSeconds: 600 } }),
  environment: Image.prepared("daytona-small"),
};
const e2bSetup = {
  adapter: e2b({ apiKey: e2bKey, teamId, templateId: "base", lifecycle: { lifetimeSeconds: 600 } }),
  environment: Image.prepared("base"),
};

const setup = daytonaSetup; // switch to e2bSetup; workflow below stays the same
const client = await Sandbar.connect(setup.adapter);
const box = await client.sandboxes.create({ environment: setup.environment });
if (!box.reference) throw new Error("Provider cannot issue a reopenable identity");
await store.put("workspace", JSON.stringify(box.reference));

await box.exec(["python", "prepare.py"]);
await box.renew({ forSeconds: 600 }); // provider handles reset/add mechanics and units
await box.exec(["python", "process.py"]);
await box.suspend(); // Daytona files; E2B files + memory; reconnect sockets on resume
await client.close(); // compute/state persists under the documented provider policy

// Later, with the same provider binding and a current credential:
const next = await Sandbar.connect(setup.adapter);
const saved = JSON.parse(await store.get("workspace")) as SandboxReference;
const reopened = await next.sandboxes.get(saved); // read-only; no implicit wake or renewal
await reopened.resume(); // expired/deleted state fails; never creates empty replacement
await reopened.renew(); // configured 600-second window, explicitly requested
await reopened.exec(["python", "finish.py"]); // start the next application process explicitly
await reopened.destroy();
await next.close();
```

The same configured application can use either adapter for new sandboxes; references still belong to their original provider. Provider switching does not migrate a saved sandbox or its state. Filesystem-oriented applications must tolerate the documented native memory behavior; applications requiring memory preservation configure it at adapter setup and select a compatible provider.

On an aborted/uncertain mutation, use the error's existing recovery reference and `client.recover(reference)` to observe/wait for typed partial outcomes. Do not blindly call renew/suspend/resume again. Reopening a resource does not recover a mutation or prove that a lost operation completed. Follow the merged recovery DX contract, without introducing expanded persistence hooks or a lifecycle journal.

## Evidence and exact native recipes

Public research checked September 29, 2026; renewal mappings rechecked September 30 against the same Daytona OpenAPI SHA-256 and installed E2B 2.51.0 lifecycle/timeout source; **no paid/live calls, account probes or new live qualification**. Documentation describes guarantees; pinned source establishes request behavior, not the deployed backend's exact timing. Unverified field availability, external races, precise expiry enforcement and E2B execution identity remain untested/unknown, not implementation blockers when represented honestly.

- **Daytona baseline:** Sandbar uses direct fetch against the v0.218 REST/toolbox surface, not `@daytona/sdk` at runtime. Existing `state-native.ts` already implements stop/read/start for cold snapshots; reuse request/error conventions, not the capture workflow. Published [SDK 0.218.0 Sandbox source](https://unpkg.com/@daytona/sdk@0.218.0/esm/Sandbox.js) implements `setTtl` and start/stop. Keep single-attempt fetch mutations; do not adopt its retrying connection adapter.
- **Daytona current schema:** [official OpenAPI](https://www.daytona.io/docs/openapi.json), fetched SHA-256 `ae430ff2feb4df0f4c71958b5ac64f837e935ffe85042793eb5588ab7c354379`, identifies itself as API `1.0`; docs UI is v0.220. Inspect `Sandbox` fields `id`, `organizationId`, `target`, `sandboxClass`, `labels`, `volumes`, `autoStopInterval`, `autoDeleteInterval`, `autoDestroyAt`, and `state`. GET `/sandbox/{id}`; POST `/sandbox/{id}/stop`, `/start`, `/ttl/{ttlMinutes}`. TTL response is a Sandbox, not an operation-generation receipt. The schema also documents organization/region/class lifespan caps. Do not label this fetched schema “pinned v0.218.” Revalidate compatibility fixtures when implementing.
- **Daytona guarantees:** [persistence](https://www.daytona.io/docs/en/persistence/) distinguishes container filesystem survival from VM memory pause; [sandbox lifecycle and TTL](https://www.daytona.io/docs/en/sandboxes/#wall-clock-ttl) specifies hard expiry from the last reset and native stop/archive/start. [setTtl reference](https://www.daytona.io/docs/en/typescript-sdk/sandbox/#setttl) points to `autoDestroyAt` after refresh. Current server internals are private; the [retired public repository](https://github.com/daytonaio/daytona/blob/ec4c21b2d597091ac09ecc278f3bcc172575a987/README.md) cannot prove current scheduler precision or mutation idempotency.
- **E2B pin:** runtime `e2b@2.51.0`, tag commit `ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b`. [Sandbox constructor/connect](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/packages/js-sdk/src/sandbox/index.ts#L123), [control API implementation](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/packages/js-sdk/src/sandbox/sandboxApi.ts#L1269), and [schema](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/packages/js-sdk/src/api/schema.gen.ts#L2476) establish GET, pause `memory`, timeout and v2 connect payloads. `Sandbox.getInfo` omits the returned envd access token. Use a bounded raw GET `/sandboxes/{id}` to read `envdAccessToken`, `envdVersion`, `domain`, lifecycle, state and metadata; verify scope first, then locally `new Sandbox({ ...fixedConnectionOptions, sandboxId, envdVersion, envdAccessToken, sandboxDomain: domain })`. Its constructor is publicly callable in this pin but annotated internal: isolate it in transport and test against the packed dependency. Never serialize the token, log it, accept arbitrary origins, or issue POST connect to refresh it. Missing credentials/unsupported detail fields make guest access unavailable. This is source-derived feasibility, not live proof.
- **E2B retries/auto-resume:** [API transport](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/packages/js-sdk/src/api/index.ts) wraps requests in rate-limit retry; preserve `retries: 0`. [Auto-resume docs](https://docs.e2b.dev/sandbox/auto-resume) include guest operations as triggers. A constructor bypass alone does not disable server auto-resume. Fixed trusted routing and verified `autoResume: false` are both required; regression fixtures must inspect actual HTTP calls, not merely adapter callbacks.
- **E2B lifecycle guarantees:** [persistence](https://docs.e2b.dev/sandbox/persistence) documents memory/process restoration, connection loss, indefinitely retained paused compute, and continuous-runtime caps; retention is not a billing guarantee. [Filesystem-only pause](https://docs.e2b.dev/sandbox/filesystem-only-snapshots) is explicitly real but deferred. [Get sandbox](https://docs.e2b.dev/api-reference/sandboxes/get-sandbox) exposes `startedAt`/`endAt`, not a generation or pause-memory receipt. [Timeout API](https://docs.e2b.dev/api-reference/sandboxes/set-sandbox-timeout) resets expiry relative to the current request. Pinned pause maps native 409 to false; do not convert it to a memory-preservation success. Native availability can vary during rollout; 503 must not trigger mutation replay.

## Delivery and acceptance

All three slices below are merged in PRs #38, #55 and #57. Separate Daytona/E2B reopen and renewal workflows passed at `3188e33` in #68 with confirmed owned cleanup; suspend/resume passes retain their own recorded revisions/configurations. The table preserves delivery and acceptance context, not an open implementation queue or a current-head qualification claim.

Estimates include API, adapters, deterministic tests and docs; they are review-complexity estimates, not line-count commitments. Each implementation PR should remain roughly a few hundred production lines plus focused fixtures/examples, with PR1/PR3 potentially approaching a low-thousands total diff because of native-boundary tests. If either needs another broad state framework or many thousands of production lines, cut scope as indicated instead of growing a foundation PR.

| PR | Independently useful scope | Dependencies / likely complexity | Acceptance and explicit cut line |
| --- | --- | --- | --- |
| 1. Reopen and inspect | Saved sandbox references, get, enriched inspect, both providers; E2B read-only guest attachment for existing exec/files | Current main; moderate, roughly 2–4 focused engineering days plus review. Coordinate any create/restore decoder changes with recovery DX | Fresh-process file/exec flow, state/deadline/errors and key rotation fixtures; no implicit connect/start/timeout. If E2B attachment proves incompatible, ship Daytona first and retain E2B control-plane inspection with guest access unavailable; do not add a new envd client framework. No mutations or generic transition engine |
| 2. Renew configured lifetime | renew + submit form, adapter-owned E2B session and Daytona hard TTL mappings, recovery, docs | PR1 + merged recovery DX; small, roughly 1–2 days plus review | Portable seconds, upward unit rounding/bounds, unsupported before effects, ACK vs lost ACK, observed deadline and packed examples. No idle policy, retention setters, zero/disable or lifetime automation |
| 3. Suspend/resume | Daytona container stop/start and E2B memory pause/connect, single-stage recovery and adapter configuration | PR1 + recovery DX; PR2 recommended for examples but not mechanically required; moderate, roughly 3–5 days plus review | Same logical ID, filesystem/process distinctions, unknown execution identity, no replay, expired state and dropped connections. If too large, initial release keeps Daytona suspend/resume and defers E2B mutations explicitly; no filesystem-only E2B mode, VM profiles, mounted suspension or capture integration |

Minimal offline coverage uses existing adapter/runtime and native HTTP fixtures, with no new certification framework:

1. PR1: create/restore/recovered-reference JSON roundtrip into a fresh connection; forged/malformed/wrong-scope/marker references; E2B same-team rotation and key-scope rejection; stable template binding; 404 vs 403 vs 5xx; stopped/paused/unknown states; deadline absence/invalid timestamp/clock skew. Exercise real pinned E2B client against fake HTTP through exec/read/write/observation, including pause between preflight and guest request: no control-plane POST, no auto-resume, no replay or timeout extension. Ensure auto-resume true/missing and missing token fail before guest IO.
2. PR2: units, Daytona upward rounding, unsupported state/cap, cancellation before/after barrier, ACK with failed follow-up GET, lost ACK and repeated observation without another POST. Recovery JSON survives a fresh client; relative reset is never treated as idempotent.
3. PR3: native defaults/configured minimum mismatch, class/mount/auto-delete gates, expired source, current and raced source state, E2B pause 409/503, ACK/poll failures, lost responses, stale observation ordering, same ID and no invented generation. Verify native request counts and no create/capture/delete/implicit restart. Reuse recovery-DX checkpoint failure tests rather than duplicating its exhaustive suite.

Extend the [maintained public-SDK Bun suites](../packages/sdk-qualification/provider-qualification/README.md) with only `lifecycle-reopen`, `lifecycle-renew`, `lifecycle-suspend-resume` scenarios. Each requires later **explicit live authorization**, actual public methods, fixture/packed checks first, actual tested-revision provenance, and separate passed/failed/unsupported/blocked/not-run evidence. Branches and merged revisions use the maintained Bun suites and shared fixtures; no bespoke lifecycle runner is needed. Representative plan per provider: one owned compute allocation, peak one, borrowed prepared image, no builds/volumes/reusable snapshots; exercise ≤10 minutes, teardown ≤2 minutes. Daytona hard TTL ≤15 minutes including any reset; E2B each active session ≤5 minutes, at most one explicit pause/resume. Paused E2B has no automatic retention expiry: approval must cover residual storage and durable explicit kill reconciliation after interruption. Persist identity/checkpoints before effects; reuse the private ledger and admission lock, never a disposable cleanup record.

- PR1 live: write known bytes, close, new process opens reference, inspects, reads and execs; repeat after deletion to assert absence. Use ordinary team/organization identity; rotation/adversarial faults stay offline unless separately authorized. Confirm E2B deadline was not extended by reconnect/guest access.
- PR2 live: change remaining lifetime once, inspect provider deadline with a tolerance bounded by request duration/clock uncertainty, verify unit rounding and limit rejection, then explicit cleanup. No waiting for multi-hour caps or asserting exact deletion time.
- PR3 live: write/read bytes, launch a bounded background counter through existing exec, suspend, reopen while inactive, assert guest calls do not wake it, explicitly resume and verify identity/files. Daytona old process absent; E2B correlated memory-pause process/counter continues. A PID alone is insufficient continuity evidence. Teardown from both active and inactive paths across the fixture/live selection; clean the one logical sandbox, never its borrowed template. Streaming-process APIs are not required.

Run implementation gates appropriate to the changed packages: focused tests, sequential `check`/builds, `test`, lint/format, `package:smoke`, `docs:check` and required CI. This spec PR needs Markdown/link/type-sketch verification and existing docs gates only; it adds no runnable API or provider qualification claim.

## Accepted direction and implementation documentation

The SDK experience is accepted: concentrate provider choices in adapter setup; expose `renew()` and no-argument `suspend()`/`resume()`; use native defaults and minimum configured suspension guarantees; keep actual clock and process facts honest. This supersedes the explicit-scope `setTimeout` proposal and per-call exact suspension requirement. Renewal merged in PR #55 with deterministic native-boundary and packed checks; its live qualification is not run. Suspend/resume merged in #57 with native-boundary and packed checks. Daytona live suspend/resume passed at `6796b30`; E2B failed before pause at `cb39884` because native mount facts were unavailable. Owned cleanup was confirmed. The revised E2B private-state lifecycle case passed at `26f516d` with confirmed owned cleanup and client close; earlier failures remain recorded. The E2B live case includes fresh-process inactive reopening, same files/identity and RAM nonce/counter continuity; it does not qualify the separate full reopen, renewal, streaming or signal-bearing read workflows.

Keep renewal and suspend/resume as separate small PRs. No new providers, memory-mode expansion, mounted suspension, generic engine or client configuration framework. The implementation updates built-in option types/config validation, public adapter hooks, provider docs, packed examples and the affected support/acceptance rows together. Each provider guide must show its setup and defaults, the unchanged application workflow, actual renewal limits/rounding, expiry during suspension, process/connection effects, and recovery/cleanup behavior. Preserve historical live evidence and mark planned, implemented and live-qualified support separately.
