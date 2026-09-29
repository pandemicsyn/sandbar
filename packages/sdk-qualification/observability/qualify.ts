/* oxlint-disable anti-slop/no-runtime-typeof -- Native server.address is checked before using its port; the optional recipe capture function is narrowed before calling it. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { context, trace } from "@opentelemetry/api";
import { Sandbar, Image, OutcomeUnknownError } from "sandbar-sdk";
import { fixtureAdapter } from "./adapter";
import { startOpenTelemetry, startSentry, startDatadog } from "./recipes";

const runtime = process.versions.bun ? "bun" : "node";

const recipe = process.argv[2] ?? "otel";

const sampleRate = process.argv[3] === "off" ? 0 : 1;

const exports: string[] = [];

const envelopes: unknown[] = [];

let beforeSendCalls = 0;

let failureTraceId: string | undefined;

let failureOperationId: string | undefined;

const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    exports.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const address = server.address();

assert(address && typeof address === "object");

const url = `http://127.0.0.1:${address.port}`;

const setup =
  recipe === "sentry"
    ? startSentry(
        `http://public@127.0.0.1:${address.port}/1`,
        runtime,
        () => ({
          send(envelope) {
            envelopes.push(envelope);

            return Promise.resolve({ statusCode: 200 });
          },
          flush() {
            return Promise.resolve(true);
          },
        }),
        sampleRate,
        (event) => {
          beforeSendCalls++;

          return { ...event, tags: { ...event.tags, applicationPolicy: "retained" } };
        },
      )
    : (recipe === "datadog" ? startDatadog : startOpenTelemetry)(`${url}/v1/traces`, sampleRate);

try {
  const fixture = fixtureAdapter({ exitCode: 0 });
  const client = await Sandbar.connect({ adapter: fixture.adapter, config: {}, credentials: {} });
  const tracer = trace.getTracer("application");
  const parents = [tracer.startSpan("request-a"), tracer.startSpan("request-b")];
  await Promise.all(
    parents.map((parent) =>
      context.with(trace.setSpan(context.active(), parent), async () => {
        await Promise.resolve();
        const box = await client.sandboxes.create({ environment: Image.prepared("CANARY_IMAGE") });
        await box.exec({
          command: { kind: "argv", argv: ["CANARY_COMMAND"] },
          maxOutputBytes: 1024,
        });
        await box.readFile("/CANARY_PATH");
        await box.writeFile("/CANARY_PATH", new Uint8Array([1, 2]));
        await box.destroy();
      }),
    ),
  );
  parents.forEach((parent) => parent.end());
  await client.close();
  const failing = fixtureAdapter({ lost: true });
  const other = await Sandbar.connect({ adapter: failing.adapter, config: {}, credentials: {} });
  const job = tracer.startSpan("failing-job");
  failureTraceId = job.spanContext().traceId;
  await context.with(trace.setSpan(context.active(), job), async () => {
    const error = await other.sandboxes
      .create({ environment: Image.prepared("CANARY_IMAGE") })
      .catch((error) => error);

    assert(error instanceof OutcomeUnknownError);
    failureOperationId = error.reference.operationId;

    if ("capture" in setup && typeof setup.capture === "function") setup.capture(error);
    const op = await other.recover(error.reference);
    assert.equal(await op.observe(), null);
  });
  job.end();
  await other.close();

  if ("captureUnrelated" in setup && typeof setup.captureUnrelated === "function")
    setup.captureUnrelated(new Error("Checkout card declined"));
  await setup.provider.forceFlush();

  if ("capture" in setup) {
    // Explicit issue capture also remains available with no sampled spans.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(failing.counts.create, 1);
  assert.equal(failing.counts.observe, 1);
  assert.equal(fixture.counts.close, 1);
} finally {
  await setup.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

assert(!exports.join("").includes("CANARY"));

// Decode JSON OTLP to verify exported relationships rather than merely counting requests.
type ExportedSpan = {
  name: string;
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  attributes: { key: string; value: { stringValue?: string } }[];
};

const spans: ExportedSpan[] = exports.flatMap((body) =>
  JSON.parse(body).resourceSpans.flatMap((r: { scopeSpans: { spans: ExportedSpan[] }[] }) =>
    r.scopeSpans.flatMap((s) => s.spans),
  ),
);

if (sampleRate === 0) assert.equal(spans.length, 0);
else {
  const creates = spans.filter((s) => s.name === "sandbar.sandbox.create");
  assert.equal(creates.length, 3);

  for (const name of ["request-a", "request-b", "failing-job"]) {
    const parent = spans.find((s) => s.name === name)!;
    assert(creates.some((s) => s.parentSpanId === parent.spanId && s.traceId === parent.traceId));
  }

  assert.equal(spans.filter((s) => s.name === "sandbar.sandbox.submit_create").length, 0);
  assert(spans.some((s) => s.name === "sandbar.prepare"));
  assert(spans.some((s) => s.name === "sandbar.submit"));
}

if (recipe === "sentry") {
  const issues = envelopes.filter((e) => JSON.stringify(e).includes('"type":"event"'));
  assert.equal(issues.length, 2);
  assert.equal(beforeSendCalls, 2);

  const sandbar = issues.find((event) =>
    JSON.stringify(event).includes('"message":"Sandbar operation failed"'),
  );

  const serialized = JSON.stringify(sandbar);
  assert(!serialized.includes("CANARY"));
  assert(serialized.includes("OUTCOME_UNKNOWN"));
  assert(serialized.includes("operationId"));
  assert(serialized.includes(failureTraceId!));
  assert(serialized.includes(failureOperationId!));
  assert(!serialized.includes("stacktrace"));
  const checkout = issues.find((event) => JSON.stringify(event).includes("Checkout card declined"));
  assert(checkout, "An unrelated application error must retain its original message");
  assert(JSON.stringify(checkout).includes("stacktrace"));
  assert(JSON.stringify(checkout).includes('"feature":"checkout"'));
  assert(JSON.stringify(checkout).includes('"applicationPolicy":"retained"'));
}

console.log(
  JSON.stringify({
    runtime,
    version: process.versions.bun ?? process.version,
    recipe,
    sampleRate,
    spans: spans.length,
    envelopes: envelopes.length,
    transport: "local-only",
  }),
);
