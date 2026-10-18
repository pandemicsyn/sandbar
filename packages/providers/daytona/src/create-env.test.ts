import { expect, test } from "bun:test";
import { z } from "zod";
import { Image, Sandbar, type AdapterRecoveryReference } from "sandbar-sdk";
import { createDaytonaAdapter } from "./adapter";

const SECRET = "CANARY-daytona-env-secret";

const CreateBody = z.object({
  name: z.string(),
  labels: z.record(z.string(), z.string()),
  env: z.record(z.string(), z.string()).optional(),
});

type CreateBody = z.infer<typeof CreateBody>;

function fixture(create?: (body: CreateBody) => Response) {
  const bodies: CreateBody[] = [];
  const posts: string[] = [];

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

      if (init?.method === "POST") posts.push(url.pathname);

      if (url.pathname === "/api/sandbox" && init?.method === "POST") {
        const body = CreateBody.parse(JSON.parse(String(init.body)));
        bodies.push(body);

        return (
          create?.(body) ??
          Response.json({
            id: "native-1",
            name: body.name,
            organizationId: "org-1",
            target: "us",
            state: "started",
            networkBlockAll: true,
            public: false,
            labels: body.labels,
            env: body.env,
          })
        );
      }

      throw new Error(`Unexpected fixture request ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );

  const saved: AdapterRecoveryReference[] = [];

  const connect = () =>
    Sandbar.connect({
      adapter: createDaytonaAdapter(fetchImpl),
      config: { target: "us", network: "blocked", environment: Image.prepared("snap-1") },
      credentials: { apiKey: "fixture-key" },
      onReference(reference) {
        saved.push(structuredClone(reference));
      },
    });

  return { connect, bodies, posts, saved };
}

test("Daytona sends create env natively in the one sandbox request and saves no value", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    expect((await client.capabilities()).createEnv).toBe(true);

    const operation = await client.sandboxes.submitCreate({
      env: { API_TOKEN: SECRET, MODE: "ci" },
    });

    const box = await operation.wait();
    expect(box.id).toBe("native-1");
    expect(f.posts).toEqual(["/api/sandbox"]);
    expect(f.bodies[0]?.env).toEqual({ API_TOKEN: SECRET, MODE: "ci" });
    expect(JSON.stringify([operation.reference, box.reference, f.saved])).not.toContain(SECRET);

    await client.sandboxes.create();
    expect(f.bodies[1]).not.toHaveProperty("env");
  } finally {
    await client.close();
  }
});

test.each([
  [400, "INVALID_ARGUMENT"],
  [500, "OUTCOME_UNKNOWN"],
] as const)("Daytona HTTP %i create messages redact echoed env values", async (status, code) => {
  const f = fixture((body) =>
    Response.json({ message: `bad env ${JSON.stringify(body.env)}` }, { status }),
  );

  const client = await f.connect();

  try {
    const error = await client.sandboxes.create({ env: { API_TOKEN: SECRET } }).then(
      () => undefined,
      (cause: Error) => cause,
    );

    expect(String(error?.message)).not.toContain(SECRET);
    expect(String(error?.message)).toContain("[redacted]");
    expect(error).toMatchObject({ code });
    expect(f.posts).toEqual(["/api/sandbox"]);
    expect(JSON.stringify(f.saved)).not.toContain(SECRET);
  } finally {
    await client.close();
  }
});
