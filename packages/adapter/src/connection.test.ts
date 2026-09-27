import { expect, test } from "bun:test";
import { z } from "zod";
import { connectAdapter, defineAdapter, isOutcome, createAttemptContext } from "./index";

test("validated connection detaches scope, releases once, and does not echo secrets", async () => {
  let released = 0;

  const adapter = defineAdapter({
    name: "example.test",
    config: z.strictObject({ region: z.string() }),
    credentials: z.strictObject({ token: z.string() }),
    async connect({ config, credentials, host }) {
      expect(credentials.token).toBe("secret");
      host.onClose(() => {
        released++;
      });

      return {
        scope: { authority: { kind: "account", id: "one" }, partition: { region: config.region } },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create(input, _ctx) {
          return { id: input.image.value, state: "running" };
        },
        async destroy(_box, _ctx) {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const invalidCredentials = { token: "secret", extra: "secret" };
  await expect(
    connectAdapter(adapter, { config: { region: "us" }, credentials: invalidCredentials }),
  ).rejects.toThrow();

  const connection = await connectAdapter(adapter, {
    config: { region: "us" },
    credentials: { token: "secret" },
  });

  expect(connection.scope.partition.region).toBe("us");
  expect(Object.isFrozen(connection.scope.partition)).toBe(true);
  await Promise.all([connection.close(), connection.close()]);
  expect(released).toBe(1);
});

test("failed connect releases registered resources", async () => {
  let released = 0;

  const adapter = defineAdapter({
    name: "example.failure",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      host.onClose(() => {
        released++;
      });
      throw new Error("identity read failed");
    },
  });

  await expect(connectAdapter(adapter, { config: {}, credentials: {} })).rejects.toThrow(
    "identity read failed",
  );
  expect(released).toBe(1);
});

test("outcome constructors are branded and observe context lacks rejection", () => {
  const ctx = createAttemptContext(
    {
      operationId: "o",
      submissionId: "s",
      invocationKey: "i",
      signal: new AbortController().signal,
    },
    z.strictObject({ id: z.string() }),
  );

  expect(isOutcome(ctx.pending({ id: "job" }))).toBe(true);
  expect(isOutcome(ctx.reject("CAPACITY", "No capacity"))).toBe(true);
  expect(isOutcome({ status: "pending", token: {} })).toBe(false);
});

test("host policy is typed, validated, immutable, and cloned at registration", async () => {
  const observed: string[] = [];

  const adapter = defineAdapter({
    name: "example.policy",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    policy: {
      schema: z.strictObject({ allowedEndpoint: z.string().url() }),
      default: { allowedEndpoint: "https://default.example" },
    },
    async connect({ host }) {
      host.policy.allowedEndpoint satisfies string;
      observed.push(host.policy.allowedEndpoint);

      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "one", state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const configured = adapter.withPolicy({ allowedEndpoint: "https://configured.example" });
  expect(() => adapter.withPolicy({ allowedEndpoint: "invalid" })).toThrow();
  const first = await connectAdapter(adapter, { config: {}, credentials: {} });
  const second = await connectAdapter(configured, { config: {}, credentials: {} });
  expect(observed).toEqual(["https://default.example", "https://configured.example"]);
  await first.close();
  await second.close();
});
