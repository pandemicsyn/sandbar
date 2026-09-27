# First-class custom adapters

**APPROVED IMPLEMENTATION DIRECTION — NOT IMPLEMENTED.** September 27, 2026. This proposes replacing parts of the current provider SPI and service integration. The examples below are proposed APIs, not runnable imports today. There are no external users to preserve compatibility for: optimize the final author and consumer experience, then migrate our built-ins. The user authorized implementation of this adapter DX direction on September 27, 2026. Live provider calls, publication and adoption of Effect remain separate decisions.

## Outcome

An application author should install the SDK for built-in providers, or the SDK plus a custom adapter package, supply credentials and create a sandbox. An adapter author should implement the provider operations they actually support, without reproducing Sandbar's reference sealing, error mapping, polling, capability booleans, credential persistence or operation ledger.

The first useful adapter supports creating and destroying managed sandboxes. Exec, files, inventory, native operation polling and lost-response discovery are independent additions. A synchronous provider without recovery support is valid: an uncertain result remains unknown. It is not valid to describe a timeout as a rejected operation or to retry it silently.

Use **adapter** for the implementation, **provider** for its stable registered name, **connection** for one verified credential/configuration binding, and **sandbox** for a managed resource. `destroy()` affects remote compute; `close()` releases local client resources and stops local waiting.

## Compatibility and current scope

The user explicitly requires zero backward compatibility: this package has never had users. Optimize the final SDK and standalone service design. Remove superseded constructors, aliases, old SPI execution paths, legacy reference readers and compatibility-only migrations rather than keeping parallel implementations. Update built-ins, tests and active documentation together. Existing design sketches and earlier preservation instructions do not require retaining unpublished interfaces.

This does not relax correctness within the new design: current-version references must survive supported restarts, ambiguous effects must not replay, scope and credential boundaries must hold, and binary data must remain exact. A clean development schema and explicit fresh-database setup are acceptable; do not automatically delete user files, databases or provider resources. Obsolete development databases/references may be rejected clearly instead of migrated.

Effect research is parked at the user's request. It is neither an adoption gate nor a prerequisite for completing or releasing this implementation. Use one Promise-based SDK execution path now; add no Effect dependency, placeholder entry point or abstraction solely for a hypothetical future rewrite. Preserve the experimental research separately for later reconsideration.

## What changes from today

### SDK-first product and dependency direction

Sandbar's primary product is `sandbar-sdk`: one sandbox API with first-class custom adapters. The default quickstart installs the SDK with its built-in adapters, supplies provider credentials, and creates a sandbox without a Sandbar server, database, project or stored connection. The optional service is a separately installable SDK consumer and a reference application demonstrating shared credential custody, durable operation tracking, HTTP access and the management UI. It remains a supported application with its own operational requirements; it is not a prerequisite for ordinary SDK use.

The service must execute provider operations through supported public SDK APIs, using the same adapters, validation, result/error semantics, binary handling, references and observation behavior as other applications. It must not maintain a second privileged provider execution path. SQL admission, credential encryption, authentication, projects, scheduling and the UI belong to the service. Neither the SDK nor an adapter may depend on that service or its database.

Durable orchestration needs more than calling an ordinary convenience method and saving its result. The service must persist operation identity and its submission marker before provider effects, persist accepted recovery-token updates, and recover by observation without replaying ambiguous mutations. Propose the smallest public advanced SDK lifecycle surface needed to support those boundaries before changing the runner; the same surface must be usable by an application integrating its own workflow engine. Keep it optional and out of the basic quickstart. Do not invent a generic persistence framework or expose SQL-specific concepts in the SDK.

Qualify the service as an external consumer: install actual packed SDK, service and adapter artifacts, typecheck against published declarations without workspace aliases/private imports, then start the service and exercise HTTP submission, restart and observation-only recovery. Package all service-owned implementation dependencies deliberately; do not make every workspace package public solely to resolve imports. Document the service as a reference application separately from a small runnable example, so beginners need not read authentication or database code to understand the SDK.

