import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  defineAdapter,
  sandboxReference,
  type CreateInput as NativeCreateInput,
  type ExecInput as NativeExecInput,
} from "@sandbar-sdk/adapter";
import {
  Sandbar,
  SandbarError,
  UnsupportedFeatureError,
  diagnosticContext,
  type RecoveryReference,
} from "./index";

const manager = new AsyncLocalStorageContextManager().enable();

context.setGlobalContextManager(manager);

afterAll(() => {
  context.disable();
  manager.disable();
});

const SECRET = "CANARY-create-env-secret-value";

const scope = { authority: { kind: "account", id: "one" }, partition: {} };

const Token = z.strictObject({ submissionId: z.string() });

/** A deterministic provider model: native env lives with the sandbox, exec merges under it. */
function fixture(options: { createEnv: boolean; pending?: boolean }) {
  const creates: NativeCreateInput[] = [];
  const execs: NativeExecInput[] = [];
  const native = new Map<string, Record<string, string>>();

  const adapter = defineAdapter({
    name: "fixture.env",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope,
        defaultImage: { kind: "prepared" as const, value: "base" },
        supports: {
          images: ["prepared" as const],
          network: ["blocked"],
          exec: { commands: ["argv" as const], maxOutputBytes: 1_048_576 },
          createEnv: options.createEnv,
        },
        create: {
          recovery: { version: 1, token: Token },
          async submit(input, ctx) {
            creates.push(structuredClone(input));
            const id = `box-${creates.length}`;
            native.set(id, { ...input.env });

            if (options.pending) return ctx.pending({ submissionId: ctx.submissionId });

            return {
              id,
              reference: sandboxReference("fixture.env", scope, id, {
                operation: ctx.operationId,
                submission: ctx.submissionId,
              }),
              state: "running" as const,
            };
          },
          async observe(attempt) {
            const id = `box-${creates.length}`;

            return {
              id,
              reference: sandboxReference("fixture.env", scope, id, {
                operation: attempt.operationId,
                submission: attempt.submissionId,
              }),
              state: "running" as const,
            };
          },
        },
        async reopen(reference) {
          return {
            reference,
            state: "running" as const,
            nativeState: "running",
            observedAt: new Date(0).toISOString(),
            expires: { status: "unknown" as const, reason: "fixture" },
            idleStop: { status: "unknown" as const, reason: "fixture" },
            retention: { status: "unknown" as const, reason: "fixture" },
            execution: { status: "unknown" as const, reason: "fixture" },
          };
        },
        async exec(input) {
          execs.push(structuredClone(input));
          const env = { ...native.get(input.sandbox.id), ...input.env };
          const argv = input.command.kind === "argv" ? input.command.argv : [];

          return {
            exitCode: 0,
            stdout: new TextEncoder().encode(argv.map((name) => env[name] ?? "").join(",")),
            stderr: new Uint8Array(),
            truncated: false,
          };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const saved: RecoveryReference[] = [];
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

  const connect = () =>
    Sandbar.connect({
      adapter,
      config: {},
      credentials: {},
      tracing: { tracerProvider: provider },
      onReference(reference) {
        saved.push(structuredClone(reference));
      },
    });

  return { connect, creates, execs, saved, exporter };
}

test("create env reaches the native create, applies after reopen and yields to per-call env", async () => {
  const f = fixture({ createEnv: true });
  const client = await f.connect();
  let reference: RecoveryReference["sandboxReference"];

  try {
    expect((await client.capabilities()).createEnv).toBe(true);
    expect((await client.sandboxes.checkCreate({ env: { TOKEN: SECRET } })).status).toBe(
      "supported",
    );
    expect(f.creates).toHaveLength(0);

    const operation = await client.sandboxes.submitCreate({
      env: { TOKEN: SECRET, MODE: "sandbox" },
    });

    const box = await operation.wait();
    reference = box.reference ?? undefined;
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0]?.env).toEqual({ TOKEN: SECRET, MODE: "sandbox" });
    expect(JSON.stringify(operation.reference)).not.toContain(SECRET);
    expect(JSON.stringify(operation.reference)).not.toContain("TOKEN");

    await client.sandboxes.create({ env: {} });
    expect(f.creates[1]?.env).toBeUndefined();
  } finally {
    await client.close();
  }

  // A fresh connection has no in-memory copy: the value comes from the native sandbox.
  const later = await f.connect();

  try {
    const box = await later.sandboxes.get(reference!);
    const inherited = await box.exec(["TOKEN", "MODE"]);
    expect(inherited.stdoutText()).toBe(`${SECRET},sandbox`);

    const overridden = await box.exec({
      command: { kind: "argv", argv: ["TOKEN", "MODE"] },
      env: { MODE: "call" },
    });

    expect(overridden.stdoutText()).toBe(`${SECRET},call`);
    // The SDK forwards only the per-call env; it never re-sends create-time values.
    expect(f.execs.map((input) => input.env)).toEqual([undefined, { MODE: "call" }]);
  } finally {
    await later.close();
  }

  expect(f.saved.length).toBeGreaterThan(0);
  expect(JSON.stringify(f.saved)).not.toContain(SECRET);

  const spans = JSON.stringify(
    f.exporter
      .getFinishedSpans()
      .map((span) => ({ name: span.name, attributes: span.attributes, events: span.events })),
  );

  expect(spans).toContain("sandbar.sandbox.submit_create");
  expect(spans).not.toContain(SECRET);
});

test("pending create recovery references never carry env values", async () => {
  const f = fixture({ createEnv: true, pending: true });
  const client = await f.connect();

  try {
    const operation = await client.sandboxes.submitCreate({ env: { TOKEN: SECRET } });
    expect(operation.reference.token).toEqual({ submissionId: expect.any(String) });
    await operation.wait({ pollMs: 50 });
    const recovered = await client.recover(structuredClone(operation.reference));
    await recovered.observe();
    expect(JSON.stringify([operation.reference, recovered.reference, f.saved])).not.toContain(
      SECRET,
    );
  } finally {
    await client.close();
  }
});

test("an adapter without create env rejects before any native allocation", async () => {
  const f = fixture({ createEnv: false });
  const client = await f.connect();

  try {
    expect((await client.capabilities()).createEnv).toBe(false);
    expect(await client.sandboxes.checkCreate({ env: { TOKEN: SECRET } })).toEqual({
      status: "unsupported",
      reason: "Create-time environment variables are unsupported by this adapter",
    });

    for (const call of [client.sandboxes.create, client.sandboxes.submitCreate]) {
      const error = await call({ env: { TOKEN: SECRET } }).catch((cause) => cause);
      expect(error).toBeInstanceOf(UnsupportedFeatureError);
      expect(error).toMatchObject({ code: "UNSUPPORTED", effect: "none" });
      expect(`${error.message} ${JSON.stringify(diagnosticContext(error))}`).not.toContain(SECRET);
    }

    await expect(
      client.operations.prepare("create", {
        image: { kind: "prepared", value: "base" },
        networkPolicy: "blocked",
        env: { TOKEN: SECRET },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(f.creates).toHaveLength(0);
    expect(f.saved).toHaveLength(0);

    // An empty environment asks for nothing and stays portable.
    await client.sandboxes.create({ env: {} });
    expect(f.creates).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("invalid env rejects with a bounded message that never echoes keys or values", async () => {
  const f = fixture({ createEnv: true });
  const client = await f.connect();

  const invalid: unknown[] = [
    { "1TOKEN": SECRET },
    { "TO=KEN": SECRET },
    { "TO\0KEN": SECRET },
    { "": SECRET },
    { TOKEN: `${SECRET}\0` },
    { TOKEN: 1 },
    { TOKEN: "x".repeat(8193) },
    Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`K${i}`, SECRET])),
    Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`K${i}`, "x".repeat(8000)])),
    [SECRET],
    SECRET,
  ];

  try {
    for (const env of invalid)
      for (const call of [
        client.sandboxes.checkCreate,
        client.sandboxes.create,
        client.sandboxes.submitCreate,
      ]) {
        // SAFETY: JavaScript callers can pass malformed env values that the SDK must reject.
        const error = await call({ env: env as Record<string, string> }).catch((cause) => cause);
        expect(error).toBeInstanceOf(SandbarError);
        expect(error).toMatchObject({
          code: "INVALID_ARGUMENT",
          message: expect.stringContaining("Invalid create env"),
        });
        expect(String(error.message)).not.toContain(SECRET);
        expect(String(error.message)).not.toContain("TOKEN");
      }

    expect(f.creates).toHaveLength(0);
    await client.sandboxes.create({
      env: Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`K_${i}`, "v"])),
    });
    expect(Object.keys(f.creates[0]?.env ?? {})).toHaveLength(128);
  } finally {
    await client.close();
  }
});
