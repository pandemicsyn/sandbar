---
title: Tracing and safe diagnostics
description: Trace SDK work with application-owned OpenTelemetry.
---

The SDK uses the shared OpenTelemetry trace API. Your application owns the provider, context manager, sampler, exporter, credentials and shutdown. Importing Sandbar does not initialize telemetry. Without an application provider, calls perform no telemetry IO. Metrics and structured diagnostic logs are a later release. Service-client tracing, HTTP propagation, persisted context and runner spans are deferred to the distant service milestone.

## Configure tracing

The direct connection options accept `tracing?: false | { tracerProvider?: TracerProvider }`. Omission uses the application's global provider. Injection changes span creation; it still needs the application's compatible async context manager. A bound adapter accepts these options as the second argument to `Sandbar.connect(adapter, options)`.

```ts
import { Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

const client = await Sandbar.connect(daytona({ apiKey: process.env.DAYTONA_API_KEY! }), {
  tracing: false,
});
await client.close();
```

`false` disables Sandbar spans and propagation for that client. Independent HTTP instrumentation has its own policy. `close()` releases Sandbar resources; it never shuts down or flushes your provider. Initialize your telemetry before starting application work, and keep your active request/job context around each call. One shared client captures each call's current context independently.

## Plain OpenTelemetry recipe

Pinned qualification versions: `@opentelemetry/api` 1.9.1, `sdk-trace-node`, `sdk-trace-base` and `context-async-hooks` 2.11.0; `exporter-trace-otlp-http` and `instrumentation-http` 0.222.0. These are application dependencies; only the API is a Sandbar production dependency.

```ts
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

const manager = new AsyncLocalStorageContextManager().enable();
const provider = new NodeTracerProvider({
  sampler: new TraceIdRatioBasedSampler(0.1),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: "http://127.0.0.1:4318/v1/traces", // your trusted collector
        timeoutMillis: 1000,
      }),
      { maxQueueSize: 256, maxExportBatchSize: 64, exportTimeoutMillis: 1500 },
    ),
  ],
});
provider.register({ contextManager: manager });
```

Use `trace.getTracer("your-application").startActiveSpan(...)` around a request/job. The fixture uses the same released configuration and exports to a local HTTP receiver. Your collector must be trusted; exporter authentication belongs in your application's secrets configuration. Choose and test your application sampler deliberately; Sandbar does not configure sampling or propagation.

Bound shutdown separately from SDK close, especially in a CLI or serverless invocation:

```ts
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([
    provider.shutdown(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Telemetry shutdown deadline")), 2000);
    }),
  ]);
} finally {
  if (timer) clearTimeout(timer);
  manager.disable();
}
```

A deadline bounds your application's wait; it cannot forcibly terminate arbitrary blocking exporter code. Flush failures are application diagnostics and must not trigger sandbox retries.

## Sentry recipe

Pinned runtime packages are `@sentry/node` 11.1.0 for Node and `@sentry/bun` 11.1.0 for Bun. Sentry's released OTLP integration uses your existing OpenTelemetry pipeline. Use the appropriate runtime package:

```ts
import * as Sentry from "@sentry/node"; // Bun: @sentry/bun
import { diagnosticContext } from "sandbar-sdk";

const dsn = process.env.SENTRY_DSN!;
const endpoint = Sentry.getOtlpTracesEndpoint(dsn);
if (!endpoint) throw new Error("Invalid Sentry DSN");
// In the OTel setup above, use endpoint.url and endpoint.headers in OTLPTraceExporter.
Sentry.init({
  dsn,
  enableOpenTelemetrySetup: false,
  defaultIntegrations: false,
  integrations: [Sentry.openTelemetryIntegration()],
  beforeSend(event) {
    return {
      type: undefined,
      event_id: event.event_id,
      timestamp: event.timestamp,
      level: "error",
      message: "Sandbar operation failed",
      contexts: { trace: event.contexts?.trace, sandbar: event.contexts?.sandbar },
    };
  },
});

// In your active request context, after catching an operational error:
function capture(error: unknown) {
  Sentry.captureMessage("Sandbar operation failed", {
    level: "error",
    contexts: { sandbar: { ...diagnosticContext(error) } },
  });
}
// After provider shutdown, await Sentry.close(2000).
```

Do not set `tracesSampleRate` or `tracesSampler` in this recipe: OpenTelemetry owns sampling. Sandbar does not capture issues automatically. Capture once while the caller context is active; pass only `diagnosticContext`, never the raw error, its cause or output. This recipe returns a fresh error-event allowlist without stack frames, requests, breadcrumbs, environment or user details. Avoid adding sensitive attributes to application spans: the trace exporter does not sanitize your application data. Additional Sentry integrations require a separate privacy review and their own tests.

