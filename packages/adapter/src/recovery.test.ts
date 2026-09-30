import { expect, test } from "bun:test";
import { z } from "zod";
import {
  RecoveryFacts,
  checkpointBeforeDispatch,
  continueOperation,
  createAttemptContext,
  observeOperation,
  submitOperation,
  type Json,
  type Mutation,
  type PreparedOperation,
  type RuntimeSession,
} from "./index";

const tokenSchema = z.strictObject({ stage: z.enum(["capture", "restart"]) });

const identity = { operationId: "operation", submissionId: "submission", invocationKey: "key" };

const signal = new AbortController().signal;

const snapshot = {
  version: 1 as const,
  kind: "snapshot" as const,
  provider: "fixture",
  nativeId: "snapshot-1",
  scope: { authority: { kind: "account", id: "one" }, partition: {} },
  ownership: "verified-created" as const,
};

function facts(stage: "capture" | "restart"): RecoveryFacts {
  return {
    version: 1,
    retainedResources: stage === "restart" ? [snapshot] : [],
    completed: stage === "restart" ? [{ step: "capture" }] : [],
    source: {
      state: "stopped",
      observedAt: "2026-09-29T12:00:00.000Z",
      provenance: "provider-read",
    },
    steps: [{ step: stage, status: "uncertain" }],
    continuation: {
      supported: false,
      status: "unavailable",
      reason: "Explicit continuation is unsupported",
    },
  };
}

const recovery = {
  version: 1,
  token: tokenSchema,
  facts: (token: Json) => facts(tokenSchema.parse(token).stage),
};

function prepared(operation: Mutation<unknown, unknown, unknown>): PreparedOperation {
  return { kind: "create", input: {}, operation };
}

function session(operation: Mutation<unknown, unknown, unknown>): RuntimeSession {
  return {
    scope: snapshot.scope,
    supports: { images: ["prepared"], network: ["blocked"] },
    create: operation,
    destroy: {},
  };
}

