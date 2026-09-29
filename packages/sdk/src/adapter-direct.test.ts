import { expect, test } from "bun:test";
import { z } from "zod";
import { AdapterError, createAttemptContext, defineAdapter } from "sandbar-adapter";
import { Image } from "./resource";
import { Sandbar } from "./index";

test("plain create/destroy, unsupported local calls, and close once", async () => {
  let creates = 0;
  let destroys = 0;
  let releases = 0;

  const adapter = defineAdapter({
    name: "example.minimal",
    config: z.strictObject({ region: z.string() }),
    credentials: z.strictObject({ token: z.string() }),
    async connect({ config, credentials, host }) {
      expect(credentials.token).toBe("secret");
      host.onClose(() => {
        releases++;
      });

      return {
        scope: { authority: { kind: "account", id: "one" }, partition: { region: config.region } },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create(input, ctx) {
          creates++;
          expect(ctx.submissionId).toBeTruthy();

          return { id: input.image.value, state: "running" };
        },
        async destroy(box, _ctx) {
          destroys++;
          expect(box.id).toBe("image-1");

          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const saved: unknown[] = [];

  const client = await Sandbar.connect({
    adapter,
    config: { region: "us" },
    credentials: { token: "secret" },
    onReference(ref) {
      saved.push(ref);

      if (ref.kind === "create") expect(creates).toBe(0);
    },
  });

  const box = await client.sandboxes.create({ environment: Image.prepared("image-1") });
  expect(box.id).toBe("image-1");
  expect(box.supports("exec")).toBe(false);
  await expect(box.exec({ command: { kind: "argv", argv: ["true"] } })).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(saved).toHaveLength(1);
  await box.destroy();
  expect(creates).toBe(1);
  expect(destroys).toBe(1);
  await Promise.all([client.close(), client.close()]);
  expect(releases).toBe(1);
  await expect(
    client.sandboxes.create({ environment: Image.prepared("image-1") }),
  ).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
});

test("lost response is unknown with reference and recovery never resubmits", async () => {
  let creates = 0;

  const adapter = defineAdapter({
    name: "example.lost",
    config: z.strictObject({ region: z.string() }),
    credentials: z.strictObject({ token: z.string() }),
    async connect({ config }) {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: { region: config.region } },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          creates++;
          throw new Error("response lost");
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  let saved: unknown;

  const first = await Sandbar.connect({
    adapter,
    config: { region: "us" },
    credentials: { token: "secret" },
    onReference(ref) {
      saved = ref;
    },
  });

  await expect(
    first.sandboxes.create({ environment: Image.prepared("image") }),
  ).rejects.toMatchObject({
    code: "OUTCOME_UNKNOWN",
  });
  await first.close();
  expect(saved).toBeTruthy();

  const reopened = await Sandbar.connect({
    adapter,
    config: { region: "us" },
    credentials: { token: "secret" },
  });

  // SAFETY: The test fixture controls the adapter response shape.
  const operation = await reopened.recover(saved as never);
  await expect(operation.observe()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(creates).toBe(1);
  await reopened.close();

  const wrong = await Sandbar.connect({
    adapter,
    config: { region: "other" },
    credentials: { token: "secret" },
  });

  // SAFETY: The test fixture controls the adapter response shape.
  await expect(wrong.recover(saved as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
  await wrong.close();
});

test("malformed post-dispatch outcome stays unknown with its saved reference", async () => {
  let submissions = 0;

  const adapter = defineAdapter({
    name: "example.invalid-outcome",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create(_input, ctx) {
          submissions++;

          // SAFETY: Deliberately pass an invalid runtime code after dispatch to test unknown recovery.
          return ctx.reject("NOT_A_CODE" as "CAPACITY", "invalid code");
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  let saved: unknown;

  const client = await Sandbar.connect({
    adapter,
    config: {},
    credentials: {},
    onReference(reference) {
      saved = reference;
    },
  });

  const failed = client.sandboxes.create({ environment: Image.prepared("image") });
  await expect(failed).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  await expect(failed).rejects.toMatchObject({ reference: saved });
  expect(submissions).toBe(1);
  await client.close();
  const reopened = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  // SAFETY: The test fixture controls the saved SDK reference.
  const recovered = await reopened.recover(saved as never);
  await expect(recovered.observe()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(submissions).toBe(1);
  await reopened.close();
});

test("valid adapter rejection still certifies no effect", async () => {
  const adapter = defineAdapter({
    name: "example.valid-rejection",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create(_input, ctx) {
          return ctx.reject("CAPACITY", "No capacity");
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  await expect(
    client.sandboxes.create({ environment: Image.prepared("image") }),
  ).rejects.toMatchObject({ code: "CAPACITY", effect: "none" });
  await client.close();
});

test("pending observation completes without replay and saved reference reopens", async () => {
  let submits = 0;
  let observations = 0;

  const adapter = defineAdapter({
    name: "example.jobs",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
          async submit(_input, ctx) {
            submits++;

            return ctx.pending({ jobId: "job-1" });
          },
          async observe(attempt, _ctx) {
            observations++;
            expect(attempt.token?.jobId).toBe("job-1");

            return { id: "box-1", state: "running" };
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const op = await client.sandboxes.submitCreate({ environment: Image.prepared("image") });
  expect(await op.observe()).toBeNull();
  const saved = structuredClone(op.reference);
  await client.close();
  const reopened = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const recovered = await reopened.recover(saved);
  const box = await recovered.observe();
  expect(box).toMatchObject({ id: "box-1" });
  expect(submits).toBe(1);
  expect(observations).toBe(1);
  await reopened.close();
});

test("recovery accepts reordered distinct Unicode partition keys without resubmission", async () => {
  let submissions = 0;
  const composed = "é";
  const decomposed = "e\u0301";

  const adapter = defineAdapter({
    name: "example.unicode-scope",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: {
          authority: { kind: "account", id: "one" },
          partition: { [composed]: "same", [decomposed]: "same" },
        },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
          async submit(_input, ctx) {
            submissions++;

            return ctx.pending({ jobId: "job-1" });
          },
          async observe() {
            return { id: "box-1", state: "running" };
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const operation = await client.sandboxes.submitCreate({ environment: Image.prepared("image") });
  const reference = structuredClone(operation.reference);

  const reordered = {
    ...reference,
    scope: {
      ...reference.scope,
      partition: Object.fromEntries(Object.entries(reference.scope.partition).reverse()),
    },
  };

  expect((await client.recover(reordered)).reference.scope.partition).toEqual(
    reordered.scope.partition,
  );
  expect(submissions).toBe(1);
  await expect(
    client.recover({
      ...reordered,
      scope: {
        ...reordered.scope,
        partition: { ...reordered.scope.partition, [composed]: "other" },
      },
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await client.close();
});

test("provider observation failures retain possible effect and permit read-only retry", async () => {
  for (const failure of ["CONFLICT", "INVALID_ARGUMENT", "rejected"] as const) {
    let submits = 0;
    let observations = 0;

    const adapter = defineAdapter({
      name: `example.observe-failure-${failure.toLowerCase().replaceAll("_", "-")}`,
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          supports: { images: ["prepared"], network: ["blocked"] },
          create: {
            recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
            async submit(_input, ctx) {
              submits++;

              return ctx.pending({ jobId: "job-1" });
            },
            async observe(_attempt, ctx) {
              observations++;

              if (observations === 1 || observations === 3) {
                if (failure === "rejected")
                  return createAttemptContext({
                    operationId: "op",
                    submissionId: "sub",
                    invocationKey: "key",
                    signal: ctx.signal,
                  }).reject("CONFLICT", "late rejection");

                throw new AdapterError(failure, "native observation failed");
              }

              return { id: "box", state: "running" as const };
            },
          },
          async destroy() {
            return { computeStopped: true, retainedResources: [] };
          },
        };
      },
    });

    const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
    const op = await client.sandboxes.submitCreate({ environment: Image.prepared("image") });
    expect(await op.observe()).toBeNull();
    const saved = structuredClone(op.reference);

    await expect(op.observe()).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      effect: "possible",
      reference: saved,
    });
    expect(await op.observe()).toMatchObject({ id: "box" });
    expect(submits).toBe(1);

    const advanced = {
      scope: client.scope,
      kind: "create" as const,
      operationId: saved.operationId,
      submissionId: saved.submissionId,
      token: saved.token,
      tokenVersion: saved.tokenVersion,
    };

    expect(await client.operations.observe(advanced)).toMatchObject({ kind: "unknown" });
    expect(await client.operations.observe(advanced)).toMatchObject({ kind: "completed" });
    expect(submits).toBe(1);
    await client.close();
  }
});

test("invalid recovery versions fail before submission and late metadata drift stays unknown", async () => {
  for (const version of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    let preparations = 0;
    let submits = 0;
    let references = 0;
    const recovery = { version, token: z.strictObject({ jobId: z.string() }) };

    const adapter = defineAdapter({
      name: "example.invalid-recovery-version",
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          supports: { images: ["prepared"], network: ["blocked"] },
          create: {
            recovery,
            async prepare(input) {
              preparations++;

              return input;
            },
            async submit(_input, ctx) {
              submits++;

              return ctx.pending({ jobId: "job" });
            },
          },
          async destroy() {
            return { computeStopped: true, retainedResources: [] };
          },
        };
      },
    });

    const client = await Sandbar.connect({
      adapter,
      config: {},
      credentials: {},
      async onReference() {
        references++;
      },
    });

    await expect(
      client.sandboxes.submitCreate({ environment: Image.prepared("image") }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", effect: "none" });
    await expect(
      client.operations.prepare("create", {
        image: { kind: "prepared", value: "image" },
        networkPolicy: "blocked",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", effect: "none" });
    expect(preparations).toBe(0);
    expect(submits).toBe(0);
    expect(references).toBe(0);
    await client.close();
  }

  const recovery = { version: 1, token: z.strictObject({ jobId: z.string() }) };
  let submits = 0;

  const adapter = defineAdapter({
    name: "example.recovery-version-drift",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          recovery,
          async submit(_input, ctx) {
            submits++;
            recovery.version = 0;

            return ctx.pending({ jobId: "job" });
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  let savedReference: unknown;

  const client = await Sandbar.connect({
    adapter,
    config: {},
    credentials: {},
    async onReference(reference) {
      savedReference = reference;
    },
  });

  const prepared = await client.operations.prepare("create", {
    image: { kind: "prepared", value: "image" },
    networkPolicy: "blocked",
  });

  expect(
    await prepared.submit(
      { operationId: "op", submissionId: "sub", invocationKey: "key" },
      { beforeSubmit: async () => true },
    ),
  ).toMatchObject({ kind: "unknown" });
  expect(submits).toBe(1);

  recovery.version = 1;
  const ordinary = client.sandboxes.create({ environment: Image.prepared("image") });

  await expect(ordinary).rejects.toMatchObject({
    code: "OUTCOME_UNKNOWN",
    effect: "possible",
  });
  await expect(ordinary).rejects.toMatchObject({ reference: savedReference });
  expect(savedReference).toMatchObject({ kind: "create", operationId: expect.any(String) });
  expect(submits).toBe(2);
  await client.close();
});

test("reference callback failure prevents provider submission", async () => {
  let submits = 0;

  const adapter = defineAdapter({
    name: "example.reference",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          submits++;

          return { id: "box", state: "running" };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({
    adapter,
    config: {},
    credentials: {},
    async onReference() {
      throw new Error("storage unavailable");
    },
  });

  await expect(client.sandboxes.create({ environment: Image.prepared("image") })).rejects.toThrow(
    "storage unavailable",
  );
  expect(submits).toBe(0);
  await client.close();
});

test("close stops waiting after dispatch with a recovery reference", async () => {
  let started = false;

  const adapter = defineAdapter({
    name: "example.slow",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          started = true;

          return new Promise<{ id: string; state: "running" }>(() => {});
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const waiting = client.sandboxes.create({ environment: Image.prepared("image") });

  while (!started) await Bun.sleep(1);
  await client.close();
  await expect(waiting).rejects.toMatchObject({
    code: "WAIT_ABORTED",
    reference: { kind: "create" },
  });
});

test("close wakes an operation waiting on a long polling interval", async () => {
  const adapter = defineAdapter({
    name: "example.poll-close",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
          async submit(_input, ctx) {
            return ctx.pending({ jobId: "job-1" });
          },
          async observe(_attempt, ctx) {
            return ctx.pending({ jobId: "job-1" });
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const op = await client.sandboxes.submitCreate({ environment: Image.prepared("image") });
  expect(await op.observe()).toBeNull();
  const waiting = op.wait({ pollMs: 60_000 });

  await Bun.sleep(10);
  await client.close();
  await expect(
    Promise.race([
      waiting,
      Bun.sleep(500).then(() => {
        throw new Error("wait did not wake on close");
      }),
    ]),
  ).rejects.toMatchObject({ code: "WAIT_ABORTED" });
});

test("automatic waits honor first and subsequent provider polling hints", async () => {
  for (const [hint, pollMs] of [
    [200, 50],
    [50, 200],
  ] as const) {
    let observations = 0;
    const observedAt: number[] = [];

    const adapter = defineAdapter({
      name: `example.poll-hint-${hint}-${pollMs}`,
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          supports: { images: ["prepared"], network: ["blocked"] },
          create: {
            recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
            async submit(_input, ctx) {
              return ctx.pending({ jobId: "job-1" }, { pollAfterMs: hint });
            },
            async observe(_attempt, ctx) {
              observations++;
              observedAt.push(Date.now());

              return observations === 1
                ? ctx.pending({ jobId: "job-1" }, { pollAfterMs: hint })
                : { id: "box", state: "running" as const };
            },
          },
          async destroy() {
            return { computeStopped: true, retainedResources: [] };
          },
        };
      },
    });

    const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
    const op = await client.sandboxes.submitCreate({ environment: Image.prepared("image") });

    // Consuming pending manually must retain its next automatic observation time.
    expect(await op.observe()).toBeNull();
    const startedAt = Date.now();
    const waiting = op.wait({ pollMs });

    await Bun.sleep(80);
    expect(observations).toBe(0);
    expect(await waiting).toMatchObject({ id: "box" });
    expect(observations).toBe(2);
    expect(observedAt[0]! - startedAt).toBeGreaterThanOrEqual(180);
    expect(observedAt[1]! - observedAt[0]!).toBeGreaterThanOrEqual(180);
    expect(
      await Promise.race([
        op.wait({ pollMs: 60_000 }),
        Bun.sleep(100).then(() => {
          throw new Error("terminal result was delayed");
        }),
      ]),
    ).toMatchObject({ id: "box" });
    await client.close();
  }
});

test("close and caller abort stop stalled preparation without dispatch", async () => {
  for (const mode of ["close", "caller"] as const) {
    let preparations = 0;
    let submissions = 0;
    let references = 0;
    let release!: () => void;

    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });

    let stall = true;

    const adapter = defineAdapter({
      name: `example.prepare-abort-${mode}`,
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          supports: { images: ["prepared"], network: ["blocked"] },
          create: {
            async prepare(input) {
              preparations++;

              if (stall) await stalled;

              return input;
            },
            async submit() {
              submissions++;

              return { id: "box", state: "running" as const };
            },
          },
          async destroy() {
            return { computeStopped: true, retainedResources: [] };
          },
        };
      },
    });

    const client = await Sandbar.connect({
      adapter,
      config: {},
      credentials: {},
      async onReference() {
        references++;
      },
    });

    const controller = new AbortController();

    const pending =
      mode === "close"
        ? client.sandboxes.create({ environment: Image.prepared("image") })
        : client.operations.prepare(
            "create",
            {
              image: { kind: "prepared", value: "image" },
              networkPolicy: "blocked",
            },
            { signal: controller.signal },
          );

    while (!preparations) await Bun.sleep(1);

    if (mode === "close") await client.close();
    else controller.abort("stop");

    await expect(
      Promise.race([
        pending,
        Bun.sleep(500).then(() => {
          throw new Error("prepare did not stop waiting");
        }),
      ]),
    ).rejects.toMatchObject({ code: mode === "close" ? "CLIENT_CLOSED" : "WAIT_ABORTED" });
    release();
    await Bun.sleep(1);
    expect(submissions).toBe(0);
    expect(references).toBe(0);

    stall = false;

    const usable =
      mode === "close" ? await Sandbar.connect({ adapter, config: {}, credentials: {} }) : client;

    expect(await usable.sandboxes.create({ environment: Image.prepared("image") })).toMatchObject({
      id: "box",
    });
    expect(submissions).toBe(1);
    await usable.close();
  }
});

test("preparation deadline settles ordinary and advanced calls without submission", async () => {
  let preparations = 0;
  let submissions = 0;
  let references = 0;
  const complete: Array<() => void> = [];
  const fail: Array<() => void> = [];
  const readSignals: AbortSignal[] = [];

  const adapter = defineAdapter({
    name: "example.prepare-deadline",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          async prepare(input, context) {
            preparations++;
            readSignals.push(context.signal);

            return new Promise<typeof input>((resolve, reject) => {
              complete.push(() => resolve(input));
              fail.push(() => reject(new Error("late read failure")));
            });
          },
          async submit() {
            submissions++;

            return { id: "box", state: "running" as const };
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({
    adapter,
    config: {},
    credentials: {},
    async onReference() {
      references++;
    },
  });

  const ordinary = client.sandboxes.create({ environment: Image.prepared("image") });

  const advanced = client.operations.prepare("create", {
    image: { kind: "prepared", value: "image" },
    networkPolicy: "blocked",
  });

  const outcomes = await Promise.allSettled([ordinary, advanced]);

  expect(preparations).toBe(2);

  for (const outcome of outcomes) {
    expect(outcome.status).toBe("rejected");

    if (outcome.status === "rejected")
      expect(outcome.reason).toMatchObject({ code: "TIMEOUT", effect: "none" });
  }

  expect(readSignals.every((readSignal) => readSignal.aborted)).toBe(true);
  expect(submissions).toBe(0);
  expect(references).toBe(0);

  complete[0]!();
  fail[1]!();
  await Bun.sleep(1);
  expect(submissions).toBe(0);
  expect(references).toBe(0);
  await client.close();
}, 40_000);

test("advanced submit cancellation leaves an unknown outcome and original identity", async () => {
  for (const mode of ["caller", "close"] as const) {
    let submitted = 0;
    let finish!: (value: { id: string; state: "running" }) => void;
    let fail!: (error: Error) => void;

    const stalled = new Promise<{ id: string; state: "running" }>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });

    const adapter = defineAdapter({
      name: `example.advanced-abort-${mode}`,
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          supports: { images: ["prepared"], network: ["blocked"] },
          create: {
            async submit() {
              submitted++;

              return stalled;
            },
            async observe() {
              return { id: "recovered", state: "running" as const };
            },
          },
          async destroy() {
            return { computeStopped: true, retainedResources: [] };
          },
        };
      },
    });

    const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

    const prepared = await client.operations.prepare("create", {
      image: { kind: "prepared", value: "image" },
      networkPolicy: "blocked",
    });

    const identity = {
      operationId: `op-${mode}`,
      submissionId: `sub-${mode}`,
      invocationKey: `key-${mode}`,
    };

    const controller = new AbortController();

    const result = prepared.submit(identity, {
      beforeSubmit: async () => true,
      signal: controller.signal,
    });

    while (!submitted) await Bun.sleep(1);

    if (mode === "caller") controller.abort("stop");
    else await client.close();
    await expect(
      Promise.race([
        result,
        Bun.sleep(500).then(() => {
          throw new Error("submit did not stop waiting");
        }),
      ]),
    ).resolves.toMatchObject({ kind: "unknown" });

    if (mode === "caller") finish({ id: "late", state: "running" });
    else fail(new Error("late rejection"));
    await Bun.sleep(1);

    const observer =
      mode === "caller" ? client : await Sandbar.connect({ adapter, config: {}, credentials: {} });

    expect(
      await observer.operations.observe({
        scope: observer.scope,
        kind: "create",
        operationId: identity.operationId,
        submissionId: identity.submissionId,
      }),
    ).toMatchObject({ kind: "completed", value: { id: "recovered" } });
    expect(submitted).toBe(1);
    await observer.close();
  }
});

test("in-flight observation stops on caller abort and preserves recovery", async () => {
  let observing = false;
  let finish!: (value: { id: string; state: "running" }) => void;

  const stalled = new Promise<{ id: string; state: "running" }>((resolve) => {
    finish = resolve;
  });

  let observations = 0;

  const adapter = defineAdapter({
    name: "example.observe-abort",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
          async submit(_input, ctx) {
            return ctx.pending({ jobId: "job-1" });
          },
          async observe() {
            observations++;

            if (observations === 1) {
              observing = true;

              return stalled;
            }

            return { id: "recovered", state: "running" as const };
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const op = await client.sandboxes.submitCreate({ environment: Image.prepared("image") });
  expect(await op.observe()).toBeNull();
  const controller = new AbortController();
  const waiting = op.wait({ signal: controller.signal });

  while (!observing) await Bun.sleep(1);
  const reference = structuredClone(op.reference);
  controller.abort("stop");
  await expect(
    Promise.race([
      waiting,
      Bun.sleep(500).then(() => {
        throw new Error("observe did not stop waiting");
      }),
    ]),
  ).rejects.toMatchObject({ code: "WAIT_ABORTED", reference });
  finish({ id: "late", state: "running" });
  await Bun.sleep(1);
  const recovered = await client.recover(reference);
  expect(await recovered.observe()).toMatchObject({ id: "recovered" });
  await client.close();
});

test("client close stops an in-flight observation without late completion", async () => {
  let started = false;
  let fail!: (error: Error) => void;

  const stalled = new Promise<{ id: string; state: "running" }>((_resolve, reject) => {
    fail = reject;
  });

  const adapter = defineAdapter({
    name: "example.observe-close",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
          async submit(_input, ctx) {
            return ctx.pending({ jobId: "job-1" });
          },
          async observe() {
            started = true;

            return stalled;
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const op = await client.sandboxes.submitCreate({ environment: Image.prepared("image") });
  expect(await op.observe()).toBeNull();
  const reference = structuredClone(op.reference);
  const waiting = op.observe();

  while (!started) await Bun.sleep(1);
  await client.close();
  await expect(
    Promise.race([
      waiting,
      Bun.sleep(500).then(() => {
        throw new Error("observe did not stop on close");
      }),
    ]),
  ).rejects.toMatchObject({ code: "WAIT_ABORTED", reference });
  fail(new Error("late observation rejection"));
  await Bun.sleep(1);
});

test("advanced observation cancellation returns unknown and permits read-only retry", async () => {
  let started = false;
  let finish!: (value: { id: string; state: "running" }) => void;

  const stalled = new Promise<{ id: string; state: "running" }>((resolve) => {
    finish = resolve;
  });

  let observations = 0;

  const adapter = defineAdapter({
    name: "example.advanced-observe-abort",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          async submit() {
            return { id: "box", state: "running" as const };
          },
          async observe() {
            observations++;

            if (observations === 1) {
              started = true;

              return stalled;
            }

            return { id: "recovered", state: "running" as const };
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

  const identity = {
    scope: client.scope,
    kind: "create" as const,
    operationId: "op",
    submissionId: "sub",
  };

  const controller = new AbortController();
  const waiting = client.operations.observe(identity, { signal: controller.signal });

  while (!started) await Bun.sleep(1);
  controller.abort("stop");
  await expect(
    Promise.race([
      waiting,
      Bun.sleep(500).then(() => {
        throw new Error("advanced observe did not stop");
      }),
    ]),
  ).resolves.toMatchObject({ kind: "unknown" });
  finish({ id: "late", state: "running" });
  await Bun.sleep(1);
  expect(await client.operations.observe(identity)).toMatchObject({
    kind: "completed",
    value: { id: "recovered" },
  });
  await client.close();
});

test("advanced lifecycle commits a marker once and cannot replay a prepared attempt", async () => {
  let submits = 0;
  let markers = 0;

  const adapter = defineAdapter({
    name: "example.advanced-lifecycle",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          submits++;

          return { id: `box-${submits}`, state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const input = { image: { kind: "prepared" as const, value: "image" }, networkPolicy: "blocked" };
  const prepared = await client.operations.prepare("create", input);
  const id = { operationId: "op-1", submissionId: "sub-1", invocationKey: "key-1" };

  const [one, two] = await Promise.allSettled([
    prepared.submit(id, {
      beforeSubmit: async () => {
        markers++;

        return true;
      },
    }),
    prepared.submit(id, {
      beforeSubmit: async () => {
        markers++;

        return true;
      },
    }),
  ]);

  expect([one.status, two.status].sort()).toEqual(["fulfilled", "rejected"]);
  expect(markers).toBe(1);
  expect(submits).toBe(1);
  const refused = await client.operations.prepare("create", input);
  expect(await refused.submit(id, { beforeSubmit: async () => false })).toBeNull();
  expect(submits).toBe(1);
  const failed = await client.operations.prepare("create", input);
  await expect(
    failed.submit(id, {
      beforeSubmit: async () => {
        throw new Error("ledger unavailable");
      },
    }),
  ).rejects.toThrow("Submission barrier failed");
  expect(submits).toBe(1);
  await client.close();
});

test("advanced preparation reports invalid arguments before provider preparation", async () => {
  let preparations = 0;

  const adapter = defineAdapter({
    name: "example.advanced-validation",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
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
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  await expect(
    client.operations.prepare("create", {
      image: { kind: "prepared", value: "x".repeat(513) },
      networkPolicy: "blocked",
    }),
  ).rejects.toMatchObject({ name: "SandbarError", code: "INVALID_ARGUMENT" });
  expect(preparations).toBe(0);
  await client.close();
});

test("cancelling a stalled advanced barrier settles before release without late submission", async () => {
  for (const mode of ["close", "abort"] as const) {
    for (const late of ["resolve", "reject"] as const) {
      let submits = 0;
      let markerCalls = 0;
      let release!: (allowed: boolean) => void;
      let fail!: (error: Error) => void;

      const gate = new Promise<boolean>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });

      const adapter = defineAdapter({
        name: "example.advanced-cancel-barrier",
        config: z.strictObject({}),
        credentials: z.strictObject({}),
        async connect() {
          return {
            scope: { authority: { kind: "account", id: "one" }, partition: {} },
            supports: { images: ["prepared"], network: ["blocked"] },
            async create() {
              submits++;

              return { id: "box", state: "running" as const };
            },
            async destroy() {
              return { computeStopped: true, retainedResources: [] };
            },
          };
        },
      });

      const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

      const prepared = await client.operations.prepare("create", {
        image: { kind: "prepared", value: "image" },
        networkPolicy: "blocked",
      });

      const controller = new AbortController();
      const identity = { operationId: "op", submissionId: "sub", invocationKey: "key" };

      const waiting = prepared.submit(identity, {
        beforeSubmit: () => {
          markerCalls++;

          return gate;
        },
        signal: controller.signal,
      });

      expect(markerCalls).toBe(1);

      if (mode === "close") await client.close();
      else controller.abort("stop");

      await expect(
        Promise.race([
          waiting,
          Bun.sleep(500).then(() => {
            throw new Error("advanced barrier did not stop waiting");
          }),
        ]),
      ).rejects.toMatchObject({ code: mode === "close" ? "CLIENT_CLOSED" : "WAIT_ABORTED" });
      expect(submits).toBe(0);
      await expect(
        prepared.submit(identity, { beforeSubmit: async () => true }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
      });

      if (late === "resolve") release(true);
      else fail(new Error("late marker failure"));
      await Bun.sleep(1);
      expect(submits).toBe(0);
      await client.close();
    }
  }
});

test("direct connection accepts a policy-bearing adapter clone", async () => {
  const adapter = defineAdapter({
    name: "example.host-policy",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    policy: { schema: z.strictObject({ endpoint: z.string() }), default: { endpoint: "default" } },
    async connect({ host }) {
      host.policy.endpoint satisfies string;

      return {
        scope: {
          authority: { kind: "account", id: "one" },
          partition: { endpoint: host.policy.endpoint },
        },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({
    adapter: adapter.withPolicy({ endpoint: "configured" }),
    config: {},
    credentials: {},
  });

  expect(client.scope.partition.endpoint).toBe("configured");
  await client.close();
});

test("advanced observation rejects foreign scope before provider reads", async () => {
  let reads = 0;

  const adapter = defineAdapter({
    name: "example.observe-scope",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: { region: "us" } },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          async submit() {
            return { id: "box", state: "running" as const };
          },
          async observe() {
            reads++;

            return null;
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  await expect(
    client.operations.observe({
      scope: { authority: { kind: "account", id: "other" }, partition: { region: "us" } },
      kind: "create",
      operationId: "op",
      submissionId: "sub",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(reads).toBe(0);
  await client.close();
});

test("imported ordinary and advanced recovery tokens are bounded and parsed", async () => {
  const seen: string[] = [];
  let submits = 0;

  const adapter = defineAdapter({
    name: "example.token-import",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          recovery: {
            version: 1,
            token: z.strictObject({ jobId: z.string().transform((value) => value.toUpperCase()) }),
          },
          async submit(_input, ctx) {
            submits++;

            return ctx.pending({ jobId: "seed" });
          },
          async observe(attempt) {
            seen.push(attempt.token?.jobId ?? "missing");

            return { id: "box", state: "running" as const };
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const op = await client.sandboxes.submitCreate({ environment: Image.prepared("image") });
  expect(await op.observe()).toBeNull();
  const raw = { ...op.reference, token: { jobId: "ordinary" } };
  expect(await (await client.recover(raw)).observe()).toMatchObject({ id: "box" });
  expect(seen).toEqual(["ORDINARY"]);

  const advanced = {
    scope: client.scope,
    kind: "create" as const,
    operationId: "op-advanced",
    submissionId: "sub-advanced",
    token: { jobId: "advanced" },
    tokenVersion: 1,
  };

  expect(await client.operations.observe(advanced)).toMatchObject({ kind: "completed" });
  expect(seen).toEqual(["ORDINARY", "ADVANCED"]);

  await expect(
    (await client.recover({ ...raw, token: { jobId: "x".repeat(5_000) } })).observe(),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(client.operations.observe({ ...advanced, tokenVersion: 2 })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(seen).toEqual(["ORDINARY", "ADVANCED"]);
  expect(submits).toBe(1);
  await client.close();
});

test("close stops stalled inspect, initial file read, and inventory waits", async () => {
  let inspectStarted = false;
  let readStarted = false;
  let inventoryStarted = false;
  let finishInspect!: (value: { id: string; state: "running" }) => void;
  let failRead!: (error: Error) => void;
  let finishInventory!: (value: { items: [] }) => void;

  const inspected = new Promise<{ id: string; state: "running" }>((resolve) => {
    finishInspect = resolve;
  });

  const read = new Promise<Uint8Array>((_resolve, reject) => {
    failRead = reject;
  });

  const inventory = new Promise<{ items: [] }>((resolve) => {
    finishInventory = resolve;
  });

  const adapter = defineAdapter({
    name: "example.read-close",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
        async inspect() {
          inspectStarted = true;

          return inspected;
        },
        files: {
          maxBytes: 1024,
          async read() {
            readStarted = true;

            return read;
          },
        },
        async inventory() {
          inventoryStarted = true;

          return inventory;
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const box = await client.sandboxes.create({ environment: Image.prepared("image") });
  const calls = [box.inspect(), box.readFile("/file"), client.operations.inventory({ limit: 1 })];
  const outcomes = Promise.allSettled(calls);

  while (!inspectStarted || !readStarted || !inventoryStarted) await Bun.sleep(1);
  await client.close();

  const settled = await Promise.race([
    outcomes,
    Bun.sleep(500).then(() => {
      throw new Error("reads did not stop on close");
    }),
  ]);

  for (const result of settled) {
    expect(result.status).toBe("rejected");

    if (result.status === "rejected")
      expect(result.reason).toMatchObject({ code: "CLIENT_CLOSED" });
  }

  finishInspect({ id: "box", state: "running" });
  failRead(new Error("late read rejection"));
  finishInventory({ items: [] });
  await Bun.sleep(1);
});

test("close stops a stalled file stream chunk without awaiting reader cancellation", async () => {
  let readStarted = false;
  let cancelRequested = false;
  let releasePull!: () => void;

  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>((resolve) => {
        releasePull = resolve;
      });
    },
    cancel() {
      return new Promise<void>(() => {});
    },
  });

  const getReader = stream.getReader.bind(stream);
  Object.defineProperty(stream, "getReader", {
    value: () => {
      const reader = getReader();
      const read = reader.read.bind(reader);
      const cancel = reader.cancel.bind(reader);
      reader.read = () => {
        readStarted = true;

        return read();
      };

      reader.cancel = () => {
        cancelRequested = true;

        return cancel();
      };

      return reader;
    },
  });

  const adapter = defineAdapter({
    name: "example.stream-close",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
        files: {
          maxBytes: 1024,
          async read() {
            return stream;
          },
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const box = await client.sandboxes.create({ environment: Image.prepared("image") });
  const pending = box.readFile("/file");

  while (!readStarted) await Bun.sleep(1);
  await client.close();
  await expect(
    Promise.race([
      pending,
      Bun.sleep(500).then(() => {
        throw new Error("stream read did not stop on close");
      }),
    ]),
  ).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  releasePull();
  await Bun.sleep(1);
  expect(cancelRequested).toBe(true);
});

test("oversized streamed file returns capacity error despite stalled or rejected cancel", async () => {
  for (const cancelMode of ["stall", "reject"] as const) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3));
      },
      cancel() {
        return cancelMode === "stall"
          ? new Promise<void>(() => {})
          : Promise.reject(new Error("cancel failed"));
      },
    });

    const adapter = defineAdapter({
      name: `example.file-capacity-${cancelMode}`,
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          supports: { images: ["prepared"], network: ["blocked"] },
          async create() {
            return { id: "box", state: "running" as const };
          },
          async destroy() {
            return { computeStopped: true, retainedResources: [] };
          },
          files: {
            maxBytes: 2,
            async read() {
              return stream;
            },
          },
        };
      },
    });

    const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
    const box = await client.sandboxes.create({ environment: Image.prepared("image") });
    await expect(
      Promise.race([
        box.readFile("/file"),
        Bun.sleep(300).then(() => {
          throw new Error("file capacity error was held by cancel");
        }),
      ]),
    ).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
    await Bun.sleep(1);
    await client.close();
  }
});

test("file reads enforce the SDK ceiling and reject invalid adapter limits before IO", async () => {
  let sequence = 0;

  const open = async (maxBytes: number, value: Uint8Array | ReadableStream<Uint8Array>) => {
    let reads = 0;

    const adapter = defineAdapter({
      name: `example.file-bound-${sequence++}`,
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          supports: { images: ["prepared"], network: ["blocked"] },
          async create() {
            return { id: "box", state: "running" as const };
          },
          async destroy() {
            return { computeStopped: true, retainedResources: [] };
          },
          files: {
            maxBytes,
            async read() {
              reads++;

              return value;
            },
          },
        };
      },
    });

    const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
    const box = await client.sandboxes.create({ environment: Image.prepared("image") });

    return { box, client, reads: () => reads };
  };

  const over = new Uint8Array(1_048_577);
  const buffered = await open(2_000_000, over);
  expect((await buffered.client.capabilities()).maxFileBytes).toBe(1_048_576);
  await expect(buffered.box.readFile("/over")).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  expect(buffered.reads()).toBe(1);
  await buffered.client.close();

  const streamed = await open(
    2_000_000,
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(over);
        controller.close();
      },
    }),
  );

  await expect(streamed.box.readFile("/over")).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  await streamed.client.close();

  const lower = await open(2, Uint8Array.of(1, 2, 3));
  expect((await lower.client.capabilities()).maxFileBytes).toBe(2);
  await expect(lower.box.readFile("/lower")).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  await lower.client.close();

  const exactBytes = new Uint8Array(1_048_576);
  exactBytes[0] = 7;
  exactBytes[exactBytes.length - 1] = 9;
  const exact = await open(2_000_000, exactBytes);
  const result = await exact.box.readFile("/exact");
  expect(result.length).toBe(1_048_576);
  expect(result[0]).toBe(7);
  expect(result[result.length - 1]).toBe(9);
  await exact.client.close();

  for (const invalid of [Number.NaN, Infinity, -1, 1.5]) {
    const bad = await open(invalid, Uint8Array.of(1));
    await expect(bad.box.readFile("/invalid")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      effect: "none",
    });
    expect(bad.reads()).toBe(0);
    await bad.client.close();
  }
});

test("stale observation cannot replace a continued dispatch checkpoint or replay an effect", async () => {
  const token = z.strictObject({ stage: z.enum(["not-submitted", "uncertain", "completed"]) });
  let effects = 0;
  let releaseRead!: () => void;
  let readStarted!: () => void;
  const heldRead = new Promise<void>((resolve) => (releaseRead = resolve));
  const readEntered = new Promise<void>((resolve) => (readStarted = resolve));
  const saved: unknown[] = [];

  const adapter = defineAdapter({
    name: "example.stale-observation",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" as const };
        },
        destroy: {
          recovery: { version: 1, token },
          async submit(_box, ctx) {
            return ctx.pending({ stage: "not-submitted" }, { pollAfterMs: 0 });
          },
          async observe(attempt, ctx) {
            readStarted();
            await heldRead;

            return ctx.pending(attempt.token!);
          },
          async continue(attempt, ctx) {
            if (token.parse(attempt.token).stage === "not-submitted") {
              await ctx.checkpoint({ stage: "uncertain" });
              effects++;
              await ctx.checkpoint({ stage: "completed" });
            }

            return ctx.pending({ stage: "completed" });
          },
        },
      };
    },
  });

  const client = await Sandbar.connect({
    adapter,
    config: {},
    credentials: {},
    onReference(reference) {
      saved.push(reference.token);
    },
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await box.submitDestroy();
    await operation.observe();
    const staleRead = operation.observe();
    await readEntered;
    await operation.continue();
    expect(effects).toBe(1);
    releaseRead();
    await staleRead;
    expect(operation.reference.token).toEqual({ stage: "completed" });
    expect(saved.at(-1)).toEqual({ stage: "completed" });
    await operation.continue();
    expect(effects).toBe(1);
  } finally {
    releaseRead();
    await client.close();
  }
});

test("reference persistence recovers after one failed observation save before continuation", async () => {
  const token = z.strictObject({
    stage: z.enum(["not-submitted", "validated", "uncertain", "completed"]),
  });

  let notSubmittedSaves = 0;
  let effects = 0;
  let saved: unknown;

  const adapter = defineAdapter({
    name: "example.recovered-persistence",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" as const };
        },
        destroy: {
          recovery: { version: 1, token },
          async submit(_box, ctx) {
            return ctx.pending({ stage: "not-submitted" }, { pollAfterMs: 0 });
          },
          async observe(attempt, ctx) {
            return ctx.pending({ stage: "validated" });
          },
          async continue(attempt, ctx) {
            if (token.parse(attempt.token).stage === "validated") {
              await ctx.checkpoint({ stage: "uncertain" });
              effects++;
              await ctx.checkpoint({ stage: "completed" });
            }

            return ctx.pending({ stage: "completed" });
          },
        },
      };
    },
  });

  const client = await Sandbar.connect({
    adapter,
    config: {},
    credentials: {},
    onReference(reference) {
      if (
        token.safeParse(reference.token).data?.stage === "not-submitted" &&
        ++notSubmittedSaves === 2
      )
        throw new Error("Temporary store failure");

      saved = reference.token;
    },
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await box.submitDestroy();
    await expect(operation.observe()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(effects).toBe(0);
    await operation.observe();
    expect(saved).toEqual({ stage: "validated" });
    await operation.continue();
    expect(effects).toBe(1);
    expect(saved).toEqual({ stage: "completed" });
    await operation.continue();
    expect(effects).toBe(1);
  } finally {
    await client.close();
  }
});
