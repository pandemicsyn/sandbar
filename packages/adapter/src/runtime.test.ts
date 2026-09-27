import { expect, test } from "bun:test";
import { z } from "zod";
import {
  createAttemptContext,
  defineAdapter,
  observeOperation,
  prepareOperation,
  submitOperation,
  type ExecInput,
  type FileWriteInput,
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

test("advanced preparation validates portable limits before provider hooks", async () => {
  let preparations = 0;

  const session = {
    scope: { authority: { kind: "account", id: "a" }, partition: {} },
    supports: {
      images: ["prepared"] as const,
      network: ["blocked"],
      exec: { commands: ["argv"] as const, maxOutputBytes: 1_048_576 },
      fileWrite: { overwrite: true, noClobber: true },
    },
    create: {
      async prepare(input: { image: { kind: "prepared"; value: string } }) {
        preparations++;

        return input;
      },
      async submit() {
        return { id: "box", state: "running" as const };
      },
    },
    async destroy() {
      return { computeStopped: true, retainedResources: [] };
    },
    exec: {
      async prepare(input: ExecInput) {
        preparations++;

        return input;
      },
      async submit() {
        return {
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          truncated: false,
        };
      },
    },
    files: {
      maxBytes: 1024,
      write: {
        async prepare(input: FileWriteInput) {
          preparations++;

          return input;
        },
        async submit() {
          return { bytesWritten: 0 };
        },
      },
    },
  };

  await expect(
    prepareOperation(
      session,
      "create",
      {
        image: { kind: "prepared", value: "bad/name" },
        networkPolicy: "blocked",
      },
      signal,
    ),
  ).rejects.toThrow();
  await expect(
    prepareOperation(
      session,
      "exec",
      {
        sandbox: { id: "box" },
        command: { kind: "argv", argv: ["echo"] },
        deadlineSeconds: 3601,
        maxOutputBytes: 1024,
      },
      signal,
    ),
  ).rejects.toThrow();
  await expect(
    prepareOperation(
      session,
      "file_write",
      {
        sandbox: { id: "box" },
        path: "/a/../b",
        bytes: new Uint8Array(),
        overwrite: true,
      },
      signal,
    ),
  ).rejects.toThrow();
  expect(preparations).toBe(0);
});

test("unsupported atomic no-clobber is rejected before adapter preparation", async () => {
  let preparations = 0;

  const session = {
    scope: { authority: { kind: "account", id: "a" }, partition: {} },
    supports: {
      images: ["prepared"] as const,
      network: ["blocked"],
      fileWrite: { overwrite: true, noClobber: false },
    },
    async create() {
      return { id: "box", state: "running" as const };
    },
    async destroy() {
      return { computeStopped: true, retainedResources: [] };
    },
    files: {
      maxBytes: 1024,
      write: {
        async prepare(input: FileWriteInput) {
          preparations++;

          return input;
        },
        async submit() {
          return { bytesWritten: 0 };
        },
      },
    },
  };

  await expect(
    prepareOperation(
      session,
      "file_write",
      {
        sandbox: { id: "box" },
        path: "/file",
        bytes: new Uint8Array(),
        overwrite: false,
      },
      signal,
    ),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(preparations).toBe(0);
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

test("coupled exec streams complete and allocate stdout first across arrival orders", async () => {
  for (const [stderrFirst, cap] of [
    [false, 4],
    [true, 1],
  ] as const) {
    let releaseStderr!: () => void;

    const stderrPulled = new Promise<void>((resolve) => {
      releaseStderr = resolve;
    });

    const stdout = stderrFirst
      ? new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              await stderrPulled;
              controller.enqueue(Uint8Array.of(65));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        )
      : new ReadableStream<Uint8Array>(
          {
            start(controller) {
              controller.enqueue(Uint8Array.of(65));
            },
            async pull(controller) {
              await stderrPulled;
              controller.close();
            },
          },
          { highWaterMark: 0 },
        );

    const stderr = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          releaseStderr();
          controller.enqueue(Uint8Array.of(66));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

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
        return { exitCode: 0, stdout, stderr, truncated: false };
      },
    };

    const prepared = await prepareOperation(
      session,
      "exec",
      {
        sandbox: { id: "box" },
        command: { kind: "argv", argv: ["echo"] },
        deadlineSeconds: 1,
        maxOutputBytes: cap,
      },
      signal,
    );

    const result = await Promise.race([
      submitOperation(prepared, identity, signal, cap),
      Bun.sleep(300).then(() => {
        throw new Error("coupled streams did not finish");
      }),
    ]);

    expect(result).toEqual({
      kind: "completed",
      value: {
        exitCode: 0,
        stdout: Uint8Array.of(65),
        stderr: stderrFirst ? new Uint8Array() : Uint8Array.of(66),
        truncated: stderrFirst,
      },
    });
  }
});

test("exec stream failure stops sibling read without waiting for cancellation", async () => {
  let siblingCancels = 0;

  const stdout = new ReadableStream<unknown>({
    start(controller) {
      controller.enqueue("invalid");
    },
  });

  const stderr = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      siblingCancels++;

      return Promise.reject(new Error("late cancel failure"));
    },
  });

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
      return { exitCode: 0, stdout, stderr, truncated: false };
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

  await expect(
    Promise.race([
      submitOperation(prepared, identity, signal, 4),
      Bun.sleep(300).then(() => {
        throw new Error("sibling read held a stream failure");
      }),
    ]),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(siblingCancels).toBe(1);
});

