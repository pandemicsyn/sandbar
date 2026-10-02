import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter, type CreateInput as NativeCreateInput } from "sandbar-adapter";
import { Image, Sandbar, type ImageInput } from "./index";

async function fixture(defaultImage?: ImageInput) {
  const requests: NativeCreateInput[] = [];

  const client = await Sandbar.connect({
    adapter: defineAdapter({
      name: "fixture.defaults",
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          defaultImage,
          supports: { images: ["prepared"], network: ["blocked"] },
          async create(input) {
            requests.push(input);

            return { id: `box-${requests.length}`, state: "running" };
          },
          async destroy() {
            return { computeStopped: true, retainedResources: [] };
          },
        };
      },
    }),
    config: {},
    credentials: {},
  });

  return { client, requests };
}

test("check, submit and create resolve the same default before required native dispatch", async () => {
  const { client, requests } = await fixture(Image.prepared("configured"));

  try {
    expect((await client.sandboxes.checkCreate()).status).toBe("supported");
    expect((await client.sandboxes.checkCreate({ labels: { job: "report" } })).status).toBe(
      "supported",
    );
    expect(requests).toHaveLength(0);
    await client.sandboxes.create();
    await (await client.sandboxes.submitCreate()).wait();
    await client.sandboxes.create({ labels: { job: "report" } });
    await client.sandboxes.create({ environment: Image.prepared("override") });
    await client.sandboxes.create();
    expect(requests.map((request) => request.image.value)).toEqual([
      "configured",
      "configured",
      "configured",
      "override",
      "configured",
    ]);
    expect(requests.every((request) => request.networkPolicy === "blocked")).toBe(true);
    expect(requests[2]?.labels).toEqual({ job: "report" });

    for (const call of [
      client.sandboxes.checkCreate,
      client.sandboxes.submitCreate,
      client.sandboxes.create,
    ]) {
      await expect(call({ environment: Image.prepared(" ") })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(
        call({
          environment: Image.prepared({
            kind: "prepared",
            value: "foreign",
            provider: "other",
            scope: client.scope,
          }),
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }

    expect(requests).toHaveLength(5);
  } finally {
    await client.close();
  }
});

test("missing defaults are actionable across all creation entrypoints without mutation", async () => {
  const { client, requests } = await fixture();

  try {
    for (const call of [
      client.sandboxes.checkCreate,
      client.sandboxes.submitCreate,
      client.sandboxes.create,
    ])
      await expect(call()).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("environment"),
      });
    expect(requests).toHaveLength(0);
    await client.sandboxes.create({ environment: Image.prepared("explicit") });
    expect(requests).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("configured scoped images retain scope enforcement", async () => {
  const { client, requests } = await fixture(
    Image.prepared({
      kind: "prepared",
      value: "foreign",
      provider: "other",
      scope: { authority: { kind: "account", id: "one" }, partition: {} },
    }),
  );

  try {
    await expect(client.sandboxes.create()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(requests).toHaveLength(0);
  } finally {
    await client.close();
  }
});
