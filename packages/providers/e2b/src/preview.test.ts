import { expect, test, spyOn } from "bun:test";
import { Sandbox } from "e2b";
import { Sandbar, Image } from "sandbar-sdk";
import { createE2BAdapter } from "./index";
import { createSdkTransport, type E2BTransport, type E2BRecord } from "./transport";

async function fixture(access: "protected" | "public" = "protected") {
  let lookups = 0;
  const creates: boolean[] = [];

  const record: E2BRecord = {
    id: "box",
    templateId: "base",
    metadata: {},
    state: "running",
    domain: "e2b.app",
    lifecycle: { autoResume: false },
    allowPublicTraffic: access === "public",
    attachmentReady: false,
  };

  const transport: E2BTransport = {
    verifyAuth: async () => {},
    verifyTeam: async () => {},
    verifyTemplate: async () => "base",
    buildImage: async () => {
      throw Error("unexpected build");
    },
    findBuild: async () => null,
    create: async (input) => {
      creates.push(input.allowPublicTraffic!);
      record.metadata = input.metadata;

      return "box";
    },
    get: async () => {
      lookups++;

      return record;
    },
    list: async () => ({ items: [] }),
    kill: async () => {
      throw Error("unexpected kill");
    },
    run: async () => {
      throw Error("unexpected exec");
    },
    read: async () => {
      throw Error("unexpected file IO");
    },
    write: async () => {},
    remove: async () => {},
    close() {},
  };

  const client = await Sandbar.connect({
    adapter: createE2BAdapter(() => transport),
    config: { preview: { access } },
    credentials: { apiKey: "key" },
  });

  const box = await client.sandboxes.create({ environment: Image.prepared("base") });

  return { client, box, record, creates, lookups: () => lookups };
}

test("E2B protected default creates private compute and refuses credential retrieval without connecting", async () => {
  const f = await fixture();

  try {
    expect(f.creates).toEqual([false]);
    const lookups = f.lookups();
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(f.lookups()).toBe(lookups);
  } finally {
    await f.client.close();
  }
});

test("E2B public is explicit, verifies current visibility and auto-resume, and needs no guest attachment", async () => {
  const f = await fixture("public");

  try {
    expect(f.creates).toEqual([true]);
    const ref = JSON.stringify(f.box.reference);
    expect(await f.box.preview(3000)).toEqual({
      access: "public",
      url: "https://3000-box.e2b.app",
    });
    expect(JSON.stringify(f.box.reference)).toBe(ref);
    f.record.allowPublicTraffic = false;
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    f.record.allowPublicTraffic = true;
    f.record.lifecycle = { autoResume: true };
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    f.record.lifecycle = { autoResume: false };
    f.record.state = "paused";
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    f.record.state = "running";
    f.record.metadata.sandbar_operation = "foreign";
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    await f.client.close();
  }
});

test("E2B pinned create receives inbound choice independently of blocked outbound policy", async () => {
  // SAFETY: This boundary consumes only sandboxId from the pinned creation response.
  const mock = spyOn(Sandbox, "create").mockResolvedValue({ sandboxId: "box" } as Sandbox);

  try {
    const transport = createSdkTransport("key");
    await transport.create({
      templateId: "base",
      metadata: {},
      timeoutMs: 300000,
      allowInternetAccess: false,
    });
    await transport.create({
      templateId: "base",
      metadata: {},
      timeoutMs: 300000,
      allowInternetAccess: false,
      allowPublicTraffic: true,
    });
    expect(mock.mock.calls.map((call) => call[1])).toMatchObject([
      {
        network: { allowPublicTraffic: false },
        allowInternetAccess: false,
        lifecycle: { autoResume: false },
        retries: 0,
      },
      { network: { allowPublicTraffic: true }, allowInternetAccess: false },
    ]);
  } finally {
    mock.mockRestore();
  }
});

test("E2B detail reads expose observed visibility without traffic credentials or lifecycle mutation", async () => {
  const calls: string[] = [];

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);

      return Response.json({
        sandboxID: "box",
        templateID: "base",
        metadata: {},
        state: "running",
        domain: "e2b.app",
        network: { allowPublicTraffic: true },
        lifecycle: { autoResume: false },
        trafficAccessToken: "private-token",
      });
    },
    { preconnect() {} },
  );

  const transport = createSdkTransport("key", fetcher);
  const record = await transport.get("box");
  expect(record).toMatchObject({
    id: "box",
    domain: "e2b.app",
    allowPublicTraffic: true,
    lifecycle: { autoResume: false },
  });
  expect(JSON.stringify(record)).not.toContain("private-token");
  expect(calls).toEqual(["GET /sandboxes/box"]);
});
