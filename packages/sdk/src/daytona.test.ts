import { expect, test } from "bun:test";
import { Sandbar, Image } from "./index";
import { daytona } from "./daytona";

test("public Daytona factory forwards bounded TTL without provider IO during construction", async () => {
  const originalFetch = globalThis.fetch;
  const ttl: number[] = [];
  let reads = 0;

  const fixtureFetch: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;

      if (init?.method !== "POST") reads++;

      if (path === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

      if (path === "/api/regions")
        return Response.json([
          { id: "us", name: "US", regionType: "shared", organizationId: "org-1" },
        ]);

      if (path === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (path === "/api/snapshots/snap-1")
        return Response.json({
          id: "snap-1",
          organizationId: "org-1",
          state: "active",
          regionIds: ["us"],
          sandboxClass: "container",
        });

      if (path === "/api/sandbox" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        ttl.push(body.ttlMinutes);

        return Response.json({
          id: `box-${ttl.length}`,
          name: body.name,
          organizationId: "org-1",
          target: "us",
          state: "started",
          networkBlockAll: true,
          public: false,
          labels: body.labels,
          snapshot: body.snapshot,
        });
      }

      throw new Error(`Unexpected fixture route ${path}`);
    },
    { preconnect: originalFetch.preconnect },
  );

  globalThis.fetch = fixtureFetch;

  try {
    const bounded = daytona({ apiKey: "fixture", target: "us", ttlMinutes: 15 });
    expect(reads).toBe(0);
    const first = await Sandbar.connect(bounded);
    await first.sandboxes.create({ environment: Image.prepared("snap-1") });
    await first.close();
    const fallback = await Sandbar.connect(daytona({ apiKey: "fixture", target: "us" }));
    await fallback.sandboxes.create({ environment: Image.prepared("snap-1") });
    await fallback.close();
    expect(ttl).toEqual([15, 60]);
    const before = reads;
    await expect(
      Sandbar.connect(daytona({ apiKey: "fixture", target: "us", ttlMinutes: 0 })),
    ).rejects.toThrow();
    expect(reads).toBe(before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
