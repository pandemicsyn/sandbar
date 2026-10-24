import { expect, test } from "bun:test";
import { Image, Sandbar } from "sandbar-sdk";
import { createDaytonaAdapter } from "./adapter";

type NativeFixture = {
  id: string;
  name: string;
  organizationId: string;
  target: string;
  state: string;
  labels?: Record<string, string>;
  createdAt?: string;
  networkBlockAll: boolean;
  public: boolean;
  autoDestroyAt?: string;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
};

function native(id: string, overrides: Partial<NativeFixture> = {}): NativeFixture {
  return {
    id,
    name: `name-${id}`,
    organizationId: "org-1",
    target: "us",
    state: "started",
    labels: { "sandbar.submission": `sub-${id}`, "sandbar.operation": `op_${id}` },
    networkBlockAll: true,
    public: false,
    autoDestroyAt: "2026-10-01T01:00:00Z",
    autoStopInterval: 0,
    autoDeleteInterval: -1,
    ...overrides,
  };
}

function fixture(sandboxes: NativeFixture[], listOmitsState = false) {
  const calls: string[] = [];

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}${url.search}`);

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (url.pathname === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (url.pathname === "/api/snapshots/prepared")
        return Response.json({
          id: "prepared",
          organizationId: "org-1",
          state: "active",
          regionIds: ["us"],
          sandboxClass: "container",
        });

      if (url.pathname === "/api/sandbox" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        const created = { ...native(`created-${sandboxes.length}`), ...body };
        sandboxes.push(created);

        return Response.json(created);
      }

      if (url.pathname === "/api/sandbox" && method === "GET") {
        const offset = Number(url.searchParams.get("cursor") ?? "0");
        const limit = Number(url.searchParams.get("limit"));

        // Daytona's list item makes state optional; the detail read always carries it.
        const items = sandboxes
          .slice(offset, offset + limit)
          .map(({ state, ...rest }) => (listOmitsState ? rest : { ...rest, state }));

        const next = offset + limit < sandboxes.length ? String(offset + limit) : null;

        return Response.json({ items, nextCursor: next });
      }

      const detail = sandboxes.find((value) => url.pathname === `/api/sandbox/${value.id}`);

      if (detail && method === "GET") return Response.json(detail);

      throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
    },
    { preconnect() {} },
  );

  return {
    calls,
    connect: () =>
      Sandbar.connect({
        adapter: createDaytonaAdapter(fetcher),
        config: { target: "us", networkPolicy: "blocked", ttlMinutes: 15 },
        credentials: { apiKey: "key" },
      }),
  };
}

test("Daytona lists only verified Sandbar-labelled sandboxes with reopenable references", async () => {
  const sandboxes = [
    native("labelled"),
    native("unlabelled", { labels: { team: "a" } }),
    native("foreign-org", { organizationId: "org-2" }),
    native("other-target", { target: "eu" }),
    native("no-operation", { labels: { "sandbar.submission": "sub-no-operation" } }),
    native("archived", { state: "archived" }),
  ];

  const f = fixture(sandboxes);
  const client = await f.connect();

  try {
    const created = await client.sandboxes.create({ environment: Image.prepared("prepared") });
    f.calls.length = 0;

    const first = await client.sandboxes.list({ limit: 4 });
    expect(first.coverage).toBe("sandbar-managed");
    expect(first.nextCursor).toBe("4");
    expect(first.items).toEqual([expect.objectContaining({ id: "labelled", state: "running" })]);
    expect(first.items[0]!.reference).toMatchObject({
      kind: "sandbox",
      provider: "daytona",
      nativeId: "labelled",
      ownership: "verified-created",
      receipt: JSON.stringify({ operation: "op_labelled", submission: "sub-labelled" }),
    });
    // One native page read plus one detail read per labelled candidate in scope.
    expect(f.calls).toEqual(["GET /api/sandbox?limit=4", "GET /api/sandbox/labelled"]);

    const second = await client.sandboxes.list({ cursor: first.nextCursor, limit: 4 });
    expect(second.nextCursor).toBeUndefined();
    expect(second.items.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "no-operation", state: "running" },
      { id: "archived", state: "suspended" },
      { id: created.id, state: "running" },
    ]);
    expect(second.items[0]!.reference).toBeNull();
    expect(second.items[2]!.reference).toEqual(created.reference);

    const reopened = await client.sandboxes.get(first.items[0]!.reference!);
    expect(reopened.id).toBe("labelled");
    expect((await client.sandboxes.get(second.items[2]!.reference!)).id).toBe(created.id);
  } finally {
    await client.close();
  }
});

test("Daytona lists a sandbox whose list item has no state, using the detail read", async () => {
  const f = fixture([native("labelled")], true);
  const client = await f.connect();

  try {
    const page = await client.sandboxes.list({ limit: 10 });
    expect(page.items).toEqual([expect.objectContaining({ id: "labelled", state: "running" })]);
  } finally {
    await client.close();
  }
});

test("Daytona lists create labels without its own markers, and the creation time", async () => {
  const f = fixture([
    native("labelled", {
      labels: {
        "sandbar.submission": "sub-labelled",
        "sandbar.operation": "op_labelled",
        "sandbar.imageSnapshot": "snap",
        run: "42",
      },
      createdAt: "2026-10-23T10:00:00.000Z",
    }),
    native("plain"),
  ]);

  const client = await f.connect();

  try {
    const page = await client.sandboxes.list({ limit: 10 });
    expect(page.items.map(({ id, labels, createdAt }) => ({ id, labels, createdAt }))).toEqual([
      { id: "labelled", labels: { run: "42" }, createdAt: "2026-10-23T10:00:00.000Z" },
      { id: "plain", labels: {}, createdAt: null },
    ]);
  } finally {
    await client.close();
  }
});