test("recovery facts roundtrip and reject unknown versions, excess entries and bytes", () => {
  const value = facts("restart");
  expect(RecoveryFacts.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  expect(RecoveryFacts.safeParse({ ...value, version: 2 }).success).toBe(false);
  expect(
    RecoveryFacts.safeParse({ ...value, retainedResources: Array(33).fill(snapshot) }).success,
  ).toBe(false);
  expect(
    RecoveryFacts.safeParse({ ...value, completed: Array(17).fill({ step: "capture" }) }).success,
  ).toBe(false);
  expect(
    RecoveryFacts.safeParse({
      ...value,
      steps: Array(17).fill({ step: "capture", status: "pending" }),
    }).success,
  ).toBe(false);
  expect(
    RecoveryFacts.safeParse({ ...value, source: { ...value.source, observedAt: "yesterday" } })
      .success,
  ).toBe(false);
  expect(RecoveryFacts.safeParse({ ...value, token: { secret: "must not escape" } }).success).toBe(
    false,
  );
  expect(
    RecoveryFacts.safeParse({
      ...value,
      steps: Array(16).fill({ step: "capture", status: "uncertain", reason: "🌊".repeat(256) }),
    }).success,
  ).toBe(false);
});

test("latest awaited checkpoint facts survive unknown and rejected outcomes and detach persistence data", async () => {
  for (const outcome of ["unknown", "rejected"] as const) {
    const seen: RecoveryFacts[] = [];

    const result = await submitOperation(
      prepared({
        recovery,
        async submit(_input, ctx) {
          await ctx.checkpoint({ stage: "capture" });
          await ctx.checkpoint({ stage: "restart" });

          return outcome === "unknown"
            ? ctx.unknown("Restart acknowledgement lost")
            : ctx.reject("UNAVAILABLE", "Restart failed");
        },
      }),
      identity,
      signal,
      undefined,
      async (_token, version, value) => {
        expect(version).toBe(1);
        expect(value).toBeDefined();

        if (!value) throw new Error("Expected facts");
        seen.push(structuredClone(value));
        value.retainedResources.length = 0;
        value.continuation.status = "eligible";
      },
    );

    expect(result.kind).toBe(outcome);
    expect(seen).toEqual([facts("capture"), facts("restart")]);
    expect(result.facts).toEqual(facts("restart"));
  }
});

test("pending and read-only observation derive facts from each validated token", async () => {
  const operation: Mutation<unknown, unknown, unknown> = {
    recovery,
    async submit(_input, ctx) {
      return ctx.pending({ stage: "capture" });
    },
    async observe(_attempt, ctx) {
      return ctx.pending({ stage: "restart" });
    },
  };

  const submitted = await submitOperation(prepared(operation), identity, signal);
  expect(submitted.facts).toEqual(facts("capture"));

  const observed = await observeOperation(
    session(operation),
    "create",
    {
      operationId: "operation",
      submissionId: "submission",
      token: { stage: "capture" },
      version: 1,
    },
    signal,
  );

  expect(observed?.kind).toBe("pending");
  expect(observed?.facts).toEqual(facts("restart"));
  await expect(
    observeOperation(
      session(operation),
      "create",
      {
        operationId: "operation",
        submissionId: "submission",
        token: { stage: "invalid" },
        version: 1,
      },
      signal,
    ),
  ).rejects.toThrow("Invalid recovery token");
});

test("completion and explicit continuation retain evidence and make further continuation unavailable", async () => {
  const operation: Mutation<unknown, unknown, unknown> = {
    recovery,
    async submit(_input, ctx) {
      await ctx.checkpoint({ stage: "restart" });

      return { id: "box", state: "running" };
    },
    async continue(_attempt, ctx) {
      await ctx.checkpoint({ stage: "restart" });

      return { id: "box", state: "running" };
    },
    async observe() {
      return { id: "box", state: "running" };
    },
  };

  const attempt = {
    operationId: "operation",
    submissionId: "submission",
    token: { stage: "restart" },
    version: 1,
  };

  const submitted = await submitOperation(prepared(operation), identity, signal);

  const continued = await continueOperation(
    session(operation),
    "create",
    attempt,
    identity,
    signal,
    async () => {},
  );

  const observed = await observeOperation(session(operation), "create", attempt, signal);

  for (const result of [submitted, continued, observed]) {
    expect(result?.kind).toBe("completed");
    expect(result?.facts?.retainedResources).toEqual([snapshot]);
    expect(result?.facts?.continuation).toEqual({
      supported: true,
      status: "unavailable",
      reason: facts("restart").continuation.reason,
    });
  }
});

test("checkpoint barrier failure or cancellation prevents native dispatch", async () => {
  let mutations = 0;
  const stop = new AbortController();

  const operation: Mutation<unknown, unknown, unknown> = {
    recovery,
    async submit(_input, ctx) {
      if (!(await checkpointBeforeDispatch(ctx, { stage: "capture" })))
        return ctx.unknown("Cancelled before dispatch");
      mutations++;

      return ctx.pending({ stage: "capture" });
    },
  };

  await expect(
    submitOperation(prepared(operation), identity, signal, undefined, async () => {
      throw new Error("Disk unavailable");
    }),
  ).rejects.toThrow("persistence failed");
  expect(mutations).toBe(0);

  const result = await submitOperation(
    prepared(operation),
    identity,
    stop.signal,
    undefined,
    async () => {
      stop.abort();
    },
  );

  expect(result.kind).toBe("unknown");
  expect(result.facts).toEqual(facts("capture"));
  expect(mutations).toBe(0);
});

test("invalid recovery facts fail the checkpoint barrier before dispatch; absent mapper remains absent", async () => {
  let mutations = 0;
  await expect(
    submitOperation(
      prepared({
        recovery: {
          ...recovery,
          facts: () => ({ ...facts("capture"), retainedResources: Array(33).fill(snapshot) }),
        },
        async submit(_input, ctx) {
          await checkpointBeforeDispatch(ctx, { stage: "capture" });
          mutations++;

          return ctx.pending({ stage: "capture" });
        },
      }),
      identity,
      signal,
    ),
  ).rejects.toThrow("persistence failed");
  expect(mutations).toBe(0);
  const ctx = createAttemptContext({ ...identity, signal }, tokenSchema);
  expect(await checkpointBeforeDispatch(ctx, { stage: "capture" })).toBe(true);

  const result = await submitOperation(
    prepared({
      recovery: { version: 1, token: tokenSchema },
      async submit(_input, ctx) {
        await ctx.checkpoint({ stage: "capture" });

        return ctx.unknown("Unknown");
      },
    }),
    identity,
    signal,
    undefined,
    async (_token, _version, evidence) => {
      expect(evidence).toBeUndefined();
    },
  );

  expect(result.facts).toBeUndefined();
});

test("facts preserve acknowledged references with a scope larger than eight KiB", async () => {
  const large = {
    ...snapshot,
    scope: {
      ...snapshot.scope,
      partition: {
        one: "a".repeat(2048),
        two: "b".repeat(2048),
        three: "c".repeat(2048),
        four: "d".repeat(2048),
        five: "e".repeat(1000),
      },
    },
  };

  const mapped = RecoveryFacts.parse({ ...facts("restart"), retainedResources: [large] });
  expect(mapped.retainedResources[0]).toEqual(large);
  expect(new TextEncoder().encode(JSON.stringify(mapped)).length).toBeGreaterThan(8192);
  expect(new TextEncoder().encode(JSON.stringify(mapped)).length).toBeLessThan(16384);
});

for (const path of ["submit", "observe", "continue"] as const) {
  test(`exact-budget facts preserve native completion through ${path}`, async () => {
    const exact: RecoveryFacts = {
      version: 1,
      retainedResources: [],
      completed: [],
      steps: Array.from({ length: 16 }, (_, i) => ({
        step: `step-${i}`,
        status: "completed",
        reason: "x".repeat(900),
      })),
      continuation: { supported: true, status: "unavailable", reason: "x" },
    };

    let remaining = 16384 - new TextEncoder().encode(JSON.stringify(exact)).length;

    for (const step of exact.steps) {
      const added = Math.min(1024 - step.reason!.length, remaining);
      step.reason += "x".repeat(added);
      remaining -= added;
    }

    expect(remaining).toBe(0);
    expect(new TextEncoder().encode(JSON.stringify(exact)).length).toBe(16384);
    RecoveryFacts.parse(exact);
    let effects = 0;

    const operation: Mutation<unknown, unknown, unknown> = {
      recovery: { version: 1, token: tokenSchema, facts: () => exact },
      async submit(_input, ctx) {
        await ctx.checkpoint({ stage: "capture" });
        effects++;

        return { id: "box", state: "running" };
      },
      async observe() {
        return { id: "box", state: "running" };
      },
      async continue(_attempt, ctx) {
        await ctx.checkpoint({ stage: "capture" });
        effects++;

        return { id: "box", state: "running" };
      },
    };

    const attempt = { ...identity, token: { stage: "capture" }, version: 1 };
    let checkpoints = 0;

    const checkpoint = async (_token: Json, _version: number, evidence?: RecoveryFacts) => {
      checkpoints++;
      expect(evidence).toEqual(exact);
    };

    let result: Awaited<ReturnType<typeof submitOperation>> | null;

    if (path === "submit")
      result = await submitOperation(prepared(operation), identity, signal, undefined, checkpoint);
    else if (path === "observe")
      result = await observeOperation(session(operation), "create", attempt, signal);
    else
      result = await continueOperation(
        session(operation),
        "create",
        attempt,
        identity,
        signal,
        checkpoint,
      );

    if (!result) throw new Error("Expected correlated native completion");

    expect(result.kind).toBe("completed");
    expect(result).toMatchObject({ value: { id: "box", state: "running" } });
    expect(result.facts?.continuation).toMatchObject({
      status: "unavailable",
      reason: "x",
    });
    expect(result.facts).toEqual(exact);
    expect(RecoveryFacts.safeParse(result.facts).success).toBe(true);
    expect(effects).toBe(path === "observe" ? 0 : 1);
    expect(checkpoints).toBe(path === "observe" ? 0 : 1);
    expect(exact.steps).toHaveLength(16);
    expect(new TextEncoder().encode(JSON.stringify(exact)).length).toBe(16384);
  });
}