The current `ProviderDriver` requires capabilities, preparation, create, inspect, inventory, exec, files, destroy and observe. Direct callers also construct a scope/driver pair. The service registry merged with Daytona has separate registration validation and connection factories; HTTP connection schemas enumerate built-in provider names. These are useful implementation foundations, but they are not the proposed public authoring API.

Replace them with one `defineAdapter` definition usable by direct clients and service hosts. Make operations optional, derive structural support from their presence, generate driver plumbing internally, and accept arbitrary registered provider names in HTTP contracts. Built-ins must use the same public authoring API and conformance kit as third parties. Do not retain a permanently superior internal path for built-ins.

Keep the existing consumer resource model (`sandboxes.create`, operation handles, binary results and `recover`) where it remains useful. Changes to scope/reference versions, provider factories, registration, schemas and packaging are explicitly allowed. Do not distort the design to keep an unpublished SPI source-compatible.

### Schema ownership and OpenAPI

The user explicitly approved removing the catch-all `@sandbar/contracts` package. Keep portable sandbox/execution inputs, results, errors and their runtime validation with the SDK; keep adapter definition types and helpers with the adapter authoring API. Reuse lower-level portable definitions through an acyclic dependency direction instead of duplicating their validation or creating a replacement public contracts package. A small private shared module is acceptable only where the actual dependency graph requires it.

HTTP request/response envelopes, authentication schemas, routes and OpenAPI generation belong to the standalone service. The service may compose SDK-owned definitions into its HTTP schemas, but the core SDK and adapter authoring graph must not import service HTTP schemas, OpenAPI generation or a service runtime. Keep service-client HTTP code isolated from normal SDK use; choose its package/subpath placement so it does not create an SDK-to-service-to-SDK dependency cycle. There is no compatibility requirement to preserve the existing remote-client entry point.

Remove the old contracts workspace and obsolete dependencies/build steps once all consumers have moved. Update service OpenAPI generation, reference drift checks, docs and packed-consumer qualification together. Maintain current-version wire validation, public error identity, binary bounds and scope/recovery/no-replay guarantees. Do not remove runtime validation merely because the old package disappears.

## Package and import surface

[Public packages and adapter conventions](package-conventions.md) is the accepted naming and packaging decision. The SDK is `sandbar-sdk`, built-ins use `/daytona`, `/modal` and planned `/e2b`, authoring uses `sandbar-adapter`, and the optional service uses `sandbar-service` with `/client`. Additional maintained integrations use `sandbar-<provider>`. E2B and those additional integrations remain future implementation work; do not add placeholder exports or claim support now.

```ts
import { defineAdapter } from 'sandbar-adapter';
import { Sandbar } from 'sandbar-sdk';
import { createService } from 'sandbar-service';
import { adapterSuite } from 'sandbar-adapter/testing';
```

`sandbar-adapter` contains portable definition types, validation and small result helpers. It must not import the SDK, service, database, fake server or native provider SDK. Its testing subpath has a separate dependency graph. `sandbar-service/client` must not import hosting/SQL/UI code. Public service hosting keeps its Bun/SQL requirements outside normal SDK use. Built-in provider factories and ordinary custom definitions use the same connection engine; see the naming decision for the target convenience example.

A third party publishes, for example, `@acme/sandbar-adapter`, exporting `acme` and its configuration types. It declares a compatible `sandbar-adapter` peer range so public error/helper identities are not duplicated. No central catalog or Sandbar source change is necessary. Provider IDs are immutable lowercase names using letters, digits, dots and hyphens, 1–128 characters, beginning and ending with a letter or digit; use `acme` or `example.acme`. npm package name and provider ID are separate concepts. Duplicate registration fails at host startup; installed packages never register themselves as an import side effect.

## Small adapter: create and destroy

The example assumes an illustrative Acme client with authenticated `whoami`, a prepared-image spawn API that really blocks all guest egress and private ingress, a single-attempt transport, and a deletion API whose successful response confirms compute termination. Those are adapter obligations, not properties Sandbar can infer from method names.

