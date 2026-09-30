/* oxlint-disable anti-slop/no-chained-type-assertions -- Fault-injection objects intentionally violate the OTel interface to prove that broken application providers cannot change SDK behavior. */
import { afterAll, expect, test } from "bun:test";
import type { AdapterRecoveryReference } from "./index";
import { defineAdapter, type SnapshotProfile } from "sandbar-adapter";
import { z } from "zod";
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
import { sealedReference as sealedRemoteReference } from "./resource";
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

  for (const span of spans.filter((s) => s.name !== "sandbar.wait")) {
    expect(span.attributes["sandbar.wait.poll_count"]).toBeUndefined();
    expect(span.attributes["sandbar.events.dropped"]).toBeUndefined();
  }

  expect(
    spans
      .filter((s) => s.name === "sandbar.wait")
      .every(
        (s) =>
          s.attributes["sandbar.wait.poll_count"] === 1 &&
          s.events.at(-1)?.attributes?.["sandbar.operation.state"] === "completed",
      ),
  ).toBe(true);
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

test("wait counts failed observations and records the unknown transition", async () => {
  for (const observeFailure of ["unknown", "throw", "invalid_token"] as const) {
    const { provider, exporter } = setup();

    const fixture = fixtureAdapter({
      pending: true,
      observeFailure: observeFailure === "invalid_token" ? undefined : observeFailure,
    });

    const client = await Sandbar.connect({
      adapter: fixture.adapter,
      config: {},
      credentials: {},
      tracing: { tracerProvider: provider },
    });

    let operation = await client.sandboxes.submitCreate({
      environment: Image.prepared("CANARY_IMAGE"),
    });

    if (observeFailure === "invalid_token") {
      expect(await operation.observe()).toBeNull();
      operation = await client.recover({ ...operation.reference, tokenVersion: 2 });
    }

    const error = await operation.wait({ pollMs: 50 }).catch((failure) => failure);

    if (observeFailure === "invalid_token") expect(error.code).toBe("CONFLICT");
    else {
      expect(error).toBeInstanceOf(OutcomeUnknownError);
      expect(error.reference).toEqual(operation.reference);
    }

    await client.close();

    const wait = safeSpans(exporter).find((span) => span.name === "sandbar.operation.wait")!;
    expect(wait.attributes["sandbar.wait.poll_count"]).toBe(
      observeFailure === "invalid_token" ? 1 : 2,
    );
    expect(wait.events.map((event) => event.attributes?.["sandbar.operation.state"])).toEqual(
      observeFailure === "invalid_token" ? ["unknown"] : ["pending", "unknown"],
    );

    if (observeFailure !== "invalid_token")
      expect(wait.attributes["sandbar.operation.state"]).toBe("unknown");
    expect(wait.status.code).toBe(SpanStatusCode.ERROR);
    expect(fixture.counts.create).toBe(1);
    expect(fixture.counts.observe).toBe(observeFailure === "invalid_token" ? 0 : 1);
    expect(fixture.counts.close).toBe(1);
    await provider.shutdown();
  }
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
    ).rejects.toMatchObject({
      code: "REFERENCE_PERSISTENCE_FAILED",
      phase: "before-dispatch",
      providerOutcome: "not-dispatched",
      cause: original,
    });
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

test("provider throttling keeps its safe diagnostic and span classification", async () => {
  const { provider, exporter } = setup();
  const telemetry = new Telemetry({ tracing: { tracerProvider: provider } });
  const error = new SandbarError("RATE_LIMIT", "CANARY_PROVIDER_MESSAGE");
  expect(diagnosticContext(error).errorCode).toBe("RATE_LIMIT");
  await expect(
    telemetry.run(
      "sandbar.submit",
      async () => {
        throw error;
      },
      { phase: true },
    ),
  ).rejects.toBe(error);
  const span = safeSpans(exporter)[0]!;
  expect(span.attributes["sandbar.error.code"]).toBe("RATE_LIMIT");
  expect(span.status.code).toBe(SpanStatusCode.ERROR);
  expect(span.attributes["sandbar.wait.poll_count"]).toBeUndefined();
  await provider.shutdown();
});

test("pending waits finalize completed state for convenience and explicit calls", async () => {
  for (const convenience of [true, false]) {
    const { provider, exporter } = setup();
    const fixture = fixtureAdapter({ pending: true, completeAfterPolls: 2 });

    const client = await Sandbar.connect({
      adapter: fixture.adapter,
      config: {},
      credentials: {},
      tracing: { tracerProvider: provider },
    });

    const input = { environment: Image.prepared("CANARY_IMAGE") };

    if (convenience) await client.sandboxes.create(input);
    else {
      const operation = await client.sandboxes.submitCreate(input);
      expect(diagnosticContext(operation).operationState).toBe("pending");
      await operation.wait({ pollMs: 50 });
    }

    await client.close();
    const name = convenience ? "sandbar.wait" : "sandbar.operation.wait";
    const wait = safeSpans(exporter).find((span) => span.name === name)!;
    expect(wait.attributes["sandbar.operation.state"]).toBe("completed");
    expect(wait.attributes["sandbar.effect"]).toBe("applied");
    expect(wait.attributes["sandbar.call.outcome"]).toBe("success");
    expect(wait.events.at(-1)?.attributes?.["sandbar.operation.state"]).toBe("completed");
    expect(fixture.counts.create).toBe(1);
    expect(fixture.counts.observe).toBe(2);
    await provider.shutdown();
  }
});

test("pending image builds and destroys retain bounded counts after decoding and cached waits", async () => {
  for (const convenience of [true, false]) {
    const { provider, exporter } = setup();

    const adapter = defineAdapter({
      name: "retention-fixture",
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "fixture", id: "CANARY_SCOPE" }, partition: {} },
          supports: { images: ["prepared" as const], network: ["blocked" as const] },
          async create() {
            return { id: "CANARY_BOX", state: "running" as const };
          },
          imageBuild: {
            recovery: { version: 1, token: z.strictObject({}) },
            async submit(_input, ctx) {
              return ctx.pending({}, { pollAfterMs: 1 });
            },
            async observe() {
              return {
                preparedId: "CANARY_IMAGE",
                retainedResources: Array.from({ length: 101 }, () => ({
                  kind: "CANARY_KIND",
                  id: "CANARY_RESOURCE",
                  ownership: "unknown" as const,
                  cleanup: "manual" as const,
                })),
              };
            },
          },
          destroy: {
            recovery: { version: 1, token: z.strictObject({}) },
            async submit(_input, ctx) {
              return ctx.pending({}, { pollAfterMs: 1 });
            },
            async observe() {
              return { computeStopped: true, retainedResources: ["CANARY_RETAINED"] };
            },
          },
        };
      },
    });

    let destroyReference: AdapterRecoveryReference | undefined;

    const client = await Sandbar.connect({
      adapter,
      config: {},
      credentials: {},
      tracing: { tracerProvider: provider },
      onReference(reference) {
        if (reference.kind === "destroy") destroyReference = reference;
      },
    });

    const buildInput = { source: { kind: "oci" as const, value: "CANARY_SOURCE" } };

    if (convenience) await client.images.build(buildInput);
    else {
      const operation = await client.images.submitBuild(buildInput);
      await operation.wait();
      await operation.wait();
    }

    const box = await client.sandboxes.create({ environment: Image.prepared("CANARY_IMAGE") });

    await box.destroy();

    if (!convenience) {
      const operation = await client.recover(destroyReference!);
      await operation.wait();
      await operation.wait();
    }

    await client.close();

    const waits = safeSpans(exporter).filter(
      (span) => span.name === "sandbar.wait" || span.name === "sandbar.operation.wait",
    );

    expect(
      waits
        .filter((span) => span.attributes["sandbar.operation.type"] === "image_build")
        .map((span) => span.attributes["sandbar.retained_resource.count"]),
    ).toEqual(convenience ? [100] : [100, 100]);
    expect(
      waits
        .filter((span) => span.attributes["sandbar.operation.type"] === "destroy")
        .map((span) => span.attributes["sandbar.retained_resource.count"]),
    ).toEqual(convenience ? [1] : [1, 1, 1]);
    await provider.shutdown();
  }
});

