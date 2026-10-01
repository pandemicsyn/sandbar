import { expect, test } from "bun:test";
import { Image, Sandbar, type AdapterRecoveryReference } from "sandbar-sdk";
import { createDaytonaAdapter } from "./adapter";

function fixture() {
  let creates = 0;
  let status = 200;
  let unavailable = false;

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

test("Daytona scoped reference reopens after credential rotation, observes states/deadlines, and never mutates", async () => {
  const f = fixture();
  const first = await f.connect();

  const creation = await first.sandboxes.submitCreate({
    environment: Image.prepared("prepared"),
    networkPolicy: "blocked",
  });

  const box = await creation.wait();
  expect(box.reference).not.toBeNull();
  const saved = JSON.parse(JSON.stringify(box.reference));
  expect(saved.history).toBeUndefined();
  await first.close();
  const fresh = await f.connect("rotated-key");
  const mutations = () => f.calls.filter((call) => !call.startsWith("GET "));

  try {
    const opened = await fresh.sandboxes.get(saved);
    const recovered = await fresh.recover(creation.reference);

    if (recovered.kind !== "create") throw new Error("Wrong operation kind");
    expect((await recovered.wait()).reference).toEqual(saved);
    expect(await opened.inspect()).toMatchObject({
      state: "running",
      expires: { status: "known", at: f.native.autoDestroyAt, scope: "sandbox" },
      idleStop: { status: "known", value: { seconds: 300, action: "stop" } },
      retention: { status: "known", value: { autoDeleteAfterStoppedSeconds: null } },
    });

    for (const [nativeState, state] of [
      ["stopped", "stopped"],
      ["archived", "suspended"],
      ["resuming", "restoring"],
      ["future", "unknown"],
    ] as const) {
      f.native.state = nativeState!;
      expect((await (await fresh.sandboxes.get(saved)).inspect()).state).toBe(state);
    }

    f.native.autoDestroyAt = "invalid";
    expect((await opened.inspect()).expires.status).toBe("unknown");
    f.native.networkBlockAll = false;
    await expect(fresh.sandboxes.get(saved)).rejects.toMatchObject({ code: "CONFLICT" });
    f.native.networkBlockAll = true;
    f.native.labels["sandbar.operation"] = "different";
    await expect(fresh.sandboxes.get(saved)).rejects.toMatchObject({ code: "CONFLICT" });
    f.native.labels["sandbar.operation"] = JSON.parse(saved.receipt).operation;
    f.native.state = "destroyed";
    expect((await opened.inspect()).state).toBe("destroyed");
    await expect(fresh.sandboxes.get(saved)).rejects.toMatchObject({ code: "NOT_FOUND" });

    for (const [status, code] of [
      [404, "NOT_FOUND"],
      [403, "FORBIDDEN"],
      [500, "UNAVAILABLE"],
    ] as const) {
      f.status(status);
      await expect(fresh.sandboxes.get(saved)).rejects.toMatchObject({ code });
    }

    f.status(200);
    f.unavailable();
    await expect(fresh.sandboxes.get(saved)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.creates()).toBe(1);
    expect(mutations()).toEqual(["POST /api/sandbox"]);
  } finally {
    await fresh.close();
  }
});

test("Daytona confirmed creation preserves the handle when optional reference verification fails", async () => {
  const f = fixture();
  f.status(403);
  const client = await f.connect();

  try {
    const box = await client.sandboxes.create({
      environment: Image.prepared("prepared"),
      networkPolicy: "blocked",
    });

    expect(box.id).toBe("native-reopen");
    expect(box.reference).toBeNull();
    expect(f.creates()).toBe(1);
  } finally {
    await client.close();
  }
});

test("Daytona reopened operations reject changed creation markers before dispatch", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const created = await client.sandboxes.create({
      environment: Image.prepared("prepared"),
      networkPolicy: "blocked",
    });

    const box = await client.sandboxes.get(created.reference!);
    f.native.labels["sandbar.operation"] = "changed";
    const before = f.calls.length;

    for (const operation of [
      () => box.exec(["true"]),
      () => box.readFile("/tmp/value"),
      () => box.writeFile("/tmp/value", new Uint8Array([1])),
      () => box.capabilities(),
      () => box.snapshot(),
      () => box.destroy(),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.calls.slice(before).every((call) => call.startsWith("GET "))).toBe(true);
  } finally {
    await client.close();
  }
});

test("Daytona destroy checks markers after its custody checkpoint", async () => {
  const f = fixture();

  const client = await f.connect("fixture", (ref) => {
    if (ref.kind === "destroy" && ref.token !== undefined)
      f.native.labels["sandbar.operation"] = "changed";
  });

  try {
    const created = await client.sandboxes.create({
      environment: Image.prepared("prepared"),
      networkPolicy: "blocked",
    });

    const box = await client.sandboxes.get(created.reference!);
    const before = f.calls.length;
    await expect(box.destroy()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(f.calls.slice(before).every((call) => call.startsWith("GET "))).toBe(true);
  } finally {
    await client.close();
  }
});

test("Daytona destroy recovery rejects a mismatched tombstone but accepts true absence", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const created = await client.sandboxes.create({
      environment: Image.prepared("prepared"),
      networkPolicy: "blocked",
    });

    const box = await client.sandboxes.get(created.reference!);
    const operation = await box.submitDestroy();
    const reference = operation.reference;
    expect(reference).toBeDefined();
    f.native.state = "destroyed";
    f.native.labels["sandbar.submission"] = "changed";
    const recovered = await client.recover(reference);
    await expect(recovered.wait()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    f.status(404);
    const missing = await client.recover(reference);
    await expect(missing.wait()).resolves.toMatchObject({ computeStopped: true });
  } finally {
    await client.close();
  }
});
