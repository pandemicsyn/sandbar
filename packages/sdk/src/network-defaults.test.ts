import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter, type SnapshotInfo, type SnapshotRestoreInput } from "@sandbar-sdk/adapter";
import { Sandbar, Image, AdapterSnapshot } from "./index";

const scope = { authority: { kind: "account", id: "one" }, partition: {} };

const reference = {
  version: 1 as const,
  kind: "snapshot" as const,
  provider: "fixture.network",
  scope,
  nativeId: "snapshot",
  ownership: "unknown" as const,
};

const info: SnapshotInfo = {
  reference,
  preserve: "filesystem",
  restoreExecution: "fresh",
  consistency: "unknown",
  source: null,
  state: "ready",
  createdAt: null,
  expiration: "unknown",
  excludedPaths: null,
  mounts: [],
  mountHandling: "none",
  dependencies: [],
  nativeDependencies: null,
  restore: {
    networkPolicies: ["blocked", "internet"],
    resources: false,
    mounts: false,
    independentLifecycle: true,
  },
};

async function fixture(
  defaultNetworkPolicy?: string,
  pendingRestore = false,
  networkPolicyAliases?: Record<string, string>,
) {
  const creates: string[] = [];
  const restores: SnapshotRestoreInput[] = [];

  const adapter = defineAdapter({
    name: reference.provider,
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope,
        defaultNetworkPolicy,
        networkPolicyAliases,
        defaultImage: { kind: "prepared" as const, value: "base" },
        supports: { images: ["prepared" as const], network: ["blocked", "internet"] },
        async create(input) {
          creates.push(input.networkPolicy);

          return { id: "box", state: "running" as const };
        },
        async snapshotInspect() {
          return info;
        },
        snapshotRestore: {
          async prepare(input) {
            restores.push(input);

            return input;
          },
          recovery: { version: 1, token: z.strictObject({ policy: z.string() }) },
          async submit(input, ctx) {
            if (pendingRestore) return ctx.pending({ policy: input.request.networkPolicy });

            return { id: "restored", state: "running" as const };
          },
          async observe(attempt) {
            return { id: `restored-${attempt.token.policy}`, state: "running" as const };
          },
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

  return { client, creates, restores, snapshot: new AdapterSnapshot(client, reference) };
}

test.each([undefined, "internet"])(
  "create/check/submit and restore resolve network default %s",
  async (policy) => {
    const f = await fixture(policy);

    try {
      expect((await f.client.sandboxes.checkCreate()).status).toBe("supported");
      expect(f.creates).toHaveLength(0);
      await f.client.sandboxes.create();
      const operation = await f.client.sandboxes.submitCreate();
      await operation.wait();
      expect(operation.reference.networkPolicy).toBe(policy ?? "blocked");
      await f.client.sandboxes.create({ networkPolicy: "blocked" });
      expect(f.creates).toEqual([policy ?? "blocked", policy ?? "blocked", "blocked"]);
      await f.snapshot.restore();
      const restored = await f.snapshot.submitRestore();
      expect(restored.reference.networkPolicy).toBe(policy ?? "blocked");
      await restored.wait();
      await f.snapshot.restore({ networkPolicy: "blocked" });
      expect(f.restores.map((input) => input.request.networkPolicy)).toEqual([
        policy ?? "blocked",
        policy ?? "blocked",
        "blocked",
      ]);

      if (policy)
        expect(() =>
          Object.assign(f.client.session, { defaultNetworkPolicy: "blocked" }),
        ).toThrow();
    } finally {
      await f.client.close();
    }
  },
);

test("network selects a policy, and deprecated aliases resolve before support checks", async () => {
  const f = await fixture("blocked", false, { "native-open": "internet" });

  try {
    await f.client.sandboxes.create({ network: "internet" });
    await f.client.sandboxes.create({ networkPolicy: "native-open" });
    await f.client.sandboxes.create({ network: "native-open" });
    await f.client.sandboxes.create({ network: "internet", networkPolicy: "internet" });
    const operation = await f.client.sandboxes.submitCreate({ network: "native-open" });
    await operation.wait();
    expect(operation.reference.networkPolicy).toBe("internet");
    expect(f.creates).toEqual(["internet", "internet", "internet", "internet", "internet"]);
    await f.snapshot.restore({ network: "internet" });
    await f.snapshot.restore({ networkPolicy: "native-open" });
    expect(f.restores.map((input) => input.request.networkPolicy)).toEqual([
      "internet",
      "internet",
    ]);

    await expect(
      f.client.sandboxes.create({ network: "internet", networkPolicy: "blocked" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      f.snapshot.restore({ network: "internet", networkPolicy: "blocked" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(f.client.sandboxes.create({ network: "unsupported" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect((await f.client.capabilities()).network).toEqual(["blocked", "internet"]);
    expect(f.creates).toHaveLength(5);
    expect(f.restores).toHaveLength(2);
  } finally {
    await f.client.close();
  }
});

test.each(["", 42, null])("invalid adapter network alias map is rejected: %p", async (value) => {
  await expect(
    fixture(undefined, false, JSON.parse(JSON.stringify({ old: value }))),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

test("invalid explicit policy and restore inputs reject before native work", async () => {
  const f = await fixture("internet");

  try {
    for (const input of [null, "", 42].flatMap((value) =>
      [{ networkPolicy: value }, { network: value }].map((v) => JSON.parse(JSON.stringify(v))),
    )) {
      await expect(f.client.sandboxes.checkCreate(input)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(f.client.sandboxes.submitCreate(input)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(f.client.sandboxes.create(input)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(f.snapshot.restore(input)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }

    for (const value of [null, 42, "bad"])
      await expect(f.snapshot.restore(JSON.parse(JSON.stringify(value)))).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    await expect(
      f.client.sandboxes.create({
        environment: Image.prepared("base"),
        networkPolicy: "unsupported",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(f.creates).toHaveLength(0);
    expect(f.restores).toHaveLength(0);
  } finally {
    await f.client.close();
  }
});

test.each(["", null, 42])(
  "invalid adapter default is rejected at connection: %s",
  async (value) => {
    await expect(fixture(JSON.parse(JSON.stringify(value)))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  },
);

test("saved restore policy survives recovery with a different connection default", async () => {
  const first = await fixture("internet", true);
  const operation = await first.snapshot.submitRestore();
  const saved = JSON.parse(JSON.stringify(operation.reference));
  expect(saved.networkPolicy).toBe("internet");
  expect(first.restores[0]?.request.networkPolicy).toBe("internet");
  await first.client.close();
  const second = await fixture("blocked", true);

  try {
    const recovered = await second.client.recover(saved);
    expect(await recovered.wait()).toMatchObject({ id: "restored-internet" });
    expect(recovered.reference.networkPolicy).toBe("internet");
    expect(second.restores).toHaveLength(0);
  } finally {
    await second.client.close();
  }
});
