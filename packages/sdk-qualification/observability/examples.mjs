/* oxlint-disable anti-slop/no-runtime-typeof -- MessagePack uint64 IDs are decoded as bigint and normalized only for JSON inspection; relationships are compared as bigint before serialization. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@msgpack/msgpack";

const root = new URL("../../../", import.meta.url).pathname;

const temporary = await mkdtemp(join(tmpdir(), "sandbar-observability-examples-"));

await mkdir(join(root, "packages/sdk-qualification/dist"), { recursive: true });

const executables = await mkdtemp(join(root, "packages/sdk-qualification/dist/public-examples-"));

const received = [];

const receiver = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    received.push({ path: request.url, bytes: Buffer.concat(chunks) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ endpoints: ["v0.4/traces"], rate_by_service: {} }));
  });
});

await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));

const url = `http://127.0.0.1:${receiver.address().port}`;

try {
  for (const [example, runtimes] of [
    ["otel", ["node", "bun"]],
    ["sentry-node", ["node"]],
    ["sentry-bun", ["bun"]],
    ["datadog-node", ["node"]],
    ["datadog-otlp", ["node", "bun"]],
  ]) {
    const compiled = join(temporary, `${example}.mjs`);
    const sentryPackage = example === "sentry-node" ? "@sentry/node" : "@sentry/bun";
    const sentryWrapper = join(temporary, `${example}-sentry.mjs`);
    await writeFile(
      sentryWrapper,
      `
      import * as Sentry from ${JSON.stringify(import.meta.resolve(sentryPackage))};
      import { writeFileSync } from "node:fs";
      export const startSpan = Sentry.startSpan;
      export async function close(timeout) {
        try { return await Sentry.close(timeout); }
        finally { console.log("DOCUMENTATION_SENTRY_SHUTDOWN"); }
      }
      const envelopes = [];
      export function init(options) {
        return Sentry.init({ ...options, transport: () => ({
          send(envelope) {
            envelopes.push(envelope);
            writeFileSync(process.env.TEST_ENVELOPES, JSON.stringify(envelopes));
            return Promise.resolve({ statusCode: 200 });
          },
          flush: () => Promise.resolve(true),
        }) });
      }
    `,
    );

    const sdkWrapper = join(temporary, `${example}-sdk.mjs`);
    await writeFile(
      sdkWrapper,
      `
      import * as SDK from ${JSON.stringify(import.meta.resolve("sandbar-sdk"))};
      export const Image = SDK.Image;
      export const Sandbar = {
        async connect(...args) {
          const client = await SDK.Sandbar.connect(...args);
          if (process.env.TEST_MODE === "close_failure") {
            const close = client.close.bind(client);
            client.close = async () => { await close(); throw new Error("DOCUMENTATION_CLOSE_FAILURE"); };
          }
          return client;
        },
      };
    `,
    );
    const providerWrapper = join(temporary, `${example}-provider.mjs`);
    await writeFile(
      providerWrapper,
      `
      import { NodeTracerProvider as Provider } from ${JSON.stringify(import.meta.resolve("@opentelemetry/sdk-trace-node"))};
      export class NodeTracerProvider extends Provider {
        async shutdown() {
          try { return await super.shutdown(); }
          finally { console.log("DOCUMENTATION_OTEL_SHUTDOWN"); }
        }
      }
    `,
    );

    const build = await Bun.build({
      entrypoints: [join(root, `apps/docs/examples/observability-${example}.ts`)],
      target: "node",
      packages: "external",
      outdir: temporary,
      naming: `${example}.mjs`,
      plugins: [
        {
          name: "local-provider-and-vendor-boundaries",
          setup(builder) {
            builder.onResolve({ filter: /^sandbar-sdk\/daytona$/ }, () => ({
              path: join(root, "packages/sdk-qualification/observability/example-daytona.ts"),
            }));
            builder.onResolve({ filter: /^sandbar-sdk$/ }, () => ({ path: sdkWrapper }));
            builder.onResolve({ filter: /^@opentelemetry\/sdk-trace-node$/ }, () => ({
              path: providerWrapper,
            }));
            builder.onResolve({ filter: /^@sentry\/(node|bun)$/ }, () => ({ path: sentryWrapper }));
          },
        },
      ],
    });

    assert(build.success, build.logs.join("\n"));

    // Resolve application/vendor dependencies beside the repository, not from tmp.
    const executable = join(executables, `${example}.mjs`);

    await writeFile(executable, await readFile(compiled));

    for (const runtime of runtimes) {
      for (const mode of ["success", "connect_failure", "close_failure"]) {
        received.length = 0;
        const envelopePath = join(temporary, `${example}-${runtime}-${mode}.json`);

        const output = await new Promise((resolve, reject) => {
          const child = spawn(
            runtime === "node" ? (process.env.SANDBAR_NODE_BINARY ?? "node") : "bun",
            [
              "--input-type=module",
              "--eval",
              `let failed = false; try { await import(${JSON.stringify(executable)}); }
             catch (error) { if (process.env.TEST_MODE === "success") throw error; failed = true; }
             if (process.env.TEST_MODE !== "success" && !failed) throw new Error("Injected failure did not reject");
             await new Promise(r => setTimeout(r, 1500));`,
            ],
            {
              cwd: root,
              env: {
                ...process.env,
                TEST_MODE: mode,
                DAYTONA_API_KEY: "fixture",
                DAYTONA_TARGET: "us",
                SENTRY_DSN: `${url.replace("http://", "http://public@")}/1`,
                TEST_ENVELOPES: envelopePath,
                OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${url}/v1/traces`,
                DD_TRACE_AGENT_URL: url,
                DD_TRACE_FLUSH_INTERVAL: "100",
                DD_INSTRUMENTATION_TELEMETRY_ENABLED: "false",
                DD_REMOTE_CONFIG_ENABLED: "false",
                DD_TRACE_STARTUP_LOGS: "false",
                DD_TRACE_SAMPLE_RATE: "1",
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );

          let logs = "";

          const timeout = setTimeout(() => {
            child.kill();
            reject(new Error(`${example} timed out`));
          }, 15000);

          child.stdout.on("data", (chunk) => {
            logs += chunk;
          });
          child.stderr.on("data", (chunk) => {
            logs += chunk;
          });
          child.on("error", reject);
          child.on("exit", (code) => {
            clearTimeout(timeout);

            if (code === 0) resolve(logs);
            else reject(new Error(`${example}/${runtime} exited ${code}: ${logs}`));
          });
        });

        assert(
          output.includes(
            mode === "connect_failure"
              ? "DOCUMENTATION_CONNECTION_FAILURE_OK"
              : "DOCUMENTATION_WORKLOAD_OK",
          ),
          output,
        );

        if (example.startsWith("sentry"))
          assert(output.includes("DOCUMENTATION_SENTRY_SHUTDOWN"), output);

        if (example === "otel" || example === "datadog-otlp")
          assert(output.includes("DOCUMENTATION_OTEL_SHUTDOWN"), output);

        if (mode === "connect_failure") {
          console.log(JSON.stringify({ example, runtime, mode, cleanup: "verified" }));
          continue;
        }

        if (example === "otel") {
          assert(output.includes("sandbar-demo"));
          assert(output.includes("sandbar.sandbox.create"));
        } else if (example.startsWith("sentry")) {
          const envelopes = JSON.parse(await readFile(envelopePath, "utf8"));

          const spans = envelopes.flatMap((envelope) =>
            envelope[1].flatMap(([header, payload]) =>
              header.type === "span" ? payload.items : [],
            ),
          );

          const parent = spans.find((span) => span.name === "sandbar-demo");
          const create = spans.find((span) => span.name === "sandbar.sandbox.create");
          assert(parent && create, "Native Sentry exports must contain application and SDK spans");
          assert.equal(create.parent_span_id, parent.span_id);
          assert.equal(create.trace_id, parent.trace_id);
          const serialized = JSON.stringify(envelopes);
          assert(serialized.includes("sandbar-demo"));
          assert(serialized.includes("sandbar.sandbox.create"));
          assert(!serialized.includes("CANARY"));
        } else if (example === "datadog-node") {
          const traces = received.filter((r) => r.path.endsWith("/traces"));
          assert(traces.length > 0, "dd-trace must export to the local Agent stand-in");
          const decoded = traces.flatMap((r) => decode(r.bytes, { useBigInt64: true })).flat();
          const parent = decoded.find((span) => span.resource === "sandbar-demo");
          const create = decoded.find((span) => span.resource === "sandbar.sandbox.create");
          assert(parent && create, "Native Datadog exports must contain application and SDK spans");
          assert.equal(create.parent_id, parent.span_id);
          assert.equal(create.trace_id, parent.trace_id);

          const serialized = JSON.stringify(decoded, (_, value) =>
            typeof value === "bigint" ? value.toString() : value,
          );

          assert(serialized.includes("sandbar-demo"));
          assert(serialized.includes("sandbar.sandbox.create"));
          assert(!serialized.includes("CANARY"));
        } else {
          const serialized = received
            .flatMap((r) => (r.path === "/v1/traces" ? [r.bytes.toString()] : []))
            .join("");

          const spans = received
            .filter((r) => r.path === "/v1/traces")
            .flatMap((r) =>
              JSON.parse(r.bytes.toString()).resourceSpans.flatMap((resource) =>
                resource.scopeSpans.flatMap((scope) => scope.spans),
              ),
            );

          const parent = spans.find((span) => span.name === "sandbar-demo");
          const create = spans.find((span) => span.name === "sandbar.sandbox.create");
          assert(parent && create);
          assert.equal(create.parentSpanId, parent.spanId);
          assert.equal(create.traceId, parent.traceId);
          assert(serialized.includes("sandbar-demo"));
          assert(serialized.includes("sandbar.sandbox.create"));
          assert(!serialized.includes("CANARY"));
        }

        console.log(
          JSON.stringify({
            example,
            runtime,
            mode,
            actualDocumentationSource: true,
            localOnly: true,
          }),
        );
      }
    }
  }
} finally {
  await new Promise((resolve) => receiver.close(resolve));
  await rm(temporary, { recursive: true, force: true });
  await rm(executables, { recursive: true, force: true });
}