test("stream collection stops at its byte cap without a probe or blocking cancellation", async () => {
  let stderrReads = 0;
  let stdoutReads = 0;
  let cancelRequested = 0;

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(0, 255, 1, 2));
    },
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      return new Promise<void>(() => {});
    },
  });

  const stderr = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      return new Promise<void>(() => {});
    },
  });

  for (const [stream, count] of [
    [stdout, () => stdoutReads++],
    [stderr, () => stderrReads++],
  ] as const) {
    const getReader = stream.getReader.bind(stream);
    Object.defineProperty(stream, "getReader", {
      value: () => {
        const reader = getReader();
        const read = reader.read.bind(reader);
        const cancel = reader.cancel.bind(reader);
        Object.defineProperty(reader, "read", {
          value: () => {
            count();

            return read();
          },
        });

        reader.cancel = () => {
          cancelRequested++;

          return cancel();
        };

        return reader;
      },
    });
  }

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
      return { exitCode: 0, stdout, stderr, truncated: false };
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

  const result = await Promise.race([
    submitOperation(prepared, identity, signal, 4),
    Bun.sleep(300).then(() => {
      throw new Error("capped stream kept waiting");
    }),
  ]);

  expect(result).toEqual({
    kind: "completed",
    value: {
      exitCode: 0,
      stdout: Uint8Array.of(0, 255, 1, 2),
      stderr: new Uint8Array(),
      truncated: true,
    },
  });
  expect(stdoutReads).toBe(1);
  expect(stderrReads).toBe(1);
  expect(cancelRequested).toBe(2);
});

test("abort stops stalled output reads and requests nonblocking stream cancellation", async () => {
  for (const target of ["stdout", "stderr"] as const) {
    for (const late of ["resolve", "reject"] as const) {
      let reads = 0;
      let cancels = 0;
      let submissions = 0;
      let resolveRead!: () => void;
      let rejectRead!: () => void;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.of(1));
        },
      });

      const getReader = stream.getReader.bind(stream);

      Object.defineProperty(stream, "getReader", {
        value: () => {
          const reader = getReader();
          const read = reader.read.bind(reader);

          Object.defineProperty(reader, "read", {
            value: () => {
              reads++;

              if (reads === 1) return read();

              return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
                resolveRead = () => resolve({ done: false, value: Uint8Array.of(2) });
                rejectRead = () => reject(new Error("late read failure"));
              });
            },
          });

          reader.cancel = () => {
            cancels++;

            return late === "resolve"
              ? new Promise<void>(() => {})
              : Promise.reject(new Error("cancel failed"));
          };

          return reader;
        },
      });

      const sibling = new ReadableStream<Uint8Array>({
        cancel() {
          cancels++;

          return Promise.reject(new Error("sibling cancel failed"));
        },
      });

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
          submissions++;

          return {
            exitCode: 0,
            stdout: target === "stdout" ? stream : Uint8Array.of(0),
            stderr: target === "stderr" ? stream : sibling,
            truncated: false,
          };
        },
      };

      const controller = new AbortController();

      const prepared = await prepareOperation(
        session,
        "exec",
        {
          sandbox: { id: "box" },
          command: { kind: "argv", argv: ["echo"] },
          deadlineSeconds: 1,
          maxOutputBytes: 4,
        },
        controller.signal,
      );

      const pending = submitOperation(prepared, identity, controller.signal, 4);

      while (reads < 2) await Bun.sleep(1);
      controller.abort("stop");
      await expect(
        Promise.race([
          pending,
          Bun.sleep(300).then(() => {
            throw new Error("stalled output did not stop waiting");
          }),
        ]),
      ).rejects.toBe("stop");
      expect(cancels).toBe(target === "stdout" ? 2 : 1);
      expect(submissions).toBe(1);

      if (late === "resolve") resolveRead();
      else rejectRead();
      await Bun.sleep(1);
      expect(submissions).toBe(1);
    }
  }
});

test("stream and byte-buffer truncation distinguish EOF below cap from conservative cap", async () => {
  const output = async (stdout: Uint8Array | ReadableStream<Uint8Array>, truncated = false) => {
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
        return { exitCode: 7, stdout, stderr: new Uint8Array(), truncated };
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

    return submitOperation(prepared, identity, signal, 4);
  };

  const stream = (bytes: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

  expect(await output(stream(Uint8Array.of(1, 2)))).toEqual({
    kind: "completed",
    value: {
      exitCode: 7,
      stdout: Uint8Array.of(1, 2),
      stderr: new Uint8Array(),
      truncated: false,
    },
  });
  expect(await output(stream(Uint8Array.of(1, 2)), true)).toMatchObject({
    value: { truncated: true },
  });
  expect(await output(stream(Uint8Array.of(1, 2, 3, 4, 5)))).toEqual({
    kind: "completed",
    value: {
      exitCode: 7,
      stdout: Uint8Array.of(1, 2, 3, 4),
      stderr: new Uint8Array(),
      truncated: true,
    },
  });
  expect(await output(Uint8Array.of(1, 2, 3, 4))).toMatchObject({ value: { truncated: false } });
  expect(await output(Uint8Array.of(1, 2, 3, 4, 5))).toMatchObject({ value: { truncated: true } });
});
