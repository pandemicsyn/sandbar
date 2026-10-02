import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter } from "sandbar-adapter";
import { Sandbar, Image } from "sandbar-sdk";
import { previewResponse } from "./sandbox-preview";

async function clientFixture(access: "public" | "protected") {
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

  return Sandbar.connect({ adapter, config: {}, credentials: {} });
}

for (const access of ["public", "protected"] as const) {
  test(`preview recipe supplies ${access} access without starting a server`, async () => {
    const client = await clientFixture(access);

    try {
      const box = await client.sandboxes.create({ environment: Image.prepared("base") });

      const response = await previewResponse(
        box,
        3000,
        Object.assign(
          async (_url: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.redirect).toBe("error");
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

test("protected preview recipe refuses cross-origin redirects without forwarding its credential", async () => {
  let targetRequests = 0;
  const firstHeaders: (string | null)[] = [];

  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      targetRequests++;

      return new Response("redirect target");
    },
  });

  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      firstHeaders.push(request.headers.get("x-fixture-token"));

      return Response.redirect(target.url, 302);
    },
  });

  const client = await clientFixture("protected");

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("base") });

    // Translate only the fixture URL; exercise the runtime's real redirect handling and headers.
    const request: typeof fetch = Object.assign(
      (_url: RequestInfo | URL, init?: RequestInit) => fetch(source.url, init),
      { preconnect() {} },
    );

    await expect(previewResponse(box, 3000, request)).rejects.toBeDefined();
    expect(firstHeaders).toEqual(["private"]);
    expect(targetRequests).toBe(0);
  } finally {
    await client.close();
    source.stop(true);
    target.stop(true);
  }
});
