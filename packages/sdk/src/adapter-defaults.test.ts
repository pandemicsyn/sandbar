import { expect, test } from "bun:test";
import { defineAdapter } from "sandbar-adapter";
import { z } from "zod";
import { Sandbar } from "./index";

function definition(defaultNetworkPolicy?: string) {
  const observed: string[] = [];
  let releases = 0;

  const adapter = defineAdapter({
    name: "defaults.fixture",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      host.onClose(() => {
        releases++;
      });

      return {
        scope: { authority: { kind: "account", id: "fixture" }, partition: {} },
        defaultNetworkPolicy,
        defaultImage: { kind: "oci", value: "ubuntu:24.04" },
        supports: { images: ["oci"], network: ["internet", "blocked"] },
        async create(input) {
          observed.push(input.networkPolicy);

          return { id: "fixture", state: "running" };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  return { adapter, observed, releases: () => releases };
}

test("explicit adapter policy applies to omitted create input; caller overrides and existing blocked defaults survive", async () => {
  for (const policy of [undefined, "internet"]) {
    const fixture = definition(policy);
    const client = await Sandbar.connect({ adapter: fixture.adapter, config: {}, credentials: {} });

    try {
      expect((await client.checkCreate()).status).toBe("supported");
      await client.sandboxes.create();
      await client.sandboxes.create({ networkPolicy: "blocked" });
      expect(fixture.observed).toEqual([policy ?? "blocked", "blocked"]);
    } finally {
      await client.close();
    }
  }
});

test("an unsupported adapter default fails connection and releases owned resources", async () => {
  const fixture = definition("unsupported-policy");
  await expect(
    Sandbar.connect({ adapter: fixture.adapter, config: {}, credentials: {} }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(fixture.observed).toEqual([]);
  expect(fixture.releases()).toBe(1);
});