The local fixture checks OTLP parent/phase relationships and one sanitized Sentry error envelope, including an unsampled run. It does not certify Sentry UI presentation or ingestion by a real account. [Official released pipeline guidance](https://docs.sentry.io/platforms/javascript/guides/node/opentelemetry/custom-setup/) was checked during implementation; older `SentrySampler` setup snippets are not this recipe.

## Datadog recipe

Use the plain OTel configuration with `url: "http://127.0.0.1:4318/v1/traces"` targeting your explicitly configured Datadog Agent OTLP HTTP receiver or a trusted Collector that forwards to Datadog. Enable the Agent's OTLP traces receiver according to [Datadog's OTLP ingestion instructions](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/). Sandbar does not configure an Agent, Collector, account or API key.

This recipe uses W3C context and OTel sampling, without `dd-trace`, a second provider, Datadog-specific sampling headers or baggage. It follows the [unsupported-runtime OTel export direction](https://docs.datadoghq.com/opentelemetry/guide/instrument_unsupported_runtimes/). Local Node/Bun evidence verifies the payload sent to the OTLP receiver; a real Agent, Collector mapping, Datadog intake and UI remain unverified. Native `dd-trace` integration is outside this release's supported recipe.

## Interpret spans and errors

Names are fixed, with INTERNAL semantic spans for connect, capabilities, checks, inventory, create/submit-create, image build/submit-build, exec/submit, files, inspect, destroy, operation observe/wait/recover and close. Real preparation, submission and convenience waiting use `sandbar.prepare`, `sandbar.submit` and `sandbar.wait`. Explicit advanced observation uses `sandbar.observe`. Convenience calls suppress their internal public submit/wait copies. Internal polling adds counts and at most eight changed-state events per wait, never one span per unchanged poll.

`sandbar.call.outcome` is `success`, `error` or `cancelled`. `sandbar.effect` is separate: `none`, `possible`, `applied`, `partial` or `unknown`. Observation can succeed while the remote operation remains pending/unknown. Current `exec()` is success-only: a nonzero exit throws `NonzeroExitError`, records its exit code and applied effect, and fails that call's contract. Unsupported capability answers are successful queries. Local abort after dispatch does not prove that remote work stopped. Submission response loss remains uncertain and must use existing observation/recovery, without replay.

```ts
import { diagnosticContext } from "sandbar-sdk";

try {
  // await your Sandbar operation
} catch (error) {
  const diagnostic = diagnosticContext(error);
  // Pass this bounded record to your application's issue/reporting system.
  // Keep the original error/handle if recovery is needed.
}
```

The pure helper returns allowlisted error code/effect, safe Sandbar operation/submission IDs when known, known pending/completed/rejected/failed/unknown state, and `recoveryAvailable`. It performs no IO, includes no recovery authority, and never exports invocation keys, native locators, scope, recovery tokens, service URLs or raw messages/causes. Custom provider labels become `custom`. Traces contain no command, argv, env, paths, file contents, stdout/stderr, image name, credential or URL by default.

## Recovery and HTTP instrumentation

New direct operation handles may retain a validated scalar origin context for links. Portable references do not gain tracing authority. After a direct-client restart, recover under the current caller context and use the safe operation identity when the original trace context is unavailable. Missing context and unsampled traces never remove recovery or permit replay. Links are not a promise that a vendor displays one continuous tree.

Sandbar adds no HTTP transport spans, global fetch patches, or provider/guest tracing headers. The local fixture exercises a direct adapter file read with real `instrumentation-http`, proving one CLIENT transport child for one actual request on each runtime. It qualifies Node `http.request` on Bun too; it does **not** certify automatic tracing of Bun's native fetch. The fixture deliberately permits only its localhost test server. In production, configure the application's outgoing instrumentation to ignore provider/guest destinations by default, allow propagation only to explicitly trusted destinations, and scrub URL/query/header data before export. Library safe defaults cannot scrub independently instrumented HTTP, native SDKs, application spans or vendor captures.

## Qualification and debugging

Run `bun run observability:check` after building packages. The pinned, typechecked recipes and deterministic fixtures live in `packages/sdk-qualification/observability`. Evidence covers Node 22.23.3 and Bun 1.3.14 independently, local export, safe issues, sampling, concurrent parent context and bounded shutdown. Existing service regressions remain checked without new tracing parity requirements. Metrics, structured logs, service tracing, native vendor tracers, vendor UI and live provider telemetry are not qualified by these fixtures.

If spans are missing, check that tracing is enabled, initialization preceded application work, the API is shared (Sandbar externalizes it), the sampler selected the trace, and the exporter finished within its deadline. If spans are disconnected, check the async context manager and per-call active request context. Injecting a provider does not install a context manager. Recovery correlation remains available through operation identity when traces are absent or unsampled.