test("pending handle observation preserves recovery availability", async () => {
  const { provider, exporter } = setup();
  const fixture = fixtureAdapter({ pending: true });

  const client = await Sandbar.connect({
    ...fixture,
    config: {},
    credentials: {},
    tracing: { tracerProvider: provider },
  });

  const operation = await client.sandboxes.submitCreate({
    environment: Image.prepared("CANARY_IMAGE"),
  });

  expect(await operation.observe()).toBeNull();
  expect(await operation.observe()).toBeNull();
  await client.close();

  const observations = safeSpans(exporter).filter(
    (span) => span.name === "sandbar.operation.observe",
  );

  expect(observations).toHaveLength(2);

  for (const span of observations) {
    expect(span.attributes["sandbar.recovery.available"]).toBe(true);
    expect(span.attributes["sandbar.operation.state"]).toBe("pending");
    expect(span.attributes["sandbar.effect"]).toBe("possible");
  }

  await provider.shutdown();
});

test("remote diagnostics recognize SDK-validated references without executing getters", () => {
  const reference = {
    version: 2,
    mode: "remote",
    kind: "create",
    invocationKey: "00000000-0000-7000-8000-000000000000",
    service: { url: "https://CANARY.example", projectId: "CANARY_PROJECT" },
  } as const;

  expect(diagnosticContext({ reference }).recoveryAvailable).toBe(false);
  expect(diagnosticContext({ reference: sealedRemoteReference(reference) }).recoveryAvailable).toBe(
    true,
  );

  for (const invalid of [
    { mode: "remote", invocationKey: "-".repeat(36) },
    { ...reference, invocationKey: "-".repeat(36) },
    { ...reference, version: 1 },
    { ...reference, service: undefined },
    { ...reference, kind: "destroy" },
    { ...reference, kind: "file_write", resourceId: "CANARY_RESOURCE" },
    { ...reference, resourceId: "CANARY_RESOURCE" },
    { ...reference, kind: "destroy", resourceId: "" },
    { ...reference, service: { url: "invalid", projectId: "CANARY_PROJECT" } },
    { ...reference, file: { path: "/file", bytes: 1 } },
    { ...reference, file: { extra: 1 } },
    {
      ...reference,
      kind: "file_write",
      resourceId: "CANARY_RESOURCE",
      file: { path: "/../file", bytes: 1 },
    },
  ])
    expect(diagnosticContext({ reference: invalid }).recoveryAvailable).toBe(false);

  expect(
    diagnosticContext({
      reference: sealedRemoteReference({
        ...reference,
        kind: "file_write",
        resourceId: "CANARY_RESOURCE",
        file: { path: "/file", bytes: 1 },
      }),
    }).recoveryAvailable,
  ).toBe(true);

  let getters = 0;

  const service = {
    get url() {
      getters++;

      return "https://CANARY.example";
    },
    projectId: "CANARY_PROJECT",
  };

  expect(diagnosticContext({ reference: { ...reference, service } }).recoveryAvailable).toBe(false);
  expect(getters).toBe(0);
  expect(JSON.stringify(diagnosticContext({ reference }))).not.toContain("CANARY");
});