```ts
import { z } from 'zod';
import { defineAdapter } from 'sandbar-adapter';
import { AcmeClient } from './acme-client.js';

export const acme = defineAdapter({
  name: 'acme',
  config: z.strictObject({ region: z.string().min(1) }),
  credentials: z.strictObject({ token: z.string().min(1) }),

  async connect({ config, credentials, host }) {
    const client = new AcmeClient({ token: credentials.token, retries: 0 });
    host.onClose(() => client.close());
    const account = await client.whoami({ signal: host.signal });
    return {
      scope: {
        authority: { kind: 'account', id: account.id },
        partition: { region: config.region, endpoint: client.origin },
      },
      supports: {
        images: ['prepared'],
        network: ['blocked'],
      },
      async create(input, ctx) {
        const box = await client.spawn({
          imageId: input.image.value,
          region: config.region,
          blockAllEgress: true,
          public: false,
          requestId: ctx.submissionId,
          signal: ctx.signal,
        });
        return { id: box.id, state: box.ready ? 'running' : 'unknown' };
      },
      async destroy(box, ctx) {
        await client.deleteAndWait(box.id, { signal: ctx.signal });
        return { computeStopped: true, retainedResources: [] };
      },
    };
  },
});
```

No custom `NativeScope`, invocation IDs, base64, `DriverResult`, repetitive capabilities object, inventory stub, file stub, fake SQL bridge or observation stub is required. Omitted recovery produces a standard unknown outcome after ambiguous submission. The framework does not pretend that passing `requestId` proves native idempotency or recovery.

`create` and `destroy` are required for a managed-compute adapter. `destroy` may return a pending acknowledgement or unknown outcome if termination cannot be confirmed; it must actually attempt provider cleanup when invoked. Providers without a deletion API cannot claim this managed-compute adapter contract. Importing only pre-existing compute or non-compute resources is a separate future design, not another mode in this proposal.

## Consumer experience

```ts
import { Sandbar, Image } from 'sandbar-sdk';
import { acme } from '@acme/sandbar-adapter';

const sandbar = await Sandbar.connect({
  adapter: acme,
  config: { region: 'us' },
  credentials: { token: process.env.ACME_TOKEN! },
});
try {
  const box = await sandbar.sandboxes.create({
    environment: Image.prepared('image-123'),
    networkPolicy: 'blocked',
  });
  await box.destroy();
} finally {
  await sandbar.close();
}
```

`Sandbar.connect` is the new async direct constructor; it validates and performs read-only connection verification. It owns the resulting session. Replacing `Sandbar.direct({ provider: await acmeProvider(...) })` eliminates two lifecycle objects and two names for the same action. The remote client belongs to `sandbar-service/client`; service authentication stays independent of provider credentials. The old SDK remote entry point is not retained for compatibility.

`close()` is idempotent, prevents new calls, stops SDK-owned waiting and invokes registered release hooks exactly once. It never destroys sandboxes. A connect failure also runs registered hooks. Release errors are observable through diagnostics, but must not replace an already produced mutation outcome/reference. A borrowed-client adapter registers no close hook; ownership must be documented. An abort signal can stop cooperative transport, but neither abort nor close proves compute cancellation.

A sandbox returned by the small adapter has inspect/exec/file methods for a consistent runtime interface, but unsupported calls reject locally with `UNSUPPORTED` before identity allocation or provider IO. `box.supports('exec')` and `sandbar.capabilities()` expose structural support and configured limits; they do not promise current capacity or authorization. Static typing can narrow a direct client's capabilities from its adapter, but generic and remote clients must keep the same checked runtime behavior. Do not make users understand conditional types just to call `create`.

## Definition and operation types

These are proposed signatures, not a complete `.d.ts`. Public schemas use Zod with a pinned supported major, already used by Sandbar. Inputs to config and credential schemas must be JSON values; outputs must also remain bounded JSON values. Disallow async schemas and class/Date/function outputs. JSON Schema generation and field descriptions drive service forms. Unsupported schema refinements remain enforced on the server and render as a JSON editor, never silently weakened.

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Scope = {
  authority: { kind: string; id: string }; // authenticated account, workspace or app
  partition: Readonly<Record<string, string>>; // region, canonical endpoint, etc.
};
type Sandbox = { readonly id: string }; // current verified session supplies scope

