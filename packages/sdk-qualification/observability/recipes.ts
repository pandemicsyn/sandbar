/* oxlint-disable anti-slop/no-unknown-parameters -- An application may catch any thrown value; diagnosticContext narrows it to a safe public record. */
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context } from "@opentelemetry/api";
import { diagnosticContext } from "sandbar-sdk";
import * as SentryNode from "@sentry/node";
import * as SentryBun from "@sentry/bun";

/** Application-owned OTel setup. The explicit endpoint must be a trusted collector. */
export function startOpenTelemetry(
  url: string,
  sampleRate = 1,
  headers: Record<string, string> = {},
) {
  const manager = new AsyncLocalStorageContextManager().enable();

  const provider = new NodeTracerProvider({
    // A local budget sampler does not trust remote sampling decisions.
    sampler: new TraceIdRatioBasedSampler(sampleRate),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url, headers, timeoutMillis: 1000 }), {
        maxQueueSize: 256,
        maxExportBatchSize: 64,
        exportTimeoutMillis: 1500,
      }),
    ],
  });

  provider.register({ contextManager: manager });

  return {
    provider,
    async shutdown() {
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
        context.disable();
        manager.disable();
      }
    },
  };
}

/** Datadog Agent/Collector OTLP HTTP input; no dd-trace or second tracing provider. */
export const startDatadog = startOpenTelemetry;

/** Released Sentry 11 OTLP integration, selected separately for each runtime. */
export function startSentry(
  dsn: string,
  runtime: "node" | "bun",
  transport?: SentryNode.NodeOptions["transport"],
  sampleRate = 1,
) {
  const sentry = runtime === "bun" ? SentryBun : SentryNode;
  const endpoint = sentry.getOtlpTracesEndpoint(dsn);

  if (!endpoint) throw new Error("Invalid Sentry DSN");
  const otel = startOpenTelemetry(endpoint.url, sampleRate, endpoint.headers);
  sentry.init({
    dsn,
    enableOpenTelemetrySetup: false,
    defaultIntegrations: false,
    integrations: [sentry.openTelemetryIntegration()],
    transport,
    // Return a fresh allowlist: no stack, request, breadcrumbs, causes, user or environment.
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

  return {
    ...otel,
    // Capture once inside the caller's active request context. Never capture the raw error.
    capture(error: unknown) {
      sentry.captureMessage("Sandbar operation failed", {
        level: "error",
        contexts: { sandbar: { ...diagnosticContext(error) } },
      });
    },
    async shutdown() {
      try {
        await otel.shutdown();
      } finally {
        await sentry.close(2000);
      }
    },
  };
}
