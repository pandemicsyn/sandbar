import { expect, test } from "bun:test";
import { Image, Sandbar } from "sandbar-sdk";
import { createDaytonaAdapter } from "./adapter";

const snapshot = (name: string) => ({
  id: "built-1",
  name,
  imageName: "alpine:3.21",
  organizationId: "org-1",
  state: "active",
  regionIds: ["us"],
  sandboxClass: "container",
});

function fixture(input: { create?: Response; build?: Response }) {
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

      if (init?.method === "POST") posts.push(url.pathname);

      if (url.pathname === "/api/snapshots" && init?.method === "POST") {
        const name = JSON.parse(String(init.body)).name;

        return input.build ?? Response.json(snapshot(name));
      }

      if (url.pathname === "/api/snapshots/snap-1")
        return Response.json({ ...snapshot("snap-1"), id: "snap-1" });

      if (url.pathname.startsWith("/api/snapshots/")) return new Response(null, { status: 404 });

      if (url.pathname === "/api/sandbox" && init?.method === "POST")
        return input.create ?? new Response(null, { status: 500 });

      throw new Error(`Unexpected fixture request ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );

  const connect = () =>
    Sandbar.connect({
      adapter: createDaytonaAdapter(fetchImpl),
      config: { target: "us", network: "blocked" },
      credentials: { apiKey: "fixture-key" },
    });

  return { connect, posts };
}

test.each([
  [400, "INVALID_ARGUMENT"],
  [401, "UNAUTHENTICATED"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [422, "INVALID_ARGUMENT"],
  [429, "RATE_LIMIT"],
] as const)(
  "Daytona create HTTP %i is a clean %s rejection with the native reason",
  async (status, code) => {
    const { connect, posts } = fixture({
      create: Response.json(
        {
          statusCode: status,
          message: "Total CPU limit exceeded.\nMaximum allowed: 4 (key fixture-key)",
          error: "Forbidden",
        },
        { status },
      ),
    });

    const client = await connect();

    try {
      const error = await client.sandboxes
        .create({ environment: Image.prepared("snap-1"), networkPolicy: "blocked" })
        .then(
          () => undefined,
          (failure: Error & { code?: string }) => failure,
        );

      expect(error).toMatchObject({ code });
      expect(error?.message).toContain(
        `Daytona rejected sandbox creation (HTTP ${status}): Total CPU limit exceeded. Maximum allowed: 4`,
      );
      expect(error?.message).not.toContain("fixture-key");
      expect(posts).toEqual(["/api/sandbox"]);
    } finally {
      await client.close();
    }
  },
);

test("Daytona validation message arrays are joined", async () => {
  const { connect } = fixture({
    create: Response.json(
      { statusCode: 400, message: ["snapshot must be a string", "target is invalid"] },
      { status: 400 },
    ),
  });

  const client = await connect();

  try {
    await expect(
      client.sandboxes.create({ environment: Image.prepared("snap-1"), networkPolicy: "blocked" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("snapshot must be a string; target is invalid"),
    });
  } finally {
    await client.close();
  }
});

test.each([409, 500, 503])(
  "Daytona create HTTP %i stays an unknown outcome without replay",
  async (status) => {
    const { connect, posts } = fixture({
      create: Response.json({ message: "upstream trouble" }, { status }),
    });

    const client = await connect();

    try {
      await expect(
        client.sandboxes.create({
          environment: Image.prepared("snap-1"),
          networkPolicy: "blocked",
        }),
      ).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        message: expect.stringContaining(`(HTTP ${status}): upstream trouble`),
      });
      expect(posts).toEqual(["/api/sandbox"]);
    } finally {
      await client.close();
    }
  },
);

test("a rejected OCI snapshot build rejects cleanly before any sandbox request", async () => {
  const { connect, posts } = fixture({
    build: Response.json({ message: "Invalid image name" }, { status: 400 }),
  });

  const client = await connect();

  try {
    await expect(
      client.sandboxes.create({ environment: Image.oci("alpine:3.21"), networkPolicy: "blocked" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining(
        "Daytona rejected image build (HTTP 400): Invalid image name",
      ),
    });
    expect(posts).toEqual(["/api/snapshots"]);
  } finally {
    await client.close();
  }
});

test("a sandbox rejection after an OCI snapshot build stays unknown because the snapshot remains", async () => {
  const { connect, posts } = fixture({
    create: Response.json({ message: "Total CPU limit exceeded" }, { status: 403 }),
  });

  const client = await connect();

  try {
    await expect(
      client.sandboxes.create({ environment: Image.oci("alpine:3.21"), networkPolicy: "blocked" }),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(posts).toEqual(["/api/snapshots", "/api/sandbox"]);
  } finally {
    await client.close();
  }
});