type HostContext = {
  readonly signal: AbortSignal;
  readonly policy: Readonly<Json>; // host-owned deployment policy, never request input
  onClose(release: () => void | Promise<void>): void;
};
type AttemptContext = {
  readonly operationId: string;
  readonly submissionId: string;
  readonly invocationKey: string;
  readonly signal: AbortSignal;
};
type ObserveContext = ReadContext & ObservationOutcomes;
type RecoveryAttempt = Pick<AttemptContext, 'operationId' | 'submissionId'> & {
  readonly sandbox?: Sandbox;
  readonly token?: Json;
};

declare function defineAdapter<C extends z.ZodType, K extends z.ZodType>(definition: {
  name: string;
  config: C;
  credentials: K;
  connect(input: {
    config: z.output<C>;
    credentials: z.output<K>;
    host: HostContext;
  }): Promise<AdapterSession>;
}): AdapterDefinition<C, K>;

type AdapterSession = {
  scope: Scope;
  create: CreateOperation;
  supports: Guarantees; // images/network; exec commands/output limits when present
  destroy: Mutation<Sandbox, DestroyValue>;
  inspect?: (box: Sandbox, ctx: ReadContext) => Promise<SandboxValue | null>;
  exec?: ExecOperation;
  files?: {
    maxBytes: number;
    read?: (input: { sandbox: Sandbox; path: string }, ctx: ReadContext)
      => Promise<Uint8Array | ReadableStream<Uint8Array>>;
    write?: FileWriteOperation;
  };
  inventory?: (input: { cursor?: string; limit: number }, ctx: ReadContext)
    => Promise<{ items: SandboxValue[]; nextCursor?: string }>;
};

type Mutation<I, V, P = I> =
  | ((input: I, ctx: AttemptContext) => Promise<V | Pending | Unknown | Rejected>)
  | {
  recovery?: { version: number; token: z.ZodType<Json> };
  prepare?: (input: I, ctx: ReadContext) => Promise<P>;
  submit: (input: P, ctx: AttemptContext) => Promise<V | Pending | Unknown | Rejected>;
  observe?: (attempt: RecoveryAttempt, ctx: ObserveContext) => Promise<V | Pending | Unknown | null>;
};
// A plain method is shorthand for submit with no preparation or observation.
// The advanced object infers P from prepare; without prepare, P=I.
// Session supports declares guarantees, not duplicate method-presence booleans:
// images/network; exec: { commands, maxOutputBytes }; fileWrite: { overwrite }.
// AttemptContext adds pending(token, { pollAfterMs? }), reject(code, message),
// and unknown(reason). ObserveContext has pending/unknown but NEVER reject.
// Scope/result/ref validation and timestamps are owned by Sandbar in both forms.
```

`ReadContext` supplies `signal` and a bounded deadline, without mutation identity. Framework bounds all strings, JSON, IDs and recovery tokens; select numeric limits in the implementation spec from existing contract limits, not unbounded recursive JSON. Schemas are strict by default. Credential errors report field paths and static messages without values; arbitrary schema error text and native errors are not returned verbatim.

All native handles stay inside the session. Sandbar passes serializable native IDs; an adapter may privately cache SDK handles or retrieve them read-only by ID. A process restart cannot depend on that cache. `Scope` is validated, detached and frozen by Sandbar; its canonical identity combines provider name, authenticated authority and sorted partition entries. Direct binding derives from provider name and the verified scope, not a randomly generated client-instance ID, so reopening the same configured account can import a saved reference. Service binding additionally includes the persisted project/connection ID. Credential rotation within the same verified authority does not itself change scope; every configuration field that changes native resource identity or routing must appear in the canonical partition. Provider code must bind every native operation and returned resource to that scope, including detail reads after listing when list payloads omit ownership. Merely copying the requested account string into `scope` is not verification.

`defineAdapter` contextually types each operation field and narrows command forms using its declared guarantees. Advanced objects infer normalized submission input from `prepare`. The destroy method takes a sandbox directly; create and exec take their typed request input. Compile-test both method and object forms without explicit generics, `any`, or author-side assertions before settling the signatures. The abbreviated types above describe semantics, not a claim that the full inference implementation already exists.

Ordinary success uses plain operation-specific data: create returns `{ id, state }`, exec returns `{ exitCode, stdout, stderr, truncated }`, destroy returns `{ computeStopped, retainedResources }`, and write returns `{ bytesWritten }`. No mandatory `mutation`, `sandbox`, `execution` or `destroyed` wrappers. Sandbar knows which operation it called and validates its corresponding result, attaching scope, reference kind, correlation and timestamps. Byte streams/buffers remain binary; encoding belongs to the framework.

Only exceptional lifecycle outcomes use contextual constructors: `ctx.pending(token, { pollAfterMs })`, `ctx.reject(code, message)` and `ctx.unknown(reason)`. These produce unambiguous branded internal outcomes distinct from ordinary success objects. `pending` requires the advanced operation's declared token schema; `reject` is available only during submission and certifies no effect. A thrown error never carries that certification. Framework defaults handle unsupported operations and unknown outcomes without placeholder methods.

## Advanced adapter: request preparation, asynchronous execution and discovery

An adapter with exec adds one operation to the same session. The following fictional native API retains a job under a stable client request ID. Its client request ID lookup is scoped by authenticated account and resource, and lookup does not run the command. `readJobResult` must return bounded streams or bytes and verify job/sandbox/operation/submission agreement; it is provider mapping code, not a hidden framework facility.

```ts
import { AdapterError } from 'sandbar-adapter';

