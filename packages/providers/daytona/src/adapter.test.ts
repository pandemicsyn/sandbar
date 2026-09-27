import { expect, test } from "bun:test";
import { adapterSuite } from "@sandbar/adapter/testing";
import { createDaytonaAdapter } from "./adapter";

test("Daytona public adapter passes managed-compute scenarios with one native POST", async () => {
  const effects = { create: 0, destroy: 0, release: 0 };
  const records = new Map<string, { id: string; name: string; organizationId: string; target: string;
    state: string; networkBlockAll: boolean; public: boolean; labels: Record<string, string> }>();
  let lose = false;
  let hold = false;
  let resume: (() => void) | undefined;
  const fetchImpl = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });
    if (path === "/api/regions") return Response.json([
      { id: "us", name: "US", regionType: "shared", organizationId: "org-1" },
      { id: "eu", name: "EU", regionType: "shared", organizationId: "org-1" },
    ]);
    if (path === "/api/organizations/org-1")
      return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });
    if (path === "/api/snapshots/snap-1")
      return Response.json({ id: "snap-1", organizationId: "org-1", state: "active",
        regionIds: ["us", "eu"], sandboxClass: "linux-vm" });
    if (path === "/api/sandbox" && init?.method === "POST") {
      effects.create++;
      const body = JSON.parse(String(init.body));
      const record = { id: `native-${effects.create}`, name: body.name, organizationId: "org-1",
        target: body.target, state: "started", networkBlockAll: true, public: false,
        labels: body.labels };
      records.set(record.id, record);
      if (lose) { lose = false; throw new Error("response lost after native effect"); }
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => { resume = resolve; });
      }
      return Response.json(record);
    }
    if (path === "/api/sandbox" && init?.method === "GET") {
      const items = [...records.values()].filter((record) =>
        !url.searchParams.has("name") || record.name === url.searchParams.get("name"));
      return Response.json({ items: items.map(({ networkBlockAll: _block, public: _public, ...item }) => item) });
    }
    const match = /^\/api\/sandbox\/(native-[0-9]+)$/.exec(path);
    if (match) {
      const record = records.get(match[1]!);
      if (!record) return new Response(null, { status: 404 });
      if (init?.method === "DELETE") {
        effects.destroy++;
        record.state = "destroyed";
      }
      return Response.json(record);
    }
    throw new Error(`Unexpected Daytona fixture route ${path}`);
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  const adapter = createDaytonaAdapter(fetchImpl);
  const report = await adapterSuite({
    adapter,
    fixture: {
      config: { target: "us" }, credentials: { apiKey: "fixture" },
      alternate: { config: { target: "eu" }, credentials: { apiKey: "fixture" } },
      createInput: { image: { kind: "prepared", value: "snap-1" }, networkPolicy: "blocked" },
      counters: () => ({ ...effects }), expectedReleasesPerConnection: 0,
      loseNextCreateResponse() { lose = true; },
      holdNextCreateResponse() { hold = true; },
      releaseHeldCreateResponse() {
        if (!resume) throw new Error("Native create was not held");
        resume();
      },
      assertNativeRetriesDisabled() {
        // The injected fetch is called directly by DaytonaDriver.request with no retry middleware.
        expect(effects.create).toBe(0);
      },
    },
  });
  expect(report.counters).toEqual({ create: 3, destroy: 1, release: 0 });
});
