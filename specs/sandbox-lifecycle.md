# Sandbox lifecycle

Implementation brief · September 29, 2026 · Slice 1 implemented on this branch; later slices remain proposed

Follow [ROADMAP.md](../ROADMAP.md#next-make-everyday-sandbox-and-storage-lifecycles-usable) after the current SDK cleanup. This refines [state portability §4](provider-state-portability.md#4-suspension-resumption-and-expiry), using its reference, scope and no-replay rules. Base: `origin/main` at `01e1c0eaf6a24bf28af3a1c64e56a9b7ae03ddf4`. Ship three useful slices below; do not build a generic lifecycle engine first.

## Selected contract

Reopen Sandbar-created compute, inspect current state/deadlines, reset an explicitly selected native timeout, and explicitly suspend/resume the same logical resource. Initial suspension covers Daytona **containers** and E2B **memory pause**. E2B filesystem-only pause is a real native choice but deferred; Daytona VM/GPU/Windows suspension is also deferred. No snapshot/delete/recreate emulation, raw-ID adoption, streaming processes, PTYs/tunnels, new providers, automatic paid snapshot policy, mounted suspension, or volume cleanup-policy configuration.

Slice 1 exports sandbox references, `sandboxes.get`, enriched `inspect` and reopen/inspect capabilities. Timeout/suspend/resume signatures below remain **proposed, not exported**. The merged [recovery DX contract](sdk-recovery-dx.md) supersedes earlier recovery-facts/expanded-persistence wording. Extend the direct `AdapterSandbox`/`AdapterDirectClient` with the legacy-adapter fallback below. Reuse exported `ResourceReference`, `Support`, `SandboxState`, `WaitOptions`, `AdapterOperation` and the recovery DX result/error model. The new types below are public through `sandbar-sdk` and, where used by hooks, `sandbar-adapter`.

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

interface TimeoutRequest {
  remainingSeconds: number;
  scope?: TimeoutScope; // defaults to running-session; never silently chooses sandbox
}
interface TimeoutResult {
  reference: SandboxReference;
  requested: { remainingSeconds: number; scope: TimeoutScope };
  acknowledged: true;
  observation: SandboxInfo | null; // read failure after ACK does not erase acceptance
}
interface SuspendRequest { requirements?: { preserve?: Preservation } }
interface SuspendResult {
  reference: SandboxReference;
  preserve: Preservation; // established by this acknowledged operation
  processes: "terminated" | "preserved";
  connections: "dropped";
  observation: SandboxInfo;
}
interface ResumeRequest { remainingSeconds?: number } // E2B new session; omitted = configured timeout
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
  setTimeout(input: TimeoutRequest, options?: WaitOptions): Promise<TimeoutResult>;
  submitSetTimeout(input: TimeoutRequest, options?: WaitOptions): Promise<AdapterOperation<TimeoutResult>>;
  suspend(input?: SuspendRequest, options?: WaitOptions): Promise<SuspendResult>;
  submitSuspend(input?: SuspendRequest, options?: WaitOptions): Promise<AdapterOperation<SuspendResult>>;
  resume(input?: ResumeRequest, options?: WaitOptions): Promise<ResumeResult>;
  submitResume(input?: ResumeRequest, options?: WaitOptions): Promise<AdapterOperation<ResumeResult>>;
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

### Timeout control

`setTimeout` **replaces** remaining lifetime; it can shorten it. It is not an additive “extend by” call and not monotonic. Require a positive safe integer; no disable/zero mode initially. Default scope is `running-session` to preserve the old sketch; Daytona callers must explicitly select `scope: "sandbox"`. Both mappings require current `running` state in this release. No idle-timeout, pause-retention or snapshot-retention mutation is implied.

E2B: POST `/sandboxes/{id}/timeout` with integer seconds; native SDK `Sandbox.setTimeout(id, seconds * 1000, { retries: 0, ... })` is acceptable. Use observed `endAt` after ACK. Keep the initial Sandbar 60–3600-second policy bounds, matching current create configuration; document these as SDK bounds, not provider limits. Native Hobby/Pro continuous-runtime caps are 1/24 hours and can constrain the accepted deadline. No plan guessing or silently clamped success; reject known-invalid requests before effects, report native rejection, and expose actual post-read values.

Daytona: POST `/sandbox/{id}/ttl/{minutes}`, then use response/detail `autoDestroyAt`. Accept only positive multiples of 60 seconds, at most 86400 seconds under the current Sandbar configuration ceiling. Reject finer precision; do not round. Existing native TTL support also appears in published SDK 0.218.0. Native organization/region/class lifespan policy may impose tighter caps; missing entitlement data is unknown, not unlimited. This scope remains active through a subsequent suspension and can delete its saved filesystem. Resume does not reset it.

Both use provider processing time as the relative origin. Do not claim an exact acceptance timestamp, exact deletion scheduling, an atomic read/modify/write extension or pause-independent runtime budget. Inspect again to see the latest deadline. A failure to inspect after a successful ACK returns the acknowledged result with `observation: null`; a lost ACK stays uncertain even if a similar-looking deadline is later read.

### Suspension and resumption

Default `suspend()` resolves native behavior from the actual sandbox: Daytona container stop preserves private filesystem and ends processes; E2B pause preserves filesystem and memory. Optional `requirements.preserve` is an exact check of that default, not a mode selector. Reject mismatch/unknown before mutation. E2B filesystem-only mode can later be a typed connection default (`suspension.preserve`), but do not add an inactive option now. No per-call provider bag or profile-ID selection.

Only running sources with no native external mounts qualify for first-release suspend. Resume applies the same class, mount and configuration checks to the inactive resource; mounted or unknown-mount resume is also unavailable. Daytona also requires a verified container class and auto-delete disabled (negative native interval); ephemeral/immediate or timed deletion-on-stop is unavailable. Its independent hard TTL must be reported, not disabled. Reject mount-bearing sources before stop/pause; no new flush or writable-volume guarantee. Native sources with unknown mount/config facts are unavailable. Snapshot methods retain their own separate contracts; do not run suspend/resume concurrently with snapshot capture, destroy or other lifecycle changes.

Daytona: POST stop with native default graceful behavior, poll GET until stopped; no force-kill fallback. Resume from stopped or archived container by POST start, poll until started. Same native UUID, fresh processes, dropped connections. Filesystem survives native archive/start as well, without Sandbar creating a reusable snapshot. E2B: POST pause with `memory: true`; on successful ACK plus paused observation return filesystem+memory/preserved processes. Resume from paused by **one explicit** POST `/v2/sandboxes/{id}/connect`, passing configured `timeoutSeconds` (or validated `ResumeRequest.remainingSeconds`), with memory restore default and no reboot override. Poll GET for running. The resume operation itself resets the E2B session lifetime; Daytona rejects `remainingSeconds` rather than adding a second TTL mutation.

E2B does not expose paused memory provenance or a stable execution-generation identifier in the inspected detail schema. Thus a fresh-process resume cannot certify actual process continuity from `state: paused`, or trust a saved suspension receipt as current evidence after an external pause cycle. Return `execution: "unknown"` and unknown execution identity in that case; native memory-pause documentation is a conditional guarantee, not proof of this resource's current pause mode. Historical acknowledged preservation remains accessible through the recovered suspend outcome. The first E2B implementation always returns `execution: "unknown"`: application serialization cannot itself prove absence of external lifecycle writers. Reserve `resumed` for future native evidence; do not implement a history-based continuity heuristic. Daytona container resume reports `fresh`, also without a fabricated execution ID. Connections must be reopened; neither result promises live TCP continuity.

Calls are explicit mutations, not “ensure state” helpers. Already suspended/stopped `suspend` and already running `resume` reject effect-free `CONFLICT`; they do not overwrite preservation facts or extend lifetime. Native 409 after a raced E2B pause is not proof our requested memory pause completed. Transitional states reject `UNAVAILABLE` before dispatch. Expired/deleted state fails `NOT_FOUND`. Observation can later show another actor reached the desired state without promoting our operation to confirmed preservation/continuity.

## Capabilities and adapter changes

Extend `client.capabilities()` and `box.capabilities()` with one small lifecycle record. Use existing `Support<T>` meanings; connection capabilities describe implemented profiles, box capabilities additionally resolve current scope/class/state/mount/config restrictions. Access failures are unavailable, incomplete native facts unknown, unimplemented mappings unsupported. Unsupported hooks must not affect unrelated create/exec/files/destroy use.

```ts
interface LifecycleCapabilities {
  reopen: Support<{}>;
  inspect: Support<{}>;
  timeout: Record<TimeoutScope, Support<{ minSeconds: number; maxSeconds: number; stepSeconds: number }>>;
  suspend: Support<{ preserve: Preservation; processes: "terminated" | "preserved"; connections: "dropped" }>;
  resume: Support<{ sourceStates: SandboxState[]; setsSessionTimeout: boolean }>;
}
```

Bounds above are the adapter's request bounds; they are not guaranteed account entitlement. Revalidate before mutation; capabilities are observations, not reservations. Keep the existing `suspension` capability synchronized with this new per-operation surface during migration (or replace it in the same unreleased SDK change with a documented type migration); do not advertise two contradictory sources of truth.

| Operation after its slice | Daytona container | E2B | Prerequisites / limits |
| --- | --- | --- | --- |
| Reopen, inspect | Native scoped GET | Native scoped GET | Valid creation correlation and original binding; E2B teamId for key rotation |
| Guest exec/files after reopen | Existing toolbox path | GET + local envd client | Running; E2B auto-resume off and detail token present |
| Session timeout | Unsupported mapping | Supported mapping | E2B kill-on-timeout; 60–3600 s Sandbar bounds plus native continuous-runtime cap |
| Sandbox-wide timeout | Supported mapping | Unsupported mapping | Daytona multiples of 60 s; ≤24 h SDK bound, native policy may be tighter |
| Suspend | Native stop, filesystem | Native memory pause | No mounts; Daytona auto-delete disabled; E2B account/API must accept memory pause |
| Resume | Native start from stopped/archived | Native v2 connect from paused | Saved compute still exists; E2B new session timeout, process provenance may remain unknown |
| Memory suspend on Daytona / filesystem-only on E2B | Deferred VM mapping | Deferred real native mode | Not claims of native impossibility |

Use an optional public adapter hook `reopen(reference, ReadContext): Promise<SandboxInfo>` and enrich the existing `inspect` result with optional lifecycle fields, including a verified reference issued from scoped native detail. The direct SDK normalizes legacy inspect results to `reference: null`, `nativeState: null`, a receipt timestamp and unknown lifecycle facts; do not fabricate a reference from `id`. Existing third-party create/exec/files/destroy and inspect remain usable with `box.reference === null`; get and lifecycle mutations are unsupported without their hooks. Daytona/E2B create/restore decoders obtain verified detail before returning a non-null reference, retaining the allocation recovery reference if that read fails. Add `setTimeout`, `suspend`, `resume` as the existing `Mutation<Input, Value, ...>` form. Mutation inputs carry the validated sandbox reference plus the corresponding request; results above are plain serializable values. Add only `sandbox_set_timeout`, `sandbox_suspend`, `sandbox_resume` operation kinds and their result decoders. Keep provider-specific read/prepare/submit/observe code next to existing state-native fixtures. Do not route the new operations through legacy SPI orchestration or extract a new engine.

## Recovery, cancellation and concurrency

Depend on [recovery DX](sdk-recovery-dx.md) for typed partial results, recovered result typing and `onReference` on normal bound connections. Reuse its application-owned persistence hook and checkpoint ordering. No competing journal, lock service, HMAC, operation object model or continuation protocol. Applications serialize lifecycle mutations per sandbox, including external controllers if they need continuity claims; Sandbar cannot provide distributed exactly-once execution or fence dashboard changes.

Each selected mutation has one native dispatch stage. Persist reference, validated identity, requested semantics and a dispatch barrier before it; recheck cancellation immediately before dispatch. Persist ACK and resulting facts before exposing completion. No hidden native retries, no retry after timeout/connection loss, no automatic inverse action. Before dispatch cancellation has effect `none`; after possible dispatch it only stops local waiting. Use existing aborted/unknown errors with recovery references and partial facts. Polls are reads and can be retried within existing bounded read policy.

| Operation | Completion and lost-ACK treatment | Explicit continuation |
| --- | --- | --- |
| get / inspect | Repeat reads safely; never changes lifetime/state | Not applicable |
| setTimeout | ACK confirms acceptance; later GET is current deadline, not attribution. Without ACK, keep unknown and expose latest observation; do not reset again | None after possible dispatch; a new user-selected timeout is a new mutation |
| suspend | ACK + target-state read establishes completion/profile. Lost ACK may prove stopped/paused, but not E2B requested preservation; retain partial state, never guess memory | No second stage; no resume compensation |
| resume | ACK + running read establishes completion; lost ACK may show running but cannot prove our transition or execution continuity | No second stage; never resubmit connect/start |

If the inherited runtime exposes a proven never-submitted continuation, it may dispatch the single stage only after renewed validation; do not add a lifecycle-specific continuation feature. A barrier with uncertain dispatch is not “never submitted.” Native current state alone cannot authorize replay or prove attribution. Even apparent native idempotence is insufficient: E2B connect on running can extend expiry, timeout resetting is time-relative, and stop/start can affect a later execution. Preserve retained mount/snapshot references from existing recovery facts; lifecycle operations neither delete nor adopt artifacts. Existing destroy remains the explicit cleanup operation.

## Application examples

These examples describe the proposed API, not code runnable against current main. `store` is an application-owned durable JSON store; production code owns per-sandbox serialization. Normal `Sandbar.connect(e2b(...))`, `Image.prepared`, `exec` and `readFile` are existing APIs. PRs must compile the completed examples against packed public packages.

```ts
import { Sandbar, Image, type SandboxReference } from "sandbar-sdk";
import { e2b } from "sandbar-sdk/e2b";

// Invocation A. Explicit team scope survives rotation; keep the template binding stable.
const client = await Sandbar.connect(e2b({ apiKey, teamId, templateId: "base" }));
const box = await client.sandboxes.create({ environment: Image.prepared("base") });
if (!box.reference) throw new Error("Provider cannot issue a reopenable identity");
await store.put("workspace", JSON.stringify(box.reference));
await client.close(); // does not destroy compute

// Invocation B, with a current valid key for the same team.
const next = await Sandbar.connect(e2b({ apiKey: rotatedKey, teamId, templateId: "base" }));
// get validates this untrusted JSON at runtime; the cast is not validation.
const saved = JSON.parse(await store.get("workspace")) as SandboxReference;
const reopened = await next.sandboxes.get(saved); // NOT_FOUND is a terminal absence, never create
const info = await reopened.inspect();
if (info.state === "running") {
  await reopened.setTimeout({ remainingSeconds: 900 });
  const output = await reopened.exec(["printf", "still the same workspace"]);
  console.log(output.stdoutText());
}
await next.close();
```

```ts
// Under the application's per-sandbox lease; client has the recovery DX onReference hook
// persisting every operation checkpoint before dispatch (see sdk-recovery-dx.md).
const suspended = await box.suspend(); // Daytona files; E2B files + memory
await store.put("workspace", JSON.stringify(suspended.reference));
// Later, even in a new process:
const sleeping = await client.sandboxes.get(savedReference); // does not wake it
const resumed = await sleeping.resume(); // explicit native transition
console.log(resumed.execution); // fresh / unknown initially; never an invented generation
const bytes = await sleeping.readFile("/home/user/work.txt");

// Daytona lifetime is explicitly sandbox-wide and keeps ticking during suspension:
await daytonaBox.setTimeout({ remainingSeconds: 900, scope: "sandbox" });

// A requirement checks the configured default; it does not select a different native mode:
await e2bBox.suspend({ requirements: { preserve: "filesystem+memory" } });
```

On an aborted/uncertain mutation, persist the error's operation reference, use existing `client.recover(reference)` and observe/wait for typed partial outcomes. `sandboxes.get(resourceReference)` reopens compute; it does not recover a mutation. Do not catch uncertainty and call suspend/resume/setTimeout again. With no durable `onReference` hook, process loss can lose the operation record: the resource can still be inspected, but its current state is not proof of that lost operation.

## Evidence and exact native recipes

Public research checked September 29, 2026; **no paid/live calls, account probes or new live qualification**. Documentation describes guarantees; pinned source establishes request behavior, not the deployed backend's exact timing. Unverified field availability, external races, precise expiry enforcement and E2B execution identity remain untested/unknown, not implementation blockers when represented honestly.

- **Daytona baseline:** Sandbar uses direct fetch against the v0.218 REST/toolbox surface, not `@daytona/sdk` at runtime. Existing `state-native.ts` already implements stop/read/start for cold snapshots; reuse request/error conventions, not the capture workflow. Published [SDK 0.218.0 Sandbox source](https://unpkg.com/@daytona/sdk@0.218.0/esm/Sandbox.js) implements `setTtl` and start/stop. Keep single-attempt fetch mutations; do not adopt its retrying connection adapter.
- **Daytona current schema:** [official OpenAPI](https://www.daytona.io/docs/openapi.json), fetched SHA-256 `ae430ff2feb4df0f4c71958b5ac64f837e935ffe85042793eb5588ab7c354379`, identifies itself as API `1.0`; docs UI is v0.220. Inspect `Sandbox` fields `id`, `organizationId`, `target`, `sandboxClass`, `labels`, `volumes`, `autoStopInterval`, `autoDeleteInterval`, `autoDestroyAt`, and `state`. GET `/sandbox/{id}`; POST `/sandbox/{id}/stop`, `/start`, `/ttl/{ttlMinutes}`. TTL response is a Sandbox, not an operation-generation receipt. The schema also documents organization/region/class lifespan caps. Do not label this fetched schema “pinned v0.218.” Revalidate compatibility fixtures when implementing.
- **Daytona guarantees:** [persistence](https://www.daytona.io/docs/en/persistence/) distinguishes container filesystem survival from VM memory pause; [sandbox lifecycle and TTL](https://www.daytona.io/docs/en/sandboxes/#wall-clock-ttl) specifies hard expiry from the last reset and native stop/archive/start. [setTtl reference](https://www.daytona.io/docs/en/typescript-sdk/sandbox/#setttl) points to `autoDestroyAt` after refresh. Current server internals are private; the [retired public repository](https://github.com/daytonaio/daytona/blob/ec4c21b2d597091ac09ecc278f3bcc172575a987/README.md) cannot prove current scheduler precision or mutation idempotency.
- **E2B pin:** runtime `e2b@2.51.0`, tag commit `ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b`. [Sandbox constructor/connect](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/packages/js-sdk/src/sandbox/index.ts#L123), [control API implementation](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/packages/js-sdk/src/sandbox/sandboxApi.ts#L1269), and [schema](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/packages/js-sdk/src/api/schema.gen.ts#L2476) establish GET, pause `memory`, timeout and v2 connect payloads. `Sandbox.getInfo` omits the returned envd access token. Use a bounded raw GET `/sandboxes/{id}` to read `envdAccessToken`, `envdVersion`, `domain`, lifecycle, state and metadata; verify scope first, then locally `new Sandbox({ ...fixedConnectionOptions, sandboxId, envdVersion, envdAccessToken, sandboxDomain: domain })`. Its constructor is publicly callable in this pin but annotated internal: isolate it in transport and test against the packed dependency. Never serialize the token, log it, accept arbitrary origins, or issue POST connect to refresh it. Missing credentials/unsupported detail fields make guest access unavailable. This is source-derived feasibility, not live proof.
- **E2B retries/auto-resume:** [API transport](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/packages/js-sdk/src/api/index.ts) wraps requests in rate-limit retry; preserve `retries: 0`. [Auto-resume docs](https://docs.e2b.dev/sandbox/auto-resume) include guest operations as triggers. A constructor bypass alone does not disable server auto-resume. Fixed trusted routing and verified `autoResume: false` are both required; regression fixtures must inspect actual HTTP calls, not merely adapter callbacks.
- **E2B lifecycle guarantees:** [persistence](https://docs.e2b.dev/sandbox/persistence) documents memory/process restoration, connection loss, indefinitely retained paused compute, and continuous-runtime caps; retention is not a billing guarantee. [Filesystem-only pause](https://docs.e2b.dev/sandbox/filesystem-only-snapshots) is explicitly real but deferred. [Get sandbox](https://docs.e2b.dev/api-reference/sandboxes/get-sandbox) exposes `startedAt`/`endAt`, not a generation or pause-memory receipt. [Timeout API](https://docs.e2b.dev/api-reference/sandboxes/set-sandbox-timeout) resets expiry relative to the current request. Pinned pause maps native 409 to false; do not convert it to a memory-preservation success. Native availability can vary during rollout; 503 must not trigger mutation replay.

## Delivery and acceptance

Estimates include API, adapters, deterministic tests and docs; they are review-complexity estimates, not line-count commitments. Each implementation PR should remain roughly a few hundred production lines plus focused fixtures/examples, with PR1/PR3 potentially approaching a low-thousands total diff because of native-boundary tests. If either needs another broad state framework or many thousands of production lines, cut scope as indicated instead of growing a foundation PR.

| PR | Independently useful scope | Dependencies / likely complexity | Acceptance and explicit cut line |
| --- | --- | --- | --- |
| 1. Reopen and inspect | Saved sandbox references, get, enriched inspect, both providers; E2B read-only guest attachment for existing exec/files | Current main; moderate, roughly 2–4 focused engineering days plus review. Coordinate any create/restore decoder changes with recovery DX | Fresh-process file/exec flow, state/deadline/errors and key rotation fixtures; no implicit connect/start/timeout. If E2B attachment proves incompatible, ship Daytona first and retain E2B control-plane inspection with guest access unavailable; do not add a new envd client framework. No mutations or generic transition engine |
| 2. Reset explicit native timeout | setTimeout + submit form, E2B session and Daytona sandbox scopes, recovery, docs | PR1 + merged recovery DX; small, roughly 1–2 days plus review | Exact units/bounds, unsupported scopes before effects, ACK vs lost ACK, observed deadline and packed examples. No idle policy, retention setters, zero/disable or lifetime automation |
| 3. Suspend/resume | Daytona container stop/start and E2B memory pause/connect, single-stage recovery and default requirements | PR1 + recovery DX; PR2 recommended for examples but not mechanically required; moderate, roughly 3–5 days plus review | Same logical ID, filesystem/process distinctions, unknown execution identity, no replay, expired state and dropped connections. If too large, initial release keeps Daytona suspend/resume and defers E2B mutations explicitly; no filesystem-only E2B mode, VM profiles, mounted suspension or capture integration |

Minimal offline coverage uses existing adapter/runtime and native HTTP fixtures, with no new certification framework:

1. PR1: create/restore/recovered-reference JSON roundtrip into a fresh connection; forged/malformed/wrong-scope/marker references; E2B same-team rotation and key-scope rejection; stable template binding; 404 vs 403 vs 5xx; stopped/paused/unknown states; deadline absence/invalid timestamp/clock skew. Exercise real pinned E2B client against fake HTTP through exec/read/write/observation, including pause between preflight and guest request: no control-plane POST, no auto-resume, no replay or timeout extension. Ensure auto-resume true/missing and missing token fail before guest IO.
2. PR2: units, non-multiple Daytona timeout, unsupported scope/state/cap, cancellation before/after barrier, ACK with failed follow-up GET, lost ACK and repeated observation without another POST. Recovery JSON survives a fresh client; relative reset is never treated as idempotent.
3. PR3: defaults/exact mismatch, class/mount/auto-delete gates, expired source, current and raced source state, E2B pause 409/503, ACK/poll failures, lost responses, stale observation ordering, same ID and no invented generation. Verify native request counts and no create/capture/delete/implicit restart. Reuse recovery-DX checkpoint failure tests rather than duplicating its exhaustive suite.

Extend the [maintained public-SDK Bun suites](../packages/sdk-qualification/provider-qualification/README.md) with only `lifecycle-reopen`, `lifecycle-timeout`, `lifecycle-suspend-resume` scenarios. Each requires later **explicit live authorization**, actual public methods, fixture/packed checks first, actual tested-revision provenance, and separate passed/failed/unsupported/blocked/not-run evidence. Branches and merged revisions use the maintained Bun suites and shared fixtures; no bespoke lifecycle runner is needed. Representative plan per provider: one owned compute allocation, peak one, borrowed prepared image, no builds/volumes/reusable snapshots; exercise ≤10 minutes, teardown ≤2 minutes. Daytona hard TTL ≤15 minutes including any reset; E2B each active session ≤5 minutes, at most one explicit pause/resume. Paused E2B has no automatic retention expiry: approval must cover residual storage and durable explicit kill reconciliation after interruption. Persist identity/checkpoints before effects; reuse the private ledger and admission lock, never a disposable cleanup record.

- PR1 live: write known bytes, close, new process opens reference, inspects, reads and execs; repeat after deletion to assert absence. Use ordinary team/organization identity; rotation/adversarial faults stay offline unless separately authorized. Confirm E2B deadline was not extended by reconnect/guest access.
- PR2 live: change remaining lifetime once, inspect provider deadline with a tolerance bounded by request duration/clock uncertainty, verify scope/precision rejection is effect-free, then explicit cleanup. No waiting for multi-hour caps or asserting exact deletion time.
- PR3 live: write/read bytes, launch a bounded background counter through existing exec, suspend, reopen while inactive, assert guest calls do not wake it, explicitly resume and verify identity/files. Daytona old process absent; E2B correlated memory-pause process/counter continues. A PID alone is insufficient continuity evidence. Teardown from both active and inactive paths across the fixture/live selection; clean the one logical sandbox, never its borrowed template. Streaming-process APIs are not required.

Run implementation gates appropriate to the changed packages: focused tests, sequential `check`/builds, `test`, lint/format, `package:smoke`, `docs:check` and required CI. This spec PR needs Markdown/link/type-sketch verification and existing docs gates only; it adds no runnable API or provider qualification claim.

## Decisions to accept and later documentation edits

The recommendations above resolve the research questions; three product choices need acceptance before the affected implementation, not more broad provider research:

- PR2: preserve session scope as the default while adding explicit sandbox-wide TTL. This extends §4's session-only wording without silently mapping Daytona TTL to a session.
- PR3: replace mandatory exact preservation with a native no-argument default plus optional exact requirement; initially ship only container filesystem and E2B memory profiles.
- PR3: replace mandatory execution-generation output with native evidence or explicit unknown, and permit E2B fresh-process resume without claiming process continuity when current pause provenance is unavailable.

Keep PR1 unblocked by these choices. Implementation must pass the concrete pinned-constructor/token-routing fixture before advertising E2B guest reopening; if it fails, use the PR1 cut line above, not an unsafe fallback. Live behavior remains unqualified until authorized acceptance runs; undocumented precision and generation IDs are deliberately not promised.

Do not edit concurrent owners' files in this research PR. After acceptance, the docs owner should link this file from ROADMAP's lifecycle paragraph and `specs/README.md`; replace §4 examples/mandatory preservation and generation language with a short link plus accepted semantics; update §8 step 4 accordingly. Implementation PRs update provider guides, lifecycle examples, capability/API references and only the affected maintained runner/support rows. Preserve historical live revision/configuration evidence. The separate volume cleanup-policy task and global roadmap/index completion remain with their owners.
