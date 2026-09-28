import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter, type SnapshotProfile } from "sandbar-adapter";
import { Sandbar, Image, UnsupportedFeatureError } from "./index";

const profile: SnapshotProfile = {
  id: "memory",
  preserve: "filesystem+memory",
  sourceStates: ["running"],
  interruption: "pause",
  sourceAfter: "unchanged",
  consistency: "crash-consistent",
  connections: "dropped",
  mountHandling: "none",
};

test("direct checks are read-only, required guarantees gate create, and minimal adapters still work", async () => {
  let creates = 0;
  let destroys = 0;
  let captures = 0;
  let status: "supported" | "unknown" | "unavailable" = "supported";

  const adapter = defineAdapter({
    name: "fixture.state",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          creates++;

          return { id: "box", state: "running" };
        },
        async destroy() {
          destroys++;

          return { computeStopped: true, retainedResources: [] };
        },
        async inspect(box) {
          return { id: box.id, state: "running" };
        },
        async snapshotProfiles() {
          return status === "supported"
            ? { status, value: { profiles: [profile] } }
            : { status, reason: "fixture evidence" };
        },
        async snapshotCapture() {
          captures++;
          throw new Error("future slice");
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

  const input = {
    environment: Image.prepared("base"),
    requirements: { snapshot: { preserve: "filesystem" as const } },
  };

  expect((await client.sandboxes.checkCreate(input)).status).toBe("unsupported");
  await expect(client.sandboxes.create(input)).rejects.toMatchObject({
    code: "UNSUPPORTED",
    effect: "none",
    feature: "create",
  });
  expect(creates).toBe(0);
  const box = await client.sandboxes.create({ environment: input.environment });
  expect((await box.checkSnapshot({ preserve: "filesystem+memory" })).status).toBe("supported");
  expect((await client.capabilities()).snapshots.capture.status).toBe("supported");
  const caps = await box.capabilities();
  caps.network.push("all");
  expect((await box.capabilities()).network).toEqual(["blocked"]);

  for (const value of ["unknown", "unavailable"] as const) {
    status = value;

    const required = {
      environment: input.environment,
      requirements: { snapshot: { preserve: "filesystem+memory" as const } },
    };

    expect((await client.sandboxes.checkCreate(required)).status).toBe(value);
    await expect(client.sandboxes.create(required)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      effect: "none",
    });
  }

  expect(captures).toBe(0);
  expect(creates).toBe(1);
  expect(destroys).toBe(0);
  await box.destroy();
  expect(destroys).toBe(1);
  await client.close();
});

for (const status of ["unsupported", "unknown", "unavailable"] as const) {
  test(`capability drift to ${status} during preparation stays effect-free`, async () => {
    let reads = 0;
    let creates = 0;
    let references = 0;

    const adapter = defineAdapter({
      name: "fixture.drift",
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          supports: { images: ["prepared"], network: ["blocked"] },
          async snapshotProfiles() {
            reads++;

            return reads === 1
              ? { status: "supported" as const, value: { profiles: [profile] } }
              : { status, reason: "evidence changed" };
          },
          async snapshotCapture() {
            throw new Error("Must not capture");
          },
          async create() {
            creates++;

            return { id: "box", state: "running" };
          },
          async destroy() {
            throw new Error("Must not destroy");
          },
        };
      },
    });

    const client = await Sandbar.connect({
      adapter,
      config: {},
      credentials: {},
      onReference() {
        references++;
      },
    });

    try {
      let failure: Error | undefined;

      try {
        await client.sandboxes.create({
          environment: Image.prepared("base"),
          requirements: { snapshot: { preserve: "filesystem+memory" } },
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failure = error;
      }

      expect(failure).toMatchObject({
        code: status === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE",
        effect: "none",
      });

      if (status === "unsupported") expect(failure).toBeInstanceOf(UnsupportedFeatureError);
      expect(reads).toBe(2);
      expect(creates).toBe(0);
      expect(references).toBe(0);
    } finally {
      await client.close();
    }
  });
}
