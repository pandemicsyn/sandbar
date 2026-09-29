import { performance } from "node:perf_hooks";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  AlwaysOffSampler,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Sandbar, Image } from "sandbar-sdk";
import { fixtureAdapter } from "./adapter";

const manager = new AsyncLocalStorageContextManager().enable();

context.setGlobalContextManager(manager);

const measurements = [];

for (const mode of ["disabled", "unsampled", "sampled"] as const) {
  for (const concurrency of [1, 4]) {
    const exporter = new InMemorySpanExporter();

    const provider = new NodeTracerProvider({
      sampler: mode === "unsampled" ? new AlwaysOffSampler() : undefined,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    const fixture = fixtureAdapter({ exitCode: 0 });

    const client = await Sandbar.connect({
      adapter: fixture.adapter,
      config: {},
      credentials: {},
      tracing: mode === "disabled" ? false : { tracerProvider: provider },
    });

    const work = async () => {
      const op = await client.sandboxes.submitCreate({ environment: Image.prepared("fixture") });
      const box = await op.wait();
      await box.exec({ command: { kind: "argv", argv: ["fixture"] }, maxOutputBytes: 1024 });
      await box.readFile("/fixture");
      await box.writeFile("/fixture", new Uint8Array([1, 2]));
      await box.destroy();
    };

    for (let i = 0; i < 50; i++) await work();
    const samples = [];

    for (let repeat = 0; repeat < 5; repeat++) {
      exporter.reset();
      const start = performance.now();

      for (let batch = 0; batch < 100; batch++) {
        await Promise.all(Array.from({ length: concurrency }, work));
        exporter.reset();
      }

      samples.push((performance.now() - start) / (100 * concurrency));
    }

    samples.sort((a, b) => a - b);
    measurements.push({ mode, concurrency, medianWorkloadMs: Number(samples[2]!.toFixed(4)) });
    await client.close();
    await provider.shutdown();
  }
}

context.disable();

manager.disable();

for (const concurrency of [1, 4]) {
  const baseline = measurements.find(
    (m) => m.mode === "disabled" && m.concurrency === concurrency,
  )!.medianWorkloadMs;

  for (const entry of measurements.filter((m) => m.concurrency === concurrency)) {
    if (entry.medianWorkloadMs - baseline > 1)
      throw new Error("Tracing exceeded the 1ms incremental workload budget");
  }
}

console.log(
  JSON.stringify(
    {
      runtime: process.versions.bun ? "bun" : "node",
      version: process.versions.bun ?? process.version,
      workload: "submit-create/wait/exec/read/write/destroy",
      budget: "<1ms incremental median per six-call workload",
      measurements,
    },
    null,
    2,
  ),
);
