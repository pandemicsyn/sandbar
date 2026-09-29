/* oxlint-disable anti-slop/no-chained-type-assertions -- Fault-injection objects intentionally violate the OTel interface to prove that broken application providers cannot change SDK behavior. */
import { afterAll, expect, test } from "bun:test";
import {
  context,
  trace,
  ROOT_CONTEXT,
  SpanStatusCode,
  type Context,
  type TracerProvider,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  AlwaysOffSampler,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Sandbar, Image, SandbarError, diagnosticContext, OutcomeUnknownError } from "./index";
import { Telemetry, parseTraceParent } from "./observability";
import { fixtureAdapter } from "../../sdk-qualification/observability/adapter";

const manager = new AsyncLocalStorageContextManager().enable();

context.setGlobalContextManager(manager);

afterAll(() => {
  context.disable();
  manager.disable();
});

function setup(off = false) {
  const exporter = new InMemorySpanExporter();

  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    sampler: off ? new AlwaysOffSampler() : undefined,
  });

  return { exporter, provider };
}

function safeSpans(exporter: InMemorySpanExporter) {
  const spans = exporter.getFinishedSpans();

  const serialized = JSON.stringify(
    spans.map((s) => ({
      name: s.name,
      attributes: s.attributes,
      events: s.events,
      status: s.status,
    })),
  );

  expect(serialized).not.toContain("CANARY");
  expect(spans.every((s) => s.ended)).toBe(true);

  return spans;
}

test("per-call parents, convenience phases, nonzero exits, privacy and application ownership", async () => {
  const { exporter, provider } = setup();
  const fixture = fixtureAdapter();

  const client = await Sandbar.connect({
    ...fixture,
    config: {},
    credentials: {},
    tracing: { tracerProvider: provider },
  });

  const tracer = provider.getTracer("application");
  const parents = [tracer.startSpan("request-a"), tracer.startSpan("request-b")];
  await Promise.all(
    parents.map((parent) =>
      context.with(trace.setSpan(context.active(), parent), async () => {
        await Promise.resolve();

        const box = await client.sandboxes.create({
          environment: Image.prepared("CANARY_IMAGE_URL"),
        });

        await expect(
          box.exec({ command: { kind: "argv", argv: ["CANARY_COMMAND"] }, maxOutputBytes: 1024 }),
        ).rejects.toMatchObject({ code: "NONZERO_EXIT", effect: "applied" });
        await box.readFile("/CANARY_FILENAME");
        await box.writeFile("/CANARY_FILENAME", new TextEncoder().encode("CANARY_PAYLOAD"));
        await box.destroy();
      }),
    ),
  );
  parents.forEach((p) => p.end());
  await client.close();
  const spans = safeSpans(exporter);
  const creates = spans.filter((s) => s.name === "sandbar.sandbox.create");
  expect(creates).toHaveLength(2);
  expect(creates.map((s) => s.parentSpanContext?.spanId).sort()).toEqual(
    parents.map((s) => s.spanContext().spanId).sort(),
  );
  expect(spans.filter((s) => s.name === "sandbar.sandbox.submit_create")).toHaveLength(0);
  expect(spans.filter((s) => s.name === "sandbar.operation.wait")).toHaveLength(0);
  expect(spans.filter((s) => s.name === "sandbar.wait")).toHaveLength(8);
  expect(
    spans
      .filter((s) => s.name === "sandbar.exec")
      .every(
        (s) =>
          s.status.code === SpanStatusCode.ERROR && s.attributes["sandbar.exec.exit_code"] === 7,
      ),
  ).toBe(true);
  expect(fixture.counts).toEqual({
    create: 2,
    exec: 2,
    read: 2,
    write: 2,
    destroy: 2,
    observe: 0,
    close: 1,
  });
  const afterClose = tracer.startSpan("provider-still-alive");
  afterClose.end();
  expect(exporter.getFinishedSpans().at(-1)?.name).toBe("provider-still-alive");
  await provider.shutdown();
});

test("disablement and unsampled tracing retain operational recovery without telemetry IO", async () => {
  for (const disabled of [true, false]) {
    const { provider, exporter } = setup(true);
    const fixture = fixtureAdapter({ lost: true });

    const client = await Sandbar.connect({
      adapter: fixture.adapter,
      config: {},
      credentials: {},
      tracing: disabled ? false : { tracerProvider: provider },
    });

    const error = await client.sandboxes
      .create({ environment: Image.prepared("CANARY_IMAGE") })
      .catch((e) => e);

    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(diagnosticContext(error)).toMatchObject({
      errorCode: "OUTCOME_UNKNOWN",
      effect: "possible",
      recoveryAvailable: true,
      operationState: "unknown",
    });
    const recovered = await client.recover(error.reference);
    expect(await recovered.observe()).toBeNull();
    expect(diagnosticContext(recovered)).toMatchObject({
      operationState: "pending",
      effect: "possible",
      recoveryAvailable: true,
    });
    expect(fixture.counts.create).toBe(1);
    expect(fixture.counts.observe).toBe(1);
    await client.close();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    await provider.shutdown();
  }
});

