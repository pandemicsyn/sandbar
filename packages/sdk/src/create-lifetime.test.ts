import { expect, test } from "bun:test";
import { z } from "zod";
import {
  defineAdapter,
  sandboxReference,
  type CreateInput as NativeCreateInput,
  type LifetimeLimits,
} from "@sandbar-sdk/adapter";
import { Sandbar, SandbarError, UnsupportedFeatureError } from "./index";

const scope = { authority: { kind: "account", id: "one" }, partition: {} };

const Token = z.strictObject({ submissionId: z.string() });

/** A provider that records each native create and applies the per-create lifetime it declares. */
function fixture(lifetime?: LifetimeLimits) {
  const creates: NativeCreateInput[] = [];

  const adapter = defineAdapter({
    name: "fixture.lifetime",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope,
        defaultImage: { kind: "prepared" as const, value: "base" },
        supports: { images: ["prepared" as const], network: ["blocked"], lifetime },
        create: {
          recovery: { version: 1, token: Token },
          async submit(input, ctx) {
            creates.push(structuredClone(input));
            const id = `box-${creates.length}`;

            return {
              id,
              reference: sandboxReference("fixture.lifetime", scope, id, {
                operation: ctx.operationId,
                submission: ctx.submissionId,
              }),
              state: "running" as const,
            };
          },
          async observe() {
            return null;
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  return {
    creates,
    connect: () => Sandbar.connect({ adapter, config: {}, credentials: {} }),
  };
}

test("a per-create lifetime reaches the native create and capabilities report the range", async () => {
  const f = fixture({ minSeconds: 60, maxSeconds: 3600 });
  const client = await f.connect();

  expect((await client.capabilities()).lifetime).toEqual({ minSeconds: 60, maxSeconds: 3600 });

  await client.sandboxes.create({ lifecycle: { lifetimeSeconds: 1800 } });
  await client.sandboxes.create();

  expect(f.creates.map((input) => input.lifetimeSeconds)).toEqual([1800, undefined]);
  await client.close();
});

test("a lifetime outside the adapter's range rejects before any create", async () => {
  const f = fixture({ minSeconds: 60, maxSeconds: 3600 });
  const client = await f.connect();

  for (const lifetimeSeconds of [30, 3601]) {
    const plan = await client.sandboxes.checkCreate({ lifecycle: { lifetimeSeconds } });

    expect(plan).toMatchObject({ status: "unsupported" });
    expect(plan.status === "unsupported" && plan.reason).toContain("60-3600 seconds");

    const error = await client.sandboxes
      .create({ lifecycle: { lifetimeSeconds } })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(UnsupportedFeatureError);
  }

  expect(f.creates).toEqual([]);
  await client.close();
});

test("an adapter without per-create lifetimes rejects one and still creates without it", async () => {
  const f = fixture();
  const client = await f.connect();

  expect((await client.capabilities()).lifetime).toBeNull();

  const error = await client.sandboxes
    .create({ lifecycle: { lifetimeSeconds: 600 } })
    .catch((cause: unknown) => cause);

  expect(error).toBeInstanceOf(UnsupportedFeatureError);
  expect(f.creates).toEqual([]);

  await client.sandboxes.create({ lifecycle: {} });
  expect(f.creates).toHaveLength(1);
  await client.close();
});

test("a lifetime that is not a positive whole number is an invalid argument", async () => {
  const f = fixture({ minSeconds: 1, maxSeconds: 3600 });
  const client = await f.connect();

  for (const lifetimeSeconds of [0, -5, 1.5])
    expect(
      await client.sandboxes
        .create({ lifecycle: { lifetimeSeconds } })
        .catch((cause: unknown) => cause instanceof SandbarError && cause.code),
    ).toBe("INVALID_ARGUMENT");

  expect(f.creates).toEqual([]);
  await client.close();
});
