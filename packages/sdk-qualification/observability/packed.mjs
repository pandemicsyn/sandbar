import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Sandbar, Image, diagnosticContext } from "sandbar-sdk";
import { acme, metrics } from "@acme/sandbar-adapter";

const manager = new AsyncLocalStorageContextManager().enable();

const exporter = new InMemorySpanExporter();

const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

provider.register({ contextManager: manager });

const client = await Sandbar.connect({
  adapter: acme,
  config: { region: "us" },
  credentials: { token: "fixture" },
});

const tracer = trace.getTracer("application");

const parents = [tracer.startSpan("request-a"), tracer.startSpan("request-b")];

await Promise.all(
  parents.map((parent) =>
    context.with(trace.setSpan(context.active(), parent), async () => {
      await Promise.resolve();
      const box = await client.sandboxes.create({ environment: Image.prepared("image-1") });
      await box.destroy();
    }),
  ),
);

parents.forEach((parent) => parent.end());

await client.close();

const spans = exporter.getFinishedSpans();

const sdkVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.resolve("sandbar-sdk")), "utf8"),
).version;

for (const span of spans) {
  if (span.instrumentationScope.name === "sandbar-sdk")
    assert.equal(span.instrumentationScope.version, sdkVersion);
}

const creates = spans.filter((s) => s.name === "sandbar.sandbox.create");

assert.equal(creates.length, 2);

assert.deepEqual(
  creates.map((s) => s.parentSpanContext.spanId).sort(),
  parents.map((s) => s.spanContext().spanId).sort(),
);

assert.equal(spans.filter((s) => s.name === "sandbar.sandbox.submit_create").length, 0);

assert(!JSON.stringify(spans.map((s) => s.attributes)).includes("CANARY"));

assert.equal(metrics.creates, 2);

assert.equal(metrics.destroys, 2);

assert.equal(metrics.closes, 1);

await provider.shutdown();

context.disable();

manager.disable();

assert.equal(diagnosticContext(new Error("CANARY_MESSAGE")).recoveryAvailable, false);

console.log("packed direct SDK shares application OTel context and safe diagnostics");
