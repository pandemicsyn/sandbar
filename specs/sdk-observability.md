# SDK observability and diagnostics

Implemented contract · Tracing/diagnostics and recipes merged in PR #24; metrics/events deferred

Make Sandbar operations understandable inside the application's existing observability tools. This is a fresh SDK design, independent of the removed observability/accounting proposal. It adds no billing or Effect requirement. Sections 1–6 record the tracing contract; section 7 is deferred design. Current exports and tested recipes are authoritative for implemented APIs.

Tracing and vendor recipes are implemented; no new observability work is on deck ahead of SDK usability.

## Developer outcomes

A developer should be able to answer these questions from one application trace and its correlated diagnostics:

1. What sandbox operation ran, against which provider, and with what result?
2. Where did time go: preparation, submission, provider execution/readiness, or local waiting?
3. Did an error prove rejection, confirm remote failure, stop only the local wait, or leave an uncertain effect?
4. Which existing operation/resource should they inspect, recover, or clean up next?

Setting up the application's supported Sentry, Datadog, or OpenTelemetry configuration should make Sandbar spans appear under its active request/job span. Sandbar must not require an account with a particular telemetry vendor. Applications without telemetry keep using the same SDK calls.

Instrumentation describes what Sandbar observed. It must not invent provider internals, remote execution duration, global inventory, or certainty that the provider did not supply.

## 1. Library integration and ownership

Instrument using the OpenTelemetry trace API. The application owns the tracing SDK/provider, context manager, propagators, sampler, exporters, credentials, queues, and shutdown. Sandbar does not initialize or replace globals, load vendor SDKs, install HTTP auto-instrumentation, or start an exporter. With no tracing provider registered, instrumentation is a no-op and makes no telemetry network calls.

Use a named, versioned instrumentation scope for each owning public package. Package builds must externalize the shared OpenTelemetry API instead of bundling a private copy that can disconnect context. Keep vendor exporter dependencies out of the direct SDK import graph. Custom adapters must not need an OpenTelemetry dependency to implement ordinary operations.

Proposed connection option, to integrate into the existing connect/client options rather than create a second connection API:

```ts
interface ObservabilityOptions {
  tracing?: false | {
    tracerProvider?: TracerProvider;
  };
}
```

Omission uses the application's registered global provider; `false` disables Sandbar-owned spans and Sandbar-owned propagation for that client. It cannot disable third-party HTTP instrumentation. An injected provider changes span creation only; the application still configures a compatible context manager and propagation. Add the option to the direct SDK without changing provider credential/configuration schemas.

Capture the active context at each public call, not at connection creation. Two concurrent application requests using one Sandbar client must remain in separate traces. Starting work inside an active Sandbar span must preserve that context through async provider calls. Do not retain live spans or async context objects in long-lived resource handles.

`sandbar.close()` releases Sandbar resources; it does not flush or shut down an application-owned tracer. Application examples show the appropriate bounded exporter shutdown separately, including short-lived CLI/serverless use. No observation or exporter hook may submit, retry, resume, or cancel provider work.

