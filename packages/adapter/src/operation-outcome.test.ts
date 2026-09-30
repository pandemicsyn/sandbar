import { expect, test } from "bun:test";
import { z } from "zod";
import {
  AdapterCheckpointError,
  AdapterError,
  OperationOutcome,
  SnapshotCaptureValue,
  continueOperation,
  createAttemptContext,
  createObserveContext,
  observeOperation,
  submitOperation,
  type Mutation,
  type RuntimeSession,
} from "./index";

const identity = { operationId: "operation", submissionId: "submission", invocationKey: "key" };

const signal = new AbortController().signal;

const scope = { authority: { kind: "account", id: "one" }, partition: {} };

const snapshot = {
  version: 1 as const,
  kind: "snapshot" as const,
  provider: "fixture",
  nativeId: "snapshot-1",
  scope,
  ownership: "verified-created" as const,
};

const partial: OperationOutcome = {
  kind: "snapshot_capture",
  status: "partial",
  snapshot,
  capture: { preserve: "filesystem", interruption: "stop", restoreExecution: "fresh" },
  source: {
    state: "stopped",
    connections: "dropped",
    observedAt: "2026-09-30T12:00:00.000Z",
  },
  restart: { status: "failed" },
};

test("partial operation outcomes validate concrete native results and JSON roundtrip", () => {
  expect(OperationOutcome.parse(JSON.parse(JSON.stringify(partial)))).toEqual(partial);
  expect(OperationOutcome.safeParse({ ...partial, status: "unknown" }).success).toBe(false);
  expect(OperationOutcome.safeParse({ ...partial, snapshot: undefined }).success).toBe(false);
  expect(OperationOutcome.safeParse({ ...partial, capture: undefined }).success).toBe(false);
  expect(
    OperationOutcome.safeParse({ ...partial, snapshot: { ...snapshot, kind: "volume" } }).success,
  ).toBe(false);
  expect(
    OperationOutcome.safeParse({
      ...partial,
      status: "unknown",
      capture: undefined,
    }).success,
  ).toBe(false);
  expect(
    OperationOutcome.safeParse({
      ...partial,
      source: { ...partial.source, observedAt: "yesterday" },
    }).success,
  ).toBe(false);
  expect(OperationOutcome.safeParse({ kind: "snapshot_capture", status: "unknown" }).success).toBe(
    true,
  );
  expect(
    OperationOutcome.safeParse({ ...partial, status: "unknown", restart: { status: "uncertain" } })
      .success,
  ).toBe(true);
  expect(
    OperationOutcome.safeParse({ kind: "destroy", status: "unknown", retainedVolumes: [snapshot] })
      .success,
  ).toBe(false);
  expect(
    SnapshotCaptureValue.shape.source.safeParse({
      state: "running",
      connections: "dropped",
      observedAt: "2026-09-30T12:00:00.000Z",
    }).success,
  ).toBe(true);
});

test("known resource identities are not limited by a generated summary byte budget", () => {
  const retainedVolumes = Array.from({ length: 32 }, (_, i) => ({
    ...snapshot,
    kind: "volume" as const,
    nativeId: `volume-${i}`,
    history: "x".repeat(4094),
  }));

  const outcome = { kind: "destroy" as const, status: "unknown" as const, retainedVolumes };
  expect(new TextEncoder().encode(JSON.stringify(outcome)).length).toBeGreaterThan(16384);
  const parsed = OperationOutcome.parse(outcome);

  if (parsed.kind !== "destroy") throw new Error("Expected destruction outcome");
  expect(parsed.retainedVolumes).toEqual(retainedVolumes);
});

test("unknown contexts detach and validate supplied outcome while preserving legacy calls", () => {
  const ctx = createAttemptContext({ ...identity, signal });
  const input = structuredClone(partial);
  const result = ctx.unknown("Capture completed; restart failed", input);
  input.snapshot!.nativeId = "changed";
  expect(result.outcome).toEqual(partial);
  expect(ctx.unknown("No acknowledgement").outcome).toBeUndefined();
  expect(
    createObserveContext({ signal, deadline: Date.now() + 1000 }).unknown("Read lost", partial),
  ).toMatchObject({ outcome: partial });
  expect(() => ctx.unknown("Invalid", { ...partial, snapshot: undefined })).toThrow(AdapterError);
});

for (const path of ["submit", "observe", "continue"] as const) {
  test(`runtime forwards native partial outcomes through ${path}`, async () => {
    const recovery = { version: 1, token: z.strictObject({}) };

    const operation: Mutation<unknown, unknown, unknown> = {
      recovery,
      async submit(_input, ctx) {
        return ctx.unknown("Source restart failed", partial);
      },
      async observe(_attempt, ctx) {
        return ctx.unknown("Source restart failed", partial);
      },
      async continue(_attempt, ctx) {
        return ctx.unknown("Source restart failed", partial);
      },
    };

    const session: RuntimeSession = {
      scope,
      supports: { images: ["prepared"], network: ["blocked"] },
      create: {},
      destroy: {},
      snapshotCapture: operation,
    };

    const attempt = { ...identity, sandbox: { id: "box" }, token: {}, version: 1 };
    let result: Awaited<ReturnType<typeof submitOperation>> | null;

    if (path === "submit")
      result = await submitOperation(
        { kind: "snapshot_capture", input: {}, operation },
        identity,
        signal,
      );
    else if (path === "observe")
      result = await observeOperation(session, "snapshot_capture", attempt, signal);
    else
      result = await continueOperation(
        session,
        "snapshot_capture",
        attempt,
        identity,
        signal,
        async () => {},
      );

    expect(result).toEqual({ kind: "unknown", reason: "Source restart failed", outcome: partial });
  });
}

test("failed compatibility checkpoint preserves native evidence without further dispatch", async () => {
  let effects = 0;

  const operation: Mutation<unknown, unknown, unknown> = {
    recovery: { version: 1, token: z.strictObject({}) },
    async submit(_input, ctx) {
      effects++;

      try {
        await ctx.checkpoint({});
      } catch (error) {
        if (error instanceof AdapterCheckpointError) error.outcome = partial;
        throw error;
      }

      effects++;

      return ctx.unknown("Source restart failed", partial);
    },
  };

  const result = await submitOperation(
    { kind: "snapshot_capture", input: {}, operation },
    identity,
    signal,
    undefined,
    async () => {
      throw new Error("Application storage offline");
    },
  ).catch((error: Error) => error);

  expect(result).toBeInstanceOf(AdapterCheckpointError);
  expect(result).toMatchObject({ outcome: partial });
  expect(effects).toBe(1);
});
