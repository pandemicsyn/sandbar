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
  let observeStarted = false;
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
            observeStarted = true;
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
  while (!observeStarted) await Bun.sleep(1);
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