// Inside connect's returned session, alongside
// supports.exec: { commands: ['argv'], maxOutputBytes: 1_048_576 }
exec: {
  recovery: { version: 1, token: z.strictObject({ jobId: z.string().min(1) }) },
  async prepare(input, read) {
    const box = await client.getSandbox(input.sandbox.id, { signal: read.signal });
    assertSameAccountAndRegion(box, account, config.region);
    if (!box.running) throw new AdapterError('UNAVAILABLE', 'Sandbox is not running');
    return input; // read-only; no start/resume, image build or execution
  },
  async submit(input, ctx) {
    const reply = await client.startJob({
      sandboxId: input.sandbox.id,
      argv: input.command.argv,
      cwd: input.cwd,
      env: input.env,
      requestId: ctx.submissionId,
      operationId: ctx.operationId,
      timeoutSeconds: input.deadlineSeconds,
      signal: ctx.signal,
    });
    if (reply.kind === 'rejected-before-acceptance') {
      return ctx.reject('CAPACITY', 'Provider capacity is unavailable');
    }
    return ctx.pending({ jobId: reply.jobId }, { pollAfterMs: 500 });
  },
  async observe(attempt, ctx) {
    const job = attempt.token
      ? await readValidatedJobToken(attempt.token, attempt.sandbox, attempt)
      : await client.findJob({
          sandboxId: attempt.sandbox.id,
          requestId: attempt.submissionId,
          operationId: attempt.operationId,
          signal: ctx.signal,
        });
    if (!job) return null; // missing evidence is never effect:none
    assertJobMatchesAttemptAndScope(job, attempt, account, config.region);
    if (!job.done) return ctx.pending({ jobId: job.id }, { pollAfterMs: 500 });
    const result = await readJobResult(job, ctx.signal);
    if (!result.complete) return ctx.unknown('Execution outcome cannot be established');
    return result;
  },
}
```

The example is a sketch of the `exec` field, not a second registration API. `CreateOperation`, `ExecOperation` and `FileWriteOperation` supply typed inputs (existing SDK command/image unions), so argv access is narrowed by `supports.exec.commands: ['argv']`. A shell adapter implements shell explicitly; Sandbar must not secretly convert argv into shell or claim quoting correctness on behalf of an author. Exec/destroy/write observation attempts require a sandbox; create observation attempts lack it until native identity is known. The abbreviated shared recovery types above must become operation-specific types in implementation. `observe(attempt, ctx)` receives identity/token/sandbox separately from the bounded read signal and pending/unknown constructors.

Native accepted-job tokens are bounded, validated, versioned adapter JSON, not SDK objects. Add `recovery: { version: 1, token: schema }` to the operation when tokens are used; missing tokens are permitted for a response lost before acknowledgement. Token schemas cannot include credentials, authorization headers or credential-bearing URLs. A failed token parse never dispatches. Adapter upgrades reject unsupported versions explicitly rather than guessing.

## Mutation semantics the wrapper must enforce

| Point | Framework behavior |
|---|---|
| Input/config/capability validation | Validate and snapshot before identity/admission; unsupported requests perform no provider IO. |
| Connection verification and `prepare` | Read-only. Failure is effect:none; no mutation marker is crossed. Service may retry transient read-only preparation under its bounded scheduling rules. |
| Immediately before `submit` | Persist service submission marker first; allocate and expose a recoverable identity in direct mode. Invoke submit once for this attempt. |
| Submit returns value | Validate correct operation result and scope; success evidence belongs to this callback's attempt. Malformed output after dispatch is unknown with reference. |
| Submit throws, transport aborts, times out or returns unknown | Unknown with recoverable reference. A thrown `AdapterError` does not prove no effect. Never rerun submit. |
| Submit returns `ctx.reject(...)` | Author explicitly certifies request was not accepted and no effect occurred. Terminal rejection; requires provider-specific evidence and fixtures. |
| Submit returns `ctx.pending(...)` | Persist token before next poll when available; poll observe only. Lack of observe is an unknown terminal view, not an infinite spinner. |
| Observe returns null / throws / returns unknown | Preserve prior evidence/reference; unknown or pending as appropriate. An explicit later observation may succeed. Do not permanently cache transient unknown outcomes. |
| Observe returns completion | Adapter must correlate native evidence to the exact operation, submission and scope. Framework binds the resulting public reference; it cannot validate provider-specific labels by itself. |
| Observe sees a provider rejection | No general rejected variant. Original mutation's effect remains unknown absent correlated authoritative completion evidence. |
| Caller cancels waiting or closes | Stop local waiting; preserve reference after submission, do not claim effect:none or remote compute cancellation. |

Do not automatically replay even if an author advertises a native idempotency key. Native same-key retry can be a future explicitly reviewed policy with retention/window/request-fingerprint guarantees; it is unnecessary for a first-class adapter API and must not make the initial API more complicated. Pinned upstream SDK mutation retries must be disabled or proven absent. A wrapper cannot prevent a native SDK from retrying internally; failing this requirement disables that mutation capability.

`prepare` may return a normalized effective image or bounded JSON internal submission input (never a native handle/client), preserving the public invocation fingerprint from the validated original request. Service recovery reuses the stored submission record and must not re-prepare and submit. No image build/import, auto-start or write belongs in `connect`, `prepare`, `inspect`, `inventory` or `observe`. Such provider side effects require separately represented mutations, outside this initial authoring scope.

Direct references remain process-durability unless native evidence supports reconstruction; a crash before the caller persists its reference can lose the pointer. Provide an optional `onReference(reference)` callback awaited **before submit**, allowing an application to save the initial identity. If it fails, no submission occurs. It does not create a local durable database or promise atomicity with provider execution. Service mode owns durable admission and token updates. Imported references verify adapter/token version, operation kind, verified scope and connection binding before IO; neither an ID nor a JSON reference grants authority.

## Network, output and capability honesty

Structural operation presence is inferred; provider guarantees are not. Create must explicitly declare supported image forms and network profiles. This first version retains `blocked` as the required consumer default: strict guest egress blocking, not an allowlist with undocumented exceptions. If the provider/account cannot establish that guarantee, create fails before submission. Do not silently fall back to public networking to make a minimal example work. An empty network list can leave inspection and cleanup usable when eligibility changes.

Account-tier/image/region prerequisites belong in read-only preparation, not a one-time static promise. Capability reporting distinguishes declared support/limits from current eligibility; connection verification proves identity, not capacity or permission forever. Returned native resources still require account, region and applicable policy validation. Inspect absence means unknown, not proof of which destroy operation took effect.

Sandbar snapshots caller inputs and byte buffers before dispatch. It caps collected output and files using validated request limits and adapter limits, converts bytes for HTTP/storage, and exposes truncation accurately. The adapter must avoid unbounded native buffering upstream of that collector; return bounded streams or use native limits. Cancelling a stream does not imply killing the remote process. Combined stdout/stderr limits have one documented allocation rule and conformance fixtures; do not let adapters invent incompatible interpretations.

Read-file, write-file and exec are independent capabilities. No automatic read-via-arbitrary-exec or write-via-shell fallback is installed by the helper. An adapter may explicitly implement a provider's own read-only filesystem helper if its side effects, retries, binary fidelity and bounds satisfy that operation's contract. `overwrite:false` requires an atomic native no-clobber guarantee or rejects before dispatch. Inventory is optional and paginated; it is not mandatory merely to implement submission lookup.

## Self-hosted service registration

The host installs trusted code and registers definitions at startup:

```ts
import { createService } from 'sandbar-service';
import { acme } from '@acme/sandbar-adapter';

