import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter } from "sandbar-adapter";
import { Sandbar, Image } from "sandbar-sdk";
import { previewResponse } from "./sandbox-preview";

for (const access of ["public", "protected"] as const) {
  test(`preview recipe supplies ${access} access without starting a server`, async () => {
    const adapter = defineAdapter({
      name: "docs.preview",
      config: z.object({}),
      credentials: z.object({}),
      async connect() {
        return {
          scope: { authority: { kind: "test", id: "one" }, partition: {} },
          supports: { images: ["prepared"], network: ["blocked"] },
          create: async () => ({ id: "one", state: "running" as const }),
          destroy: async () => ({ computeStopped: true, retainedResources: [] }),
          preview: async () =>
            access === "public"
              ? { access, url: "https://one.example.test" }
              : {
                  access,
                  url: "https://one.example.test",
                  headers: { "x-fixture-token": "private" },
                },
        };
      },
    });

    const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

    try {
      const box = await client.sandboxes.create({ environment: Image.prepared("base") });

      const response = await previewResponse(
        box,
        3000,
        Object.assign(
          async (_url: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.headers).toEqual(
              access === "protected" ? { "x-fixture-token": "private" } : undefined,
            );

            return new Response("ready");
          },
          { preconnect() {} },
        ),
      );

      expect(await response.text()).toBe("ready");
    } finally {
      await client.close();
    }
  });
}