test("direct diagnostics require the complete recovery shape without traversing getters", async () => {
  const fixture = fixtureAdapter({ pending: true });
  const client = await Sandbar.connect({ ...fixture, config: {}, credentials: {}, tracing: false });

  const operation = await client.sandboxes.submitCreate({
    environment: Image.prepared("CANARY_IMAGE"),
  });

  const reference = operation.reference;
  expect(diagnosticContext(operation).recoveryAvailable).toBe(true);
  expect(diagnosticContext({ reference }).recoveryAvailable).toBe(true);

  for (const invalid of [
    { mode: "direct", operationId: reference.operationId, submissionId: reference.submissionId },
    { ...reference, version: 1 },
    { ...reference, provider: "" },
    { ...reference, kind: "invalid" },
    { ...reference, scope: undefined },
    { ...reference, invocationKey: "" },
    { ...reference, kind: "destroy" },
    { ...reference, kind: "file_write", sandboxId: "CANARY_BOX" },
    { ...reference, file: { path: "/file", bytes: 1 } },
    { ...reference, sandboxId: "CANARY_BOX" },
    { ...reference, token: "x".repeat(16_384) },
    { ...reference, token: new Date() },
    { ...reference, token: new Map() },
    { ...reference, token: new Set() },
    { ...reference, token: new Uint8Array([1]) },
    { ...reference, token: Array(20) },
    { ...reference, token: Array(20_000) },
    { ...reference, token: Object.assign([], { 1_000_000: "CANARY" }) },
  ])
    expect(diagnosticContext({ reference: invalid }).recoveryAvailable).toBe(false);

  expect(
    diagnosticContext(
      await client.recover({ ...reference, kind: "destroy", sandboxId: "CANARY_BOX" }),
    ).recoveryAvailable,
  ).toBe(true);

  expect(
    diagnosticContext(
      await client.recover({
        ...reference,
        kind: "file_write",
        sandboxId: "CANARY_BOX",
        file: { path: "/file", bytes: 1 },
      }),
    ).recoveryAvailable,
  ).toBe(true);
  let getters = 0;

  const token = {
    get secret() {
      getters++;

      return "CANARY_SECRET";
    },
  };

  expect(diagnosticContext({ reference: { ...reference, token } }).recoveryAvailable).toBe(false);
  expect(getters).toBe(0);
  const cyclic = { child: {} };
  cyclic.child = cyclic;
  expect(
    diagnosticContext(
      await client.recover({ ...reference, token: [1, "CANARY", null, { nested: true }] }),
    ).recoveryAvailable,
  ).toBe(true);
  expect(diagnosticContext({ reference: { ...reference, token: cyclic } }).recoveryAvailable).toBe(
    false,
  );
  await client.close();
});

