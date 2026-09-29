/* oxlint-disable anti-slop/no-runtime-typeof -- Native server.address is checked before using its ephemeral port. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Sandbar, Image, OutcomeUnknownError } from "sandbar-sdk";
import { fixtureAdapter } from "./adapter";
import { startOpenTelemetry } from "./recipes";

for (const boundary of ["start", "end"] as const) {
  const processor: SpanProcessor = {
    onStart() {
      if (boundary === "start") throw new Error("CANARY_PROCESSOR");
    },
    onEnd() {
      if (boundary === "end") throw new Error("CANARY_PROCESSOR");
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };

  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  const fixture = fixtureAdapter();

  const client = await Sandbar.connect({
    adapter: fixture.adapter,
    config: {},
    credentials: {},
    tracing: { tracerProvider: provider },
  });

  const box = await client.sandboxes.create({ environment: Image.prepared("fixture") });
  await box.destroy();
  await client.close();
  assert.equal(fixture.counts.create, 1);
  assert.equal(fixture.counts.destroy, 1);
  assert.equal(fixture.counts.close, 1);
  await provider.shutdown();
}

let requests = 0;

const server = createServer((request, response) => {
  requests++;
  request.resume();
  response.writeHead(503);
  response.end("fixture failure");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const address = server.address();

assert(address && typeof address === "object");

const setup = startOpenTelemetry(`http://127.0.0.1:${address.port}/v1/traces`);

try {
  const fixture = fixtureAdapter({ lost: true });
  const client = await Sandbar.connect({ adapter: fixture.adapter, config: {}, credentials: {} });

  const error = await client.sandboxes
    .create({ environment: Image.prepared("fixture") })
    .catch((error) => error);

  assert(error instanceof OutcomeUnknownError);
  assert.equal(error.effect, "possible");
  await client.close();
  assert.equal(fixture.counts.create, 1);
  assert.equal(fixture.counts.close, 1);
  await setup.provider.forceFlush().catch(() => undefined);
  await setup.shutdown().catch(() => undefined);
  assert(requests > 0 && requests <= 4);
  console.log(
    JSON.stringify({
      runtime: process.versions.bun ? "bun" : "node",
      throwingProcessors: ["start", "end"],
      failingCollectorRequests: requests,
      providerCalls: fixture.counts.create,
      cleanup: fixture.counts.close,
    }),
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
