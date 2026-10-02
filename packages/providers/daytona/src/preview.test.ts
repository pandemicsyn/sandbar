import { expect, test } from "bun:test";
import { Image, Sandbar, type AdapterRecoveryReference } from "sandbar-sdk";
import { createDaytonaAdapter } from "./adapter";

function fixture() {
  let creates = 0;
  let status = 200;
  let unavailable = false;
  let token = "private-preview-token";
  let previewUrl = "https://3000-native-reopen.proxy.daytona.work";
  let previewStatus = 200;
  let previewId = "native-reopen";

  type CreationLabels = Record<string, string>;

  const labels: CreationLabels = {};

  const native = {
    id: "native-reopen",
    name: "",
    organizationId: "org-1",
    target: "us",
    state: "started",
    labels,
    networkBlockAll: true,
    public: false,
    autoDestroyAt: "2026-10-01T01:00:00Z",
    autoStopInterval: 5,
    autoDeleteInterval: -1,
  };

  const calls: string[] = [];

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);

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
        creates++;
        Object.assign(native, JSON.parse(String(init?.body)));

        return Response.json(native);
      }

      if (url.pathname === "/api/sandbox" && method === "GET")
        return Response.json({ items: [native] });

      if (url.pathname.endsWith("/preview-url")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer first-key" });

        return Response.json(
          { sandboxId: previewId, url: previewUrl, token },
          { status: previewStatus },
        );
      }

      if (url.pathname === "/api/sandbox/native-reopen") {
        if (unavailable) throw new TypeError("offline transport fault");

        return Response.json(native, { status });
      }

      throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
    },
    { preconnect() {} },
  );

  const adapter = createDaytonaAdapter(fetcher);

  return {
    native,
    preview(tokenValue: string, urlValue = previewUrl, statusValue = 200, idValue = previewId) {
      token = tokenValue;
      previewUrl = urlValue;
      previewStatus = statusValue;
      previewId = idValue;
    },
    calls,
    creates: () => creates,
    connect: (key = "first-key", onReference?: (ref: AdapterRecoveryReference) => void) =>
      Sandbar.connect({
        adapter,
        config: { target: "us", ttlMinutes: 15 },
        credentials: { apiKey: key },
        onReference,
      }),
    status(value: number) {
      status = value;
    },
    unavailable() {
      unavailable = true;
    },
  };
}

async function create(f: ReturnType<typeof fixture>) {
  const client = await f.connect();
  const box = await client.sandboxes.create({ environment: Image.prepared("prepared") });

  return { client, box };
}

test("Daytona protected preview verifies private running identity, gets fresh header access and never starts compute", async () => {
  const f = fixture();
  const { client, box } = await create(f);

  try {
    const reference = JSON.stringify(box.reference);
    f.calls.length = 0;
    expect(await box.preview(3000)).toEqual({
      access: "protected",
      url: "https://3000-native-reopen.proxy.daytona.work",
      headers: { "x-daytona-preview-token": "private-preview-token" },
    });
    f.preview("fresh-token");
    expect((await box.preview(3000)).access).toBe("protected");
    expect(f.calls.every((call) => call.startsWith("GET "))).toBe(true);
    expect(JSON.stringify(box.reference)).toBe(reference);
    expect(reference).not.toContain("token");
    f.native.state = "stopped";
    const count = f.calls.filter((call) => call.endsWith("preview-url")).length;
    await expect(box.preview(3000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.calls.filter((call) => call.endsWith("preview-url")).length).toBe(count);
    f.native.state = "started";
    f.native.public = true;
    await expect(box.preview(3000)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.calls.filter((call) => call.endsWith("preview-url")).length).toBe(count);
  } finally {
    await client.close();
  }
});

test("Daytona malformed credential URLs, lost token and expired sandbox errors contain no credentials", async () => {
  const f = fixture();
  const { client, box } = await create(f);

  try {
    for (const url of [
      "https://secret@proxy.daytona.work",
      "https://proxy.daytona.work?token=secret",
      "http://proxy.daytona.work",
    ]) {
      f.preview("secret-token", url);

      await expect(box.preview(3000)).rejects.toMatchObject({
        code: "UNAVAILABLE",
        message: "Daytona preview access response is unavailable",
      });
    }

    f.preview("", "https://proxy.daytona.work");
    await expect(box.preview(3000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    f.preview("valid-token", "https://proxy.daytona.work", 200, "other-sandbox");
    await expect(box.preview(3000)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Daytona preview response identity differs",
    });
    f.status(404);
    await expect(box.preview(3000)).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    await client.close();
  }
});

test("Daytona public setup rejects before native requests", async () => {
  let calls = 0;

  const fetcher: typeof fetch = Object.assign(
    async () => {
      calls++;

      return new Response();
    },
    { preconnect() {} },
  );

  await expect(
    Sandbar.connect({
      adapter: createDaytonaAdapter(fetcher),
      config: { target: "us", preview: { access: "public" } },
      credentials: { apiKey: "key" },
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(calls).toBe(0);
});
