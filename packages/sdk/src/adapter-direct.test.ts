import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter } from "sandbar-adapter";
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
      image: { kind: "prepared", value: "bad/image" },
      networkPolicy: "blocked",
    }),
  ).rejects.toMatchObject({ name: "SandbarError", code: "INVALID_ARGUMENT" });
  expect(preparations).toBe(0);
  await client.close();
});

test("closing during the advanced barrier prevents a late provider effect", async () => {
  let submits = 0;
  let unblock!: () => void;

  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });

  const adapter = defineAdapter({
    name: "example.advanced-close",
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

  const waiting = prepared.submit(
    { operationId: "op", submissionId: "sub", invocationKey: "key" },
    {
      beforeSubmit: async () => {
        await gate;

        return true;
      },
    },
  );

  await client.close();
  unblock();
  await expect(waiting).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  expect(submits).toBe(0);
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
