/* oxlint-disable anti-slop/no-runtime-typeof -- Native server.address returns a string or address object; this fixture checks that contract before using the ephemeral port. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { context, trace, SpanKind } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Sandbar, Image } from "sandbar-sdk";
import { fixtureAdapter } from "./adapter";

const manager = new AsyncLocalStorageContextManager().enable();

const exporter = new InMemorySpanExporter();

const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

provider.register({ contextManager: manager });

const instrumentation = new HttpInstrumentation({
  ignoreIncomingRequestHook: () => true,
  // The application controls provider/guest propagation separately from Sandbar.
  ignoreOutgoingRequestHook: (request) => request.hostname !== "127.0.0.1",
});

instrumentation.setTracerProvider(provider);

instrumentation.enable();

// SAFETY: Node built-in node:http is the declared module loaded through require so instrumentation can patch it.
const http = createRequire(import.meta.url)("node:http") as typeof import("node:http");

let incoming: string | undefined;

const server = createServer((request, response) => {
  incoming = Array.isArray(request.headers.traceparent)
    ? request.headers.traceparent[0]
    : request.headers.traceparent;
  assert.equal(request.headers.baggage, undefined);
  response.writeHead(200);
  response.end("CANARY_FILE_CONTENT");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const address = server.address();

assert(address && typeof address === "object");

const fixture = fixtureAdapter({
  read: async () =>
    new Promise<Uint8Array>((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${address.port}/fixture`, (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
      });

      request.on("error", reject);
      request.end();
    }),
});

const client = await Sandbar.connect({ adapter: fixture.adapter, config: {}, credentials: {} });

const box = await client.sandboxes.create({ environment: Image.prepared("fixture") });

try {
  const parent = provider.getTracer("application").startSpan("request");
  await context
    .with(trace.setSpan(context.active(), parent), () => box.readFile("/CANARY_PATH"))
    .catch(() => undefined);
  parent.end();
  await box.destroy();
  await client.close();
  const spans = exporter.getFinishedSpans();
  const transports = spans.filter((s) => s.kind === SpanKind.CLIENT);
  assert.equal(transports.length, 1);
  const semantic = spans.find((s) => s.name === "sandbar.file.read")!;
  assert.equal(transports[0]!.parentSpanContext?.spanId, semantic.spanContext().spanId);
  assert(incoming?.includes(transports[0]!.spanContext().traceId));
  assert(!JSON.stringify(spans.map((s) => s.attributes)).includes("CANARY"));
  console.log(
    JSON.stringify({
      runtime: process.versions.bun ? "bun" : "node",
      httpTransportSpans: transports.length,
      requests: 1,
    }),
  );
} finally {
  instrumentation.disable();
  await provider.shutdown();
  context.disable();
  manager.disable();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
