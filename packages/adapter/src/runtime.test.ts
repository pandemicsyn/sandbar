import { expect, test } from "bun:test";
import { z } from "zod";
import {
  createAttemptContext,
  defineAdapter,
  observeOperation,
  prepareOperation,
  submitOperation,
} from "./index";

const signal = new AbortController().signal;

const identity = {
  operationId: "operation-1",
  submissionId: "submission-1",
  invocationKey: "invocation-1",
};

test("unsupported create fails before preparation or provider mutation", async () => {
  let calls = 0;

  const session = {
    scope: { authority: { kind: "account", id: "a" }, partition: {} },
    supports: { images: ["prepared"] as const, network: ["blocked"] },
    async create() {
      calls++;

      return { id: "one", state: "running" as const };
    },
    async destroy() {
      return { computeStopped: true, retainedResources: [] };
    },
  };

  await expect(
    prepareOperation(
      session,
      "create",
      {
        image: { kind: "oci", value: "image" },
        networkPolicy: "blocked",
      },
      signal,
    ),
  ).rejects.toThrow("unsupported");
  expect(calls).toBe(0);
});

test("advanced preparation is read-only and submit is invoked once", async () => {
  let preparations = 0;
  let submissions = 0;

  const session = {
    scope: { authority: { kind: "account", id: "a" }, partition: {} },
    supports: { images: ["prepared"] as const, network: ["blocked"] },
    create: {
      async prepare(input: { image: { kind: "prepared"; value: string } }) {
        preparations++;

        return { imageId: input.image.value };
      },
      async submit(_input: { imageId: string }) {
        submissions++;
        throw new Error("response lost");
      },
    },
    async destroy() {
      return { computeStopped: true, retainedResources: [] };
    },
  };

  const prepared = await prepareOperation(
    session,
    "create",
    {
      image: { kind: "prepared", value: "image" },
      networkPolicy: "blocked",
    },
    signal,
  );

  expect(preparations).toBe(1);
  expect(submissions).toBe(0);
  await expect(submitOperation(prepared, identity, signal)).rejects.toThrow("response lost");
  expect(submissions).toBe(1);
});

test("pending tokens are bounded and observation cannot certify rejection", async () => {
  const adapter = defineAdapter({
    name: "example.pending",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "a" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
          async submit(_input, ctx) {
            return ctx.pending({ jobId: "job-1" }, { pollAfterMs: 800 });
          },
          async observe(attempt, ctx) {
            expect(attempt.submissionId).toBe("submission-1");

            return ctx.unknown("No correlated completion");
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const session = await adapter.connect({
    config: {},
    credentials: {},
    host: { signal, policy: {}, onClose() {} },
  });

  const prepared = await prepareOperation(
    session,
    "create",
    {
      image: { kind: "prepared", value: "image" },
      networkPolicy: "blocked",
    },
    signal,
  );

  const result = await submitOperation(prepared, identity, signal);
  expect(result).toEqual({
    kind: "pending",
    token: { jobId: "job-1" },
    version: 1,
    pollAfterMs: 800,
  });

  const observed = await observeOperation(
    session,
    "create",
    {
      operationId: identity.operationId,
      submissionId: identity.submissionId,
      token: { jobId: "job-1" },
      version: 1,
    },
    signal,
  );

  expect(observed).toEqual({ kind: "unknown", reason: "No correlated completion" });
  expect(() => createAttemptContext({ ...identity, signal }).pending({ jobId: "job" })).toThrow();
});

test("combined binary output caps stdout first and reports truncation", async () => {
  const session = {
    scope: { authority: { kind: "account", id: "a" }, partition: {} },
    supports: {
      images: ["prepared"] as const,
      network: ["blocked"],
      exec: { commands: ["argv"] as const, maxOutputBytes: 4 },
    },
    async create() {
      return { id: "box", state: "running" as const };
    },
    async destroy() {
      return { computeStopped: true, retainedResources: [] };
    },
    async exec() {
      return {
        exitCode: 0,
        stdout: new Uint8Array([0, 255, 1]),
        stderr: new Uint8Array([2, 3]),
        truncated: false,
      };
    },
  };

  const prepared = await prepareOperation(
    session,
    "exec",
    {
      sandbox: { id: "box" },
      command: { kind: "argv", argv: ["echo"] },
      deadlineSeconds: 1,
      maxOutputBytes: 4,
    },
    signal,
  );

  const result = await submitOperation(prepared, identity, signal, 4);
  expect(result).toEqual({
    kind: "completed",
    value: {
      exitCode: 0,
      stdout: new Uint8Array([0, 255, 1]),
      stderr: new Uint8Array([2]),
      truncated: true,
    },
  });
});