test("disabled client polls do not contaminate another client's active wait", async () => {
  const { provider, exporter } = setup();
  const fixture = fixtureAdapter({ pending: true, completeAfterPolls: 2 });

  const disabledClient = await Sandbar.connect({
    ...fixture,
    config: {},
    credentials: {},
    tracing: false,
  });

  const enabled = new Telemetry({ tracing: { tracerProvider: provider } });

  await enabled.run("sandbar.operation.wait", async () => {
    await disabledClient.sandboxes.create({ environment: Image.prepared("CANARY_IMAGE") });
    enabled.poll("completed");
  });
  await disabledClient.close();
  const spans = safeSpans(exporter);
  expect(spans).toHaveLength(1);
  expect(spans[0]!.attributes["sandbar.wait.poll_count"]).toBe(1);
  expect(spans[0]!.events.map((event) => event.attributes?.["sandbar.operation.state"])).toEqual([
    "completed",
  ]);
  expect(fixture.counts.create).toBe(1);
  expect(fixture.counts.observe).toBe(2);
  await provider.shutdown();
});

test("enabled clients keep advanced submission effects separate in pre-submission callbacks", async () => {
  const { provider, exporter } = setup();
  const otherFixture = fixtureAdapter();
  const firstFixture = fixtureAdapter();
  const original = new Error("CANARY_CALLBACK_FAILURE");

  const other = await Sandbar.connect({
    ...otherFixture,
    config: {},
    credentials: {},
    tracing: { tracerProvider: provider },
  });

  const prepared = await other.operations.prepare("create", {
    image: { kind: "prepared", value: "CANARY_IMAGE" },
    networkPolicy: "blocked",
  });

  const first = await Sandbar.connect({
    ...firstFixture,
    config: {},
    credentials: {},
    tracing: { tracerProvider: provider },
    async onReference(reference) {
      await prepared.submit(
        {
          operationId: reference.operationId,
          submissionId: reference.submissionId,
          invocationKey: reference.invocationKey,
        },
        { beforeSubmit: async () => true },
      );
      throw original;
    },
  });

  await expect(
    first.sandboxes.create({ environment: Image.prepared("CANARY_IMAGE") }),
  ).rejects.toMatchObject({
    code: "REFERENCE_PERSISTENCE_FAILED",
    phase: "before-dispatch",
    providerOutcome: "not-dispatched",
    cause: original,
  });
  await first.close();
  await other.close();
  const create = safeSpans(exporter).find((span) => span.name === "sandbar.sandbox.create")!;
  expect(create.attributes["sandbar.effect"]).toBe("none");
  expect(create.attributes["sandbar.call.outcome"]).toBe("error");
  expect(firstFixture.counts.create).toBe(0);
  expect(otherFixture.counts.create).toBe(1);
  await provider.shutdown();
});

