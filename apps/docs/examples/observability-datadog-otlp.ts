import { trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Sandbar, Image } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const manager = new AsyncLocalStorageContextManager().enable();

const provider = new NodeTracerProvider({
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "http://127.0.0.1:4318/v1/traces",
        timeoutMillis: 1000,
      }),
    ),
  ],
});

provider.register({ contextManager: manager });

try {
  const client = await Sandbar.connect(
    daytona({
      apiKey: process.env.DAYTONA_API_KEY!,
      target: process.env.DAYTONA_TARGET ?? "us",
      ttlMinutes: 15,
      networkPolicy: "daytona-default",
    }),
  );

  try {
    await trace.getTracer("my-application").startActiveSpan("sandbar-demo", async (span) => {
      try {
        const box = await client.sandboxes.create({
          environment: Image.prepared("daytona-small"),
          networkPolicy: "daytona-default",
        });

        await box.destroy();
      } finally {
        span.end();
      }
    });
  } finally {
    await client.close();
  }
} finally {
  try {
    await provider.shutdown();
  } finally {
    manager.disable();
  }
}
