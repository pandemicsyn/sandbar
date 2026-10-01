import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter } from "sandbar-adapter";
import { Sandbar, Image, type DirectConnectOptions } from "./index";
import { bindAdapter } from "./bound";

function fixture() {
  const policies: (string | undefined)[] = [];
  let connections = 0;

  const adapter = defineAdapter({
    name: "example.cleanup",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      connections++;

      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" as const };
        },
        async destroy(box) {
          policies.push(box.storage);

          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  return { adapter, policies, connections: () => connections };
}

for (const form of ["bound", "explicit"] as const) {
  test(`${form} cleanup policy precedence and destroy/submitDestroy agree`, async () => {
    const f = fixture();

    const connect = (options: DirectConnectOptions) =>
      form === "bound"
        ? Sandbar.connect(bindAdapter(f.adapter, {}, {}), options)
        : Sandbar.connect({ adapter: f.adapter, config: {}, credentials: {}, ...options });

    const options: DirectConnectOptions = { cleanup: { storage: "allow-unconfirmed" } };
    const pending = connect(options);
    options.cleanup!.storage = "require-durable";
    const permissive = await pending;
    const strict = await connect({});
    const empty = await connect({ cleanup: {} });

    try {
      const box = await permissive.sandboxes.create({ environment: Image.prepared("base") });
      await box.destroy();
      await (await box.submitDestroy()).wait();
      await box.destroy({ storage: "require-durable" });
      await (await box.submitDestroy({ storage: "require-durable" })).wait();
      const strictBox = await strict.sandboxes.create({ environment: Image.prepared("base") });
      await strictBox.destroy();
      await strictBox.destroy({ storage: "allow-unconfirmed" });
      await (await strictBox.submitDestroy()).wait();
      await (await empty.sandboxes.create({ environment: Image.prepared("base") })).destroy();
      expect(f.policies).toEqual([
        "allow-unconfirmed",
        "allow-unconfirmed",
        "require-durable",
        "require-durable",
        "require-durable",
        "allow-unconfirmed",
        "require-durable",
        "require-durable",
      ]);
    } finally {
      await Promise.all([permissive.close(), strict.close(), empty.close()]);
    }

    expect(f.policies).toHaveLength(8);
  });

  test(`${form} invalid cleanup rejects before connecting`, async () => {
    const f = fixture();

    for (const cleanup of [
      null,
      "allow-unconfirmed",
      { storage: "flush" },
      { storage: null },
      { other: true },
    ]) {
      // @ts-expect-error Exercise invalid untyped caller input.
      const options: DirectConnectOptions = { cleanup };

      const pending =
        form === "bound"
          ? Sandbar.connect(bindAdapter(f.adapter, {}, {}), options)
          : Sandbar.connect({ adapter: f.adapter, config: {}, credentials: {}, ...options });

      await expect(pending).rejects.toMatchObject({ code: "INVALID_ARGUMENT", effect: "none" });
    }

    expect(f.connections()).toBe(0);
  });
}