test("diagnostics stop traversing oversized property collections before late getters", async () => {
  const fixture = fixtureAdapter();
  const client = await Sandbar.connect({ ...fixture, config: {}, credentials: {}, tracing: false });

  const operation = await client.sandboxes.submitCreate({
    environment: Image.prepared("CANARY_IMAGE"),
  });

  const token = Object.fromEntries(
    Array.from({ length: 20_000 }, (_, index) => [`field_${index}`, index]),
  );

  let getters = 0;
  Object.defineProperty(token, "last", {
    enumerable: true,
    get() {
      getters++;

      return "CANARY";
    },
  });
  expect(
    diagnosticContext({ reference: { ...operation.reference, token } }).recoveryAvailable,
  ).toBe(false);
  expect(getters).toBe(0);
  await client.close();
});

test("completed exec failures finalize pending and recovered observation/wait spans", async () => {
  for (const exitCode of [7, null]) {
    for (const mode of ["convenience", "wait", "observe", "recover"] as const) {
      const { provider, exporter } = setup();
      let submissions = 0;
      let observations = 0;

      const adapter = defineAdapter({
        name: "terminal-exec-fixture",
        config: z.strictObject({}),
        credentials: z.strictObject({}),
        async connect() {
          return {
            scope: { authority: { kind: "fixture", id: "CANARY_SCOPE" }, partition: {} },
            supports: {
              images: ["prepared" as const],
              network: ["blocked" as const],
              exec: { commands: ["argv" as const], maxOutputBytes: 1024 },
            },
            async create() {
              return { id: "CANARY_BOX", state: "running" as const };
            },
            async destroy() {
              return { computeStopped: true, retainedResources: [] };
            },
            exec: {
              recovery: { version: 1, token: z.strictObject({}) },
              async submit(_input, ctx) {
                submissions++;

                return ctx.pending({}, { pollAfterMs: 1 });
              },
              async observe() {
                observations++;

                return {
                  exitCode,
                  stdout: new Uint8Array(),
                  stderr: new Uint8Array(),
                  truncated: false,
                };
              },
            },
          };
        },
      });

      const client = await Sandbar.connect({
        adapter,
        config: {},
        credentials: {},
        tracing: { tracerProvider: provider },
      });

      const box = await client.sandboxes.create({ environment: Image.prepared("CANARY_IMAGE") });

      const input = {
        command: { kind: "argv" as const, argv: ["CANARY_COMMAND"] },
        maxOutputBytes: 1024,
      };

      let error;

      if (mode === "convenience") error = await box.exec(input).catch((failure) => failure);
      else {
        const submitted = await box.submitExec(input);

        const operation =
          mode === "recover" ? await client.recover(submitted.reference) : submitted;

        if (mode === "observe") {
          expect(await operation.observe()).toBeNull();
          error = await operation.observe().catch((failure) => failure);
        } else error = await operation.wait({ pollMs: 50 }).catch((failure) => failure);
      }

      expect(error.code).toBe(exitCode === null ? "EXIT_STATUS_UNKNOWN" : "NONZERO_EXIT");
      expect(error.effect).toBe("applied");
      expect(diagnosticContext(error).operationState).toBe("completed");
      await client.close();

      const name = {
        convenience: "sandbar.wait",
        wait: "sandbar.operation.wait",
        observe: "sandbar.operation.observe",
        recover: "sandbar.operation.wait",
      }[mode];

      const span = safeSpans(exporter)
        .filter((item) => item.name === name)
        .at(-1)!;

      expect(span.attributes["sandbar.operation.state"]).toBe("completed");
      expect(span.attributes["sandbar.effect"]).toBe("applied");
      expect(span.attributes["sandbar.recovery.available"]).toBe(true);
      expect(span.status.code).toBe(SpanStatusCode.ERROR);

      if (mode === "convenience") {
        const publicExec = exporter
          .getFinishedSpans()
          .find((item) => item.name === "sandbar.exec")!;

        expect(publicExec.attributes["sandbar.operation.state"]).toBe("completed");
      }

      expect(submissions).toBe(1);
      expect(observations).toBe(1);
      await provider.shutdown();
    }
  }
});