test("standalone advanced observation retains safe mutation correlation", async () => {
  const { provider, exporter } = setup();
  const fixture = fixtureAdapter({ pending: true });

  const client = await Sandbar.connect({
    adapter: fixture.adapter,
    config: {},
    credentials: {},
    tracing: { tracerProvider: provider },
  });

  const operation = await client.sandboxes.submitCreate({
    environment: Image.prepared("CANARY_IMAGE"),
  });

  const reference = operation.reference;
  const parent = provider.getTracer("application").startSpan("advanced-observation");

  const result = await context.with(trace.setSpan(context.active(), parent), () =>
    client.operations.observe({
      scope: client.scope,
      kind: "create",
      operationId: reference.operationId,
      submissionId: reference.submissionId,
      token: reference.token,
      tokenVersion: reference.tokenVersion,
    }),
  );

  expect(result.kind).toBe("pending");
  parent.end();
  await client.close();
  const spans = safeSpans(exporter);
  const observation = spans.find((span) => span.name === "sandbar.observe")!;
  const submission = spans.find((span) => span.name === "sandbar.sandbox.submit_create")!;
  expect(observation.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  expect(observation.attributes).toMatchObject({
    "sandbar.operation.type": "create",
    "sandbar.operation.id": reference.operationId,
    "sandbar.submission.id": reference.submissionId,
    "sandbar.operation.state": "pending",
  });
  expect(observation.attributes["sandbar.operation.id"]).toBe(
    submission.attributes["sandbar.operation.id"],
  );
  expect(observation.attributes["sandbar.submission.id"]).toBe(
    submission.attributes["sandbar.submission.id"],
  );
  expect(fixture.counts.create).toBe(1);
  expect(fixture.counts.observe).toBe(1);
  await provider.shutdown();
});

test("pre-submission rejection, bounded polling and post-submission abort", async () => {
  const { provider, exporter } = setup();
  const fixture = fixtureAdapter({ pending: true });

  const client = await Sandbar.connect({
    adapter: fixture.adapter,
    config: {},
    credentials: {},
    tracing: { tracerProvider: provider },
  });

  await expect(
    client.sandboxes.create({ environment: Image.prepared("x"), networkPolicy: "allow_all" }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(fixture.counts.create).toBe(0);
  expect(exporter.getFinishedSpans().filter((s) => s.name === "sandbar.submit")).toHaveLength(0);
  const op = await client.sandboxes.submitCreate({ environment: Image.prepared("CANARY_IMAGE") });
  const abort = new AbortController();
  setTimeout(() => abort.abort(new Error("CANARY_ABORT")), 240);
  await expect(op.wait({ signal: abort.signal, pollMs: 50 })).rejects.toMatchObject({
    code: "WAIT_ABORTED",
    effect: "possible",
  });
  await client.close();
  const spans = safeSpans(exporter);
  const wait = spans.find((s) => s.name === "sandbar.operation.wait")!;
  expect(wait.attributes["sandbar.call.outcome"]).toBe("cancelled");
  expect(wait.status.code).not.toBe(SpanStatusCode.ERROR);
  expect(Number(wait.attributes["sandbar.wait.poll_count"])).toBeGreaterThan(1);
  expect(wait.events.length).toBeLessThanOrEqual(8);
  expect(spans.filter((s) => s.name === "sandbar.operation.observe")).toHaveLength(0);
  await provider.shutdown();
});

test("throwing tracer methods/context hooks cannot replay work, replace errors or skip cleanup", async () => {
  const fixture = fixtureAdapter();

  // SAFETY: This fault-injection provider throws before returning a tracer and can never be used as one.
  const provider = {
    getTracer() {
      throw new Error("CANARY_TRACER");
    },
  } as TracerProvider;

  const client = await Sandbar.connect({
    adapter: fixture.adapter,
    config: {},
    credentials: {},
    tracing: { tracerProvider: provider },
  });

  const box = await client.sandboxes.create({ environment: Image.prepared("x") });
  await box.destroy();
  await client.close();
  expect(fixture.counts.create).toBe(1);
  expect(fixture.counts.close).toBe(1);

  const span = {
    isRecording: () => true,
    spanContext: () => ({ traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 }),
    setAttributes() {
      throw new Error("bad");
    },
    setStatus() {
      throw new Error("bad");
    },
    recordException() {
      throw new Error("bad");
    },
    end() {
      throw new Error("bad");
    },
  };

  // SAFETY: This deliberately incomplete tracer tests failure isolation; only the named throwing methods are invoked.
  const bad = { getTracer: () => ({ startSpan: () => span }) } as unknown as TracerProvider;
  const telemetry = new Telemetry({ tracing: { tracerProvider: bad } });
  const original = new SandbarError("TIMEOUT", "CANARY_ERROR");
  let calls = 0;
  await expect(
    telemetry.run("sandbar.exec", async () => {
      calls++;
      throw original;
    }),
  ).rejects.toBe(original);
  expect(calls).toBe(1);
});

test("diagnostics drop native IDs, payloads, arbitrary codes, causes and malicious getters", () => {
  expect(diagnosticContext(new SandbarError("CANARY_CODE", "CANARY_MESSAGE"))).toEqual({
    errorCode: "INTERNAL",
    effect: "none",
    recoveryAvailable: false,
  });
  expect(
    diagnosticContext({
      reference: {
        mode: "direct",
        operationId: "https://CANARY",
        submissionId: "CANARY",
        token: "CANARY",
      },
    }).recoveryAvailable,
  ).toBe(false);
  expect(
    diagnosticContext({
      get reference() {
        throw new Error("CANARY");
      },
    }),
  ).toEqual({ recoveryAvailable: false });

  let accessorCalls = 0;

  const reference = Object.fromEntries(
    ["mode", "operationId", "submissionId", "invocationKey", "kind"].map((key) => [key, "CANARY"]),
  );

  for (const key of Object.keys(reference))
    Object.defineProperty(reference, key, {
      get() {
        accessorCalls++;

        return "CANARY";
      },
    });
  expect(diagnosticContext({ reference })).toEqual({
    recoveryAvailable: false,
    operationId: undefined,
    submissionId: undefined,
  });
  expect(accessorCalls).toBe(0);
  const accessorError = new SandbarError("OUTCOME_UNKNOWN", "CANARY");

  for (const key of ["code", "effect"])
    Object.defineProperty(accessorError, key, {
      get() {
        accessorCalls++;

        return "CANARY";
      },
    });
  expect(diagnosticContext(accessorError)).toEqual({
    errorCode: "INTERNAL",
    recoveryAvailable: false,
  });
  expect(accessorCalls).toBe(0);

  for (const value of [
    undefined,
    "CANARY",
    "00-" + "0".repeat(32) + "-" + "1".repeat(16) + "-01",
    "x".repeat(4096),
  ])
    expect(parseTraceParent(value)).toBeUndefined();
});

test("late native completion cannot mutate or keep a local submission span open", async () => {
  const { provider, exporter } = setup();
  let complete: (() => void) | undefined;

  const delay = new Promise<void>((resolve) => {
    complete = resolve;
  });

  const fixture = fixtureAdapter({ delay });

  const client = await Sandbar.connect({
    adapter: fixture.adapter,
    config: {},
    credentials: {},
    tracing: { tracerProvider: provider },
  });

  const abort = new AbortController();

  const call = client.sandboxes.create(
    { environment: Image.prepared("CANARY_IMAGE") },
    { signal: abort.signal },
  );

  while (fixture.counts.create === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  abort.abort(new Error("CANARY_ABORT"));
  await expect(call).rejects.toMatchObject({ effect: "possible" });
  const before = safeSpans(exporter);
  expect(before.filter((s) => s.name === "sandbar.submit")).toHaveLength(1);

  const serialized = JSON.stringify(
    before.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events })),
  );

  complete!();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(
    JSON.stringify(
      exporter
        .getFinishedSpans()
        .map((s) => ({ name: s.name, attributes: s.attributes, events: s.events })),
    ),
  ).toBe(serialized);
  await client.close();
  await provider.shutdown();
});

test("long transition streams are bounded and dropped events are counted", async () => {
  const { provider, exporter } = setup();
  const telemetry = new Telemetry({ tracing: { tracerProvider: provider } });
  await telemetry.run("sandbar.operation.wait", async () => {
    for (let i = 0; i < 1000; i++) telemetry.poll(i % 2 ? "pending" : "completed");
  });
  const span = exporter.getFinishedSpans()[0]!;
  expect(span.events).toHaveLength(8);
  expect(span.attributes["sandbar.events.dropped"]).toBe(992);
  expect(span.attributes["sandbar.wait.poll_count"]).toBe(1000);
  await provider.shutdown();
});

test("callback-initiated public submissions are distinct calls rather than convenience copies", async () => {
  const { provider, exporter } = setup();
  const fixture = fixtureAdapter();
  let nested = false;

  const client = await Sandbar.connect({
    adapter: fixture.adapter,
    config: {},
    credentials: {},
    tracing: { tracerProvider: provider },
    async onReference() {
      if (nested) return;
      nested = true;
      await client.sandboxes.submitCreate({ environment: Image.prepared("nested") });
    },
  });

  await client.sandboxes.create({ environment: Image.prepared("outer") });
  await client.close();
  const spans = exporter.getFinishedSpans();
  expect(spans.filter((s) => s.name === "sandbar.sandbox.create")).toHaveLength(1);
  expect(spans.filter((s) => s.name === "sandbar.sandbox.submit_create")).toHaveLength(1);
  expect(fixture.counts.create).toBe(2);
  await provider.shutdown();
});

test("throwing Context.setValue preserves SDK work, original errors and ended spans", async () => {
  for (const boundary of ["span", "owner"] as const) {
    const { provider, exporter } = setup();
    const fixture = fixtureAdapter();

    // Create real recording spans without asking the SDK provider to process the broken context.
    // This isolates Sandbar's subsequent span/owner context updates from provider startSpan failures.
    const faultProvider: TracerProvider = {
      getTracer(name, version) {
        const tracer = provider.getTracer(name, version);

        return {
          startSpan(spanName, options) {
            const span = tracer.startSpan(spanName, options, ROOT_CONTEXT);
            const end = span.end.bind(span);
            // The recording processor also needs a healthy context to export the ended span.
            span.end = (endTime) => context.with(ROOT_CONTEXT, () => end(endTime));

            return span;
          },
          startActiveSpan: tracer.startActiveSpan.bind(tracer),
        };
      },
    };

    let failedUpdates = 0;

    const broken: Context = {
      getValue: ROOT_CONTEXT.getValue.bind(ROOT_CONTEXT),
      deleteValue: ROOT_CONTEXT.deleteValue.bind(ROOT_CONTEXT),
      setValue() {
        failedUpdates++;
        throw new Error("CANARY_CONTEXT_UPDATE");
      },
    };

    const parent: Context =
      boundary === "span"
        ? broken
        : {
            getValue: ROOT_CONTEXT.getValue.bind(ROOT_CONTEXT),
            deleteValue: ROOT_CONTEXT.deleteValue.bind(ROOT_CONTEXT),
            setValue: () => broken,
          };

    const telemetry = new Telemetry({ tracing: { tracerProvider: faultProvider } });
    const original = new SandbarError("TIMEOUT", "CANARY_ORIGINAL");
    let calls = 0;

    try {
      await context.with(parent, async () => {
        const client = await Sandbar.connect({
          adapter: fixture.adapter,
          config: {},
          credentials: {},
          tracing: { tracerProvider: faultProvider },
        });

        try {
          const box = await client.sandboxes.create({ environment: Image.prepared("fixture") });
          await box.destroy();
          await expect(
            telemetry.run("sandbar.exec", async () => {
              calls++;
              expect(context.active()).toBe(parent);
              throw original;
            }),
          ).rejects.toBe(original);
          const value = { completed: true };
          expect(
            await telemetry.run(
              "sandbar.wait",
              async () => {
                calls++;
                expect(context.active()).toBe(parent);

                return value;
              },
              { phase: true },
            ),
          ).toBe(value);
        } finally {
          await client.close();
        }
      });
      expect(calls).toBe(2);
      expect(failedUpdates).toBeGreaterThan(0);
      expect(fixture.counts.create).toBe(1);
      expect(fixture.counts.destroy).toBe(1);
      expect(fixture.counts.close).toBe(1);
      const spans = safeSpans(exporter);
      expect(spans.filter((span) => span.name === "sandbar.sandbox.create")).toHaveLength(1);
      expect(spans.filter((span) => span.name === "sandbar.exec")).toHaveLength(1);
      expect(spans.filter((span) => span.name === "sandbar.wait")).toHaveLength(3);
    } finally {
      await provider.shutdown();
    }
  }
});

test("an AbortError from a pre-submission callback with a live caller signal is a failure", async () => {
  const { provider, exporter } = setup();
  const fixture = fixtureAdapter();
  const controller = new AbortController();
  const original = new Error("CANARY_INTERNAL_TIMEOUT");
  original.name = "AbortError";

  const client = await Sandbar.connect({
    adapter: fixture.adapter,
    config: {},
    credentials: {},
    tracing: { tracerProvider: provider },
    onReference() {
      throw original;
    },
  });

  try {
    await expect(
      client.sandboxes.create(
        { environment: Image.prepared("fixture") },
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toBe(original);
    expect(controller.signal.aborted).toBe(false);
    expect(fixture.counts.create).toBe(0);
    const span = safeSpans(exporter).find((span) => span.name === "sandbar.sandbox.create")!;
    expect(span.attributes["sandbar.call.outcome"]).toBe("error");
    expect(span.attributes["sandbar.effect"]).toBe("none");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  } finally {
    await client.close();
    await provider.shutdown();
  }
});