const service = await createService({
  // Existing database, key-file and authentication settings remain required.
  storage: { url: process.env.SANDBAR_DB_URL!, keyFile: process.env.SANDBAR_KEY_FILE! },
  auth: { setupTokenFile: process.env.SANDBAR_SETUP_TOKEN_FILE! },
  adapters: [acme],
});
await service.listen({ port: 3000 });
```

A project creates a connection through the existing route, with structured JSON instead of the current string-only records:

```json
{
  "provider": "acme",
  "name": "Acme US",
  "configuration": { "region": "us" },
  "credentials": { "token": "provided-securely-by-operator" }
}
```

The host validates using the installed adapter schemas, encrypts credentials and configuration before persistence, and performs explicit read-only verification. Credentials never appear in connection list responses, logs, refs, capability metadata or browser form defaults. On later resolution, the verified native identity must match the stored binding. Renaming credentials, changing config semantics or rotating to a different account does not silently retarget existing resources. First-class arbitrary names do not remove project ownership checks.

Add an authenticated provider catalog endpoint (`GET /v1/providers`) exposing registered name, display metadata and JSON configuration/credential field schemas. It never connects to a provider. Because operations are returned by an authenticated session, this catalog does not infer operation support by invoking `connect`; support is reported from a verified session separately and may change with account eligibility. The management UI generates a basic form from that catalog, with a JSON fallback for complex config and masked write-only secret fields. No provider-specific form switch, fake-only image assumption or fallback to the first visible connection. Remote resource clients do not import provider packages; deployment-specific typed connection setup can optionally import an adapter's schema/types.

Definitions needing host policy add `policy: { schema, default }` alongside config/credentials; the schema's parsed output types `host.policy` and `withPolicy`. Definitions without it receive an empty immutable policy and do not expose `withPolicy`. Host policy, such as allowed credential destinations for private endpoints, is supplied by registration (`acme.withPolicy({...})`) and is inaccessible to project connection input. Default policy lives in the adapter definition; policy validation is synchronous and cannot broaden the host's configured trust from an HTTP request. This is a typed definition-cloning helper, not a second credential factory. Code installed by the host is trusted code with access to its credentials; the catalog does not download npm packages or execute tenant-supplied adapters. Direct callers choose their own policy in process.

An unregistered provider rejects new provider-dependent admissions before durable writes/reservations, while existing invocation lookup still returns prior results. Read-only records and local cleanup remain usable; already admitted unknown operations never become new attempts. Restoring the same registration and scope resumes observation. Persist the adapter contract/token version with new records; incompatible adapters fail explicitly with an actionable host diagnostic, never reinterpret old opaque tokens. No automatic historical-record migration framework is required now.

## Conformance kit and documentation as the deliverable

Ship `sandbar-adapter/testing` with a reusable suite that receives an adapter plus a deterministic provider-boundary fixture. Do not require authors to implement the fake provider wire protocol or run a Sandbar service to test direct mode.

```ts
adapterSuite({
  adapter: acme,
  fixture: createAcmeFixture,
  cases: ['create', 'destroy'], // optional operations discovered from the definition
});
```

The fixture supplies known config/credentials, read-only identity responses, bounded native resources, effect counters and transport fault controls. Operation-specific scenarios are explicit typed hooks; publishing a suite result reports which scenarios actually ran. The kit may skip unsupported exec/files/inventory, but must never silently skip required ambiguity/scope/lifecycle checks for an advertised mutation.

Required cases cover normal create/destroy, invalid inputs before dispatch, independent accounts/endpoints, late response after abort, close/release once, fault after effect with exactly one submission, unknown with reference, unavailable recovery remaining unknown, and recovery never submitting. Added capabilities bring focused binary/non-UTF8/combined-output/truncation/stream overflow, argv versus shell, no-clobber, asynchronous token/restart, conflicting labels and scope-change cases. A provider-specific fixture must demonstrate upstream hidden retries are disabled; a generic mocked callback alone cannot certify that.

Use the same definition in a service integration suite covering encrypted connection round trips, dynamic registration, catalog/form inputs, project isolation, admission/restart and scope mismatch. Package consumers must actually install packed external adapter and SDK tarballs with realistic dependency roots and run Node and Bun direct flows, remote imports and type inference. Test service HTTP resource flows explicitly; do not equate remote type imports with HTTP parity.

Publish one complete copyable `acme` fixture adapter, one asynchronous recovery example, generated API reference and a capability checklist. The examples above must become compile-tested files and executed fixtures before this proposal is described as implemented. Documentation should show the happy path first and link to uncertainty guarantees at the point an author adds mutation calls, rather than asking beginners to absorb the full internal SPI first.

## Implementation sequence and acceptance

1. Validate this authoring vocabulary and type-test the minimal/advanced sketches, including inference without explicit generics. Decide concrete plain result types, special outcome constructors and token bounds; remove any assertion needed merely to satisfy the library's types.
2. Implement the small public definition/operation wrapper and internal bridge. Migrate the fake adapter first; demonstrate that no inventory/observe/files stubs are required for a minimal create/destroy adapter. Keep any old SPI bridge temporary and internal.
3. Replace direct construction with `Sandbar.connect`, resource capability checks and unified release/error handling. Preserve reference-before-dispatch and unknown/no-replay semantics; introduce a clean reference version if scope/token shape changes.
4. Migrate Daytona and Modal using the public API and actual pinned native boundaries. Delete duplicated scope/result/error/registration plumbing where framework ownership replaces it. Preserve their honest restrictions, including unavailable mutation capabilities. Daytona and Modal provider PRs are merged; preserve their qualified behavior while migrating the active SDK branch. E2B and additional providers remain separate future work.
5. Replace service enum/string-record/provider-form switches with installed definitions, structured config and catalog-driven UI. Use the final development schema without compatibility-only upgrades. Document fresh-database setup and clearly reject obsolete development formats; never automatically erase existing files.
6. Ship the external example, conformance kit, packed Node/Bun tests and service registration docs together. Run an independent complete integrated review on each implementation PR; assess behavior as well as API shape.

Acceptance means a developer can copy the minimal example, supply a fixture/native client, and use both direct and service modes without changing Sandbar source. Missing optional features produce clear local errors. Built-ins exercise exactly the public path. Lost responses, scope mismatches and close never turn into hidden duplicate mutations. No test, example or package graph implies live provider qualification when none was run.

## Recommended decisions and remaining choices

Recommend accepting breaking changes to the unpublished SPI, unified adapter/session lifecycle, optional operations, async direct connect, open registered provider names, structured configuration, framework-owned references/results, and explicit unknown-by-default mutation behavior. These are the core DX improvements, not a cosmetic `defineAdapter` wrapper.

Public names and import paths are settled in [package conventions](package-conventions.md). Registry availability is not ownership, and publication is not authorized. The implementation should settle exact JSON/token limits and the small catalog form schema without expanding into a generic plugin platform. Effect is parked and adds no implementation requirements. This implementation does not need a generic workflow engine, arbitrary retry policy, native sandbox import, or a new provider feature family.
