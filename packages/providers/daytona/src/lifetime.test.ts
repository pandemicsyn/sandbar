import { expect, test } from "bun:test";
import { z } from "zod";
import { Image, Sandbar } from "sandbar-sdk";
import { createDaytonaAdapter } from "./adapter";

const CreateBody = z.object({
  name: z.string(),
  labels: z.record(z.string(), z.string()),
  ttlMinutes: z.number(),
});

function fixture() {
  const minutes: number[] = [];

  const fetchImpl: typeof fetch = Object.assign(
    async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (url.pathname === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (url.pathname === "/api/snapshots/snap-1")
        return Response.json({
          id: "snap-1",
          name: "snap-1",
          imageName: "alpine:3.21",
          organizationId: "org-1",
          state: "active",
          regionIds: ["us"],
          sandboxClass: "container",
        });

      if (url.pathname === "/api/sandbox" && init?.method === "POST") {
        const body = CreateBody.parse(JSON.parse(String(init.body)));
        minutes.push(body.ttlMinutes);

        return Response.json({
          id: `native-${minutes.length}`,
          name: body.name,
          organizationId: "org-1",
          target: "us",
          state: "started",
          networkBlockAll: true,
          public: false,
          labels: body.labels,
        });
      }

      throw new Error(`Unexpected fixture request ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );

  const connect = (config: { lifecycle?: { lifetimeSeconds: number }; ttlMinutes?: number } = {}) =>
    Sandbar.connect({
      adapter: createDaytonaAdapter(fetchImpl),
      config: {
        target: "us",
        network: "blocked",
        environment: Image.prepared("snap-1"),
        ...config,
      },
      credentials: { apiKey: "fixture-key" },
    });

  return { connect, minutes };
}

test("Daytona sends the setup lifetime, the deprecated ttlMinutes and per-create overrides in minutes", async () => {
  for (const [config, expected] of [
    [{}, 15],
    [{ lifecycle: { lifetimeSeconds: 3600 } }, 60],
    [{ ttlMinutes: 30 }, 30],
  ] as const) {
    const f = fixture();
    const client = await f.connect(config);

    try {
      await client.sandboxes.create();
      expect(f.minutes).toEqual([expected]);
    } finally {
      await client.close();
    }
  }

  const f = fixture();
  const client = await f.connect();

  try {
    expect((await client.capabilities()).lifetime?.minSeconds).toBe(1);
    await client.sandboxes.create({ lifecycle: { lifetimeSeconds: 7200 } });
    // Daytona keeps whole minutes, so seconds round up.
    await client.sandboxes.create({ lifecycle: { lifetimeSeconds: 90 } });
    expect(f.minutes).toEqual([120, 2]);
  } finally {
    await client.close();
  }
});

test("Daytona rejects lifecycle.lifetimeSeconds together with the deprecated ttlMinutes", async () => {
  await expect(
    fixture().connect({ lifecycle: { lifetimeSeconds: 600 }, ttlMinutes: 10 }),
  ).rejects.toThrow();
});