test("unverified references never enumerate application keys or tokens", () => {
  let enumerations = 0;

  const token = new Proxy(
    {},
    {
      ownKeys() {
        enumerations++;
        throw new Error("CANARY_ENUMERATION");
      },
    },
  );

  const reference = new Proxy(
    {
      mode: "direct",
      operationId: `sdk_${"a".repeat(32)}`,
      submissionId: `sdk_${"b".repeat(32)}`,
      token,
    },
    {
      ownKeys() {
        enumerations++;
        throw new Error("CANARY_ENUMERATION");
      },
    },
  );

  expect(diagnosticContext({ reference }).recoveryAvailable).toBe(false);
  expect(enumerations).toBe(0);
});

test("certified direct recovery tokens are immutable through nested JSON containers", async () => {
  const adapter = defineAdapter({
    name: "nested-token-fixture",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "fixture", id: "CANARY_SCOPE" }, partition: {} },
        supports: { images: ["prepared" as const], network: ["blocked" as const] },
        create: {
          recovery: {
            version: 1,
            token: z.strictObject({ nested: z.array(z.strictObject({ secret: z.string() })) }),
          },
          async submit(_input, ctx) {
            return ctx.pending({ nested: [{ secret: "CANARY_TOKEN" }] });
          },
          async observe(_input, ctx) {
            return ctx.pending({ nested: [{ secret: "CANARY_TOKEN" }] });
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {}, tracing: false });

  const operation = await client.sandboxes.submitCreate({
    environment: Image.prepared("CANARY_IMAGE"),
  });

  await operation.observe();
  const nested = Object.getOwnPropertyDescriptor(operation.reference.token!, "nested")!.value;
  expect(Object.isFrozen(nested)).toBe(true);
  expect(Object.isFrozen(nested[0])).toBe(true);
  expect(Reflect.set(nested[0], "secret", "CHANGED")).toBe(false);
  expect(diagnosticContext(operation).recoveryAvailable).toBe(true);
  await client.close();
});

test("state recovery remains certified and bounded after telemetry composition", async () => {
  const { provider, exporter } = setup();

  const profile: SnapshotProfile = {
    id: "private-profile-canary",
    preserve: "filesystem+memory",
    sourceStates: ["running"],
    interruption: "pause",
    sourceAfter: "unchanged",
    consistency: "crash-consistent",
    connections: "dropped",
    mountHandling: "none",
    restoreExecution: "resume",
  };

  const adapter = defineAdapter({
    name: "fixture.state.telemetry",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "native-secret-scope" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "native-secret-box", state: "running" };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
        async inspect(box) {
          return { id: box.id, state: "running" };
        },
        async snapshotProfiles() {
          return {
            status: "supported",
            value: { profiles: [profile], defaultProfileId: profile.id },
          };
        },
        snapshotCapture: {
          recovery: { version: 1, token: z.strictObject({}) },
          async submit(_input, ctx) {
            return ctx.unknown("private native failure");
          },
          async observe(_attempt, ctx) {
            return ctx.unknown("private native failure");
          },
        },
      };
    },
  });

  const client = await Sandbar.connect({
    adapter,
    config: {},
    credentials: {},
    tracing: { tracerProvider: provider },
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await box.submitSnapshot();

    try {
      await operation.wait();
      throw new Error("Expected unknown capture");
    } catch (error) {
      expect(error).toBeInstanceOf(OutcomeUnknownError);
      expect(diagnosticContext(error)).toMatchObject({
        recoveryAvailable: true,
        operationState: "unknown",
      });
    }

    expect(Object.isFrozen(operation.reference.capture?.profile.sourceStates)).toBe(true);
    expect(Object.isFrozen(operation.reference.scope.authority)).toBe(true);
    const recovered = await client.recover(operation.reference);
    await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(diagnosticContext(recovered).recoveryAvailable).toBe(true);
    const spans = exporter.getFinishedSpans();
    expect(
      spans.some((span) => span.attributes["sandbar.operation.type"] === "snapshot_capture"),
    ).toBe(true);
    const serialized = JSON.stringify(spans.map((span) => span.attributes));

    for (const canary of [
      "private-profile-canary",
      "native-secret-scope",
      "native-secret-box",
      "private native failure",
    ])
      expect(serialized).not.toContain(canary);
    await box.destroy();
  } finally {
    await client.close();
    await provider.shutdown();
  }
});