This follows the [OpenTelemetry guidance for instrumented libraries](https://opentelemetry.io/docs/concepts/instrumentation/libraries/). The optional provider injection is an escape hatch for application composition and tests, not a requirement for everyday use.

## 2. Operation spans and timing

Use stable operation names and bounded attributes. Never put resource IDs, commands, filenames, or native URLs in span names. Names below are proposed Sandbar conventions, not an existing OpenTelemetry sandbox standard.

| Layer | Examples | Meaning |
| --- | --- | --- |
| Public call | `sandbar.sandbox.create`, `sandbar.exec`, `sandbar.file.read`, `sandbar.sandbox.destroy`, `sandbar.image.build` | The caller-visible operation and its elapsed time |
| Submission API | `sandbar.sandbox.submit_create` | Establishing/admitting an operation handle, not waiting for remote completion |
| Operation access | `sandbar.operation.observe`, `sandbar.operation.wait`, `sandbar.operation.recover` | Read-only observation, a local wait, or reopening existing work |
| Internal phase | `sandbar.prepare`, `sandbar.submit`, `sandbar.wait`, `sandbar.observe` | A real phase boundary, with operation type as an attribute |

Cover connect, capability checks, inventory, image operations, exec, files, inspect, destroy, recovery, and close as they actually exist. Later snapshots, volumes, and lifecycle operations extend the same convention when implemented. A successful capability query returning `unsupported` is a successful query; rejection of a caller's required operation is separately represented.

Convenience methods that submit and wait produce one public-call span with phase children. Their internal calls must not also produce duplicate public `submit`/`wait` spans. Explicit user calls to those methods produce their own public spans. Direct semantic spans are INTERNAL; actual HTTP spans use the appropriate CLIENT/SERVER kinds.

HTTP auto-instrumentation may add transport children. Sandbar instruments its semantic/provider boundary and does not create a second copy of an already instrumented HTTP request. Never monkey-patch global fetch to trace Sandbar. If transport spans are absent, a provider phase still explains the time spent awaiting the adapter.

Aggregate routine polling: a wait span records poll count, time waiting, and meaningful state transitions with bounded events. Do not emit a span/event for every unchanged internal poll. Explicit `observe()` calls remain visible. Instrumentation cannot add new provider reads or change polling frequency to improve a trace.

Local elapsed time is measurable; provider execution time is included only when native evidence supplies it, with its source. Do not subtract unverified cross-host timestamps to manufacture queue or provisioning latency. End every local span exactly once on success, error, timeout, and cancellation. After local waiting ends, late native completion must not mutate the ended span or create an unbounded detached instrumentation task.

## 3. Outcomes, errors, and actionable correlation

Keep three facts separate: the result of this local call, knowledge of remote work, and effects that may already have happened.

| Situation | Required interpretation |
| --- | --- |
| Unsupported/invalid request rejected before submission | Local error; `effect=none`; no provider-submission span |
| Submission accepted/pending | Submission succeeded; operation may still be running |
| Command exits nonzero and `exec()` returns output | SDK call succeeded; record exit code, not a transport/infrastructure error |
| Caller explicitly requests success-only behavior and receives a nonzero-exit exception | That call failed its contract; effect remains applied and exit code remains visible |
| Local wait aborted after submission | Waiting stopped; remote effect remains possible; retain recovery identity |
| Transport response lost after submission | Outcome unknown; never imply rejection or retry safety |
| Read-only observation reports pending/unknown | Observation completed; underlying operation did not become successful or failed merely because of that read |
| Destruction confirmed with retained artifacts | Compute cleanup confirmed; retained storage/artifact status remains a separate fact |

Proposed attributes include `sandbar.operation.type`, `sandbar.operation.id`, `sandbar.submission.id`, `sandbar.provider`, `sandbar.mode`, `sandbar.phase`, `sandbar.call.outcome`, `sandbar.operation.state`, `sandbar.effect`, and a bounded error code. Include exit status and retained-resource counts when known. Unknown is explicit rather than encoded as zero or success. Finalize the finite outcome vocabulary alongside executable tests in the first implementation slice.

Set OTel ERROR status when the span's own API contract failed, with a fixed safe description. Expected caller cancellation uses a cancellation outcome without automatically becoming an infrastructure error. Record a sanitized exception at the boundary that surfaces the error; parent phase/call spans may carry status without repeating raw exceptions at every level.

Do not call `Sentry.captureException()` or a vendor equivalent automatically. The application owns issue creation and decides whether a caught operational error should produce an issue. Recipes demonstrate capturing once, inside the request context, with safe Sandbar correlation fields. Correlation must still work when tracing is unsampled: existing operation IDs and structured error facts remain useful even when there is no exported trace.

Provide a small public pure helper such as `diagnosticContext(errorOrOperation)` that returns a bounded allowlisted diagnostic record: safe error code, effect, operation/submission IDs where available, known operation state, and recovery availability. Its exact signature belongs in the first implementation slice. It must not serialize arbitrary error objects, native causes, recovery tokens, resource locators, or raw URLs. It performs no IO and does not change the error's identity or existing recovery API. The original error/handle remains the source for a usable recovery reference; the diagnostic record conveys correlation, not authority to recover or retry.

## 4. Context and SDK recovery

Inherit the caller's active span for direct calls. For `recover()` and subsequent observations, use the current caller context as parent and link to a validated origin context if available. Across direct-client restarts, origin context may be unavailable; operation IDs are the required fallback. Do not expand every portable recovery reference just to transport tracing metadata. Do not reopen ended spans or promise a backend will display links as a single continuous tree.

A saved operation reference and any application-owned submission marker remain independent of telemetry. Observation after a possible submission never becomes another submit, even when traces are absent. Sampling, missing context, or exporter failure cannot change operation identity, errors, outcomes, or no-replay decisions.

Default propagation into provider APIs and guest commands is off; neither is the application's trusted tracing boundary. Do not copy arbitrary baggage or request headers into adapter inputs. Third-party HTTP/native SDK instrumentation has its own propagation policy, which examples must address separately. Validate any accepted origin span context as bounded telemetry metadata; it grants no scope or authorization.

## 5. Privacy, bounds, and failure isolation

Default telemetry contains an allowlist of operation metadata. Exclude command text/argv, environment values, file paths/content, stdout/stderr, image names/registry URLs, provider credentials, signed URLs, authorization headers, full resource references, invocation keys, native recovery tokens, and arbitrary error messages/causes. Exception messages and stack text can embed user data; use controlled summaries instead of exporting raw error objects. Opaque IDs are included only when validated as safe; omit provider-native locators by default rather than assuming IDs are harmless.

No raw-payload capture option is included in the first release. Applications can deliberately record their own data using their telemetry stack. Sandbar's safe defaults cannot guarantee scrubbing by application code, vendor error capture, native SDK telemetry, or independent HTTP instrumentation; integration recipes explicitly configure those surrounding components.

Bound attributes, links, and events, use fixed truncation/drop rules, and expose a bounded dropped-event count where practical. Never recursively serialize arbitrary objects or aggregate unbounded state transitions. Tracing disabled or unsampled should avoid expensive formatting and diagnostic allocation.

Instrumentation exceptions must not replace an operation result, mask the original failure, or skip cleanup. Export is asynchronous and application-owned; Sandbar never waits for delivery on the operation path. Test throwing tracer methods/processors and bounded failing sinks. This does not promise protection against arbitrary blocking application callbacks: Sandbar introduces no synchronous user diagnostics callback into the mutation path. Failures in diagnostics must not recursively generate more diagnostics.

Measure disabled, unsampled, and sampled overhead on representative create/exec/read/write/wait fixtures, including concurrent calls. Record package size and dependency impact. Agree on a measured overhead budget during the first slice before calling the instrumentation production-ready; never claim zero overhead.

## 6. Sentry, Datadog, and runtime qualification

Support means a tested setup with pinned versions and copyable initialization, not simply that a vendor accepts OpenTelemetry somewhere in its stack.

| Recipe | Intended ownership | Evidence required |
| --- | --- | --- |
| Plain OpenTelemetry | Application initializes one SDK and exports through its chosen OTLP/local destination | Parent context, spans/links, safe metadata, sampling, shutdown |
| Sentry | Application initializes supported Sentry tracing or its documented OTel bridge | Sandbar spans under application work; explicit error capture correlated once; sampling behavior |
| Datadog | Application uses a supported OTel API bridge to Datadog, or a separately documented OTel-to-Agent/Collector setup | Same context and phase semantics, error metadata, no duplicate transport spans |

Each recipe names its supported runtime/version and package versions. Qualify Node.js and Bun independently; do not assume Node auto-instrumentation or a vendor tracer works unchanged on Bun. If a vendor-native Bun path is unsupported, evaluate the OTel export path separately and label any remaining gap. Traces, metrics, logs, and vendor issue capture have separate support claims; success for one signal does not certify the others.

Keep vendor packages in examples/qualification dependencies, never the SDK's runtime dependencies. Test emitted spans and vendor envelopes using local collectors or stubbed transports and deterministic adapters; ordinary CI requires neither vendor credentials nor paid provider resources. A real vendor UI acceptance run requires separate authorization and should confirm trace presentation, searchable attributes, and error association before advertising full end-to-end vendor qualification.

Sources checked September 28, 2026: [Sentry's OTel integration](https://github.com/getsentry/sentry-javascript/blob/develop/packages/opentelemetry/README.md), [Datadog OTel library instrumentation](https://docs.datadoghq.com/opentelemetry/instrument/dd_sdks/instrumentation_libraries/), [Datadog runtime guidance](https://docs.datadoghq.com/opentelemetry/guide/instrument_unsupported_runtimes/). These establish integration directions, not tested Sandbar compatibility. Verify exact released APIs when implementing each recipe.

## 7. Metrics and diagnostic events follow tracing

After tracing and error correlation are usable, add a small stable metric set: public-call duration in seconds, completed-call count by outcome, provider-phase duration, and local in-flight calls. Emit metrics directly from measured operations rather than deriving them from sampled spans. A per-client count is not a global fleet gauge; terminal observations are not a count of uniquely completed provider mutations.

Default dimensions are finite operation/mode/outcome/error-code classes and a bounded provider label. Map unknown/custom provider labels to `custom` unless the application configures a finite allowlist. Exclude operation/resource/tenant IDs, file paths, raw URLs, commands, exception text, and arbitrary provider errors from metric labels.

Structured diagnostic events should reuse the same sanitized schema and carry trace/span IDs when available. Decide the logger/OTel-log bridge and bounded delivery behavior in that later slice; do not introduce a mandatory logger, console noise, or a second vendor export pipeline in the tracing release. Telemetry is best effort and is never the authoritative operation journal or a billing ledger.

## 8. Implementation units and acceptance

Tracing/diagnostics and vendor recipes (units 1–2) merged in #24. The acceptance list below protects that contract; it is not an unfinished delivery plan. Metrics/events (unit 3) remain deferred.

1. **Direct SDK tracing and error diagnostics.** Finalize the operation/outcome vocabulary, packaging and connection options, public/phase boundaries, safe diagnostic helper, and disabled/global/injected-provider behavior. Cover current direct operations and an independent adapter. Add an in-memory tracing example and establish overhead measurements.
2. **Sentry and Datadog DevEx.** Deliver the three recipes above, pinned integration fixtures, runtime-specific evidence, exporter shutdown guidance, and debugging guidance for missing or disconnected spans. Mark vendor UI validation separately from local export evidence.
3. **Metrics and structured events.** Specify and implement bounded measurements, logger integration, and their separate backend/runtime coverage after the tracing contract is stable.

Local Sentry/Datadog export and runtime fixtures are separate from live vendor-UI qualification; consult the maintained observability recipes for the exact coverage. Trace names, attributes, outcomes, diagnostic-helper fields, and privacy guarantees become supported public contracts and need release notes when changed. Changes do not authorize native state operations, accounting, a telemetry database, new provider adapters, or guest instrumentation.

Required deterministic acceptance cases:

- No telemetry setup, explicit disablement, and SDK import perform no telemetry IO or global mutation; application-owned providers survive client close.
- Concurrent calls on one client inherit different active parents; nested calls preserve context, including across promise continuations on each supported runtime.
- Convenience methods do not duplicate public spans; auto-instrumented HTTP has one transport span per actual request; internal polling is bounded.
- Pre-submission rejection, pending submission, nonzero exit, unknown outcome, pre/post-submission abort, deadline, cleanup failure, and late native completion retain their actual semantics and end local spans once.
- SDK-owned propagation does not leak tracing context or baggage into provider requests or guest workloads; malformed origin context cannot affect scope or authorization.
- Recovery after direct-client process restart links when possible, correlates by operation identity otherwise, and never resubmits work. Sampling disabled does not remove the operational recovery path.
- Credentials and canary secrets placed in commands, filenames, outputs, URLs, raw causes, and stack messages do not appear in Sandbar-owned exported records or default recipe captures.
- Tracer/exporter failures do not alter return values, original errors, native call counts, application-owned submission markers, or cleanup; long waits remain bounded in telemetry memory.
- Packed Node/Bun consumers share the application's OTel API/context; SDK dependency boundaries remain intact.
- Local Sentry/Datadog qualification verifies span relationships and explicitly captured error correlation without live services. Documentation distinguishes fixture/export checks from real vendor UI evidence.

Run affected package tests, root checks, packed consumer qualification, and docs/example checks. No live provider calls, vendor account changes, paid resources, publication, or deployment are authorized by this spec.
