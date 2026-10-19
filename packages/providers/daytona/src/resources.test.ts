import { expect, test } from "bun:test";
import { z } from "zod";
import { Image, Sandbar } from "sandbar-sdk";
import { createDaytonaAdapter } from "./adapter";

const SnapshotBuild = z.object({ name: z.string(), cpu: z.number(), memory: z.number() });

const SandboxCreate = z.object({
  name: z.string(),
  snapshot: z.string(),
  labels: z.record(z.string(), z.string()),
});

type Size = { cpu?: number; mem?: number };

test("Daytona resources size built snapshots and gate prepared ones before any effect", async () => {
  const builds: z.infer<typeof SnapshotBuild>[] = [];
  const creates: z.infer<typeof SandboxCreate>[] = [];

  const snapshots = new Map<string, Size & { name: string }>([
    ["small", { name: "small", cpu: 1, mem: 1 }],
    ["big", { name: "big", cpu: 2, mem: 4 }],
    ["unsized", { name: "unsized" }],
  ]);

  const sandboxes = new Map<string, z.infer<typeof SandboxCreate> & { id: string } & Size>();

  const snapshot = (id: string) => ({
    id,
    imageName: "alpine:3.21",
    organizationId: "org-1",
    state: "active",
    regionIds: ["us"],
    sandboxClass: "container",
    ...snapshots.get(id),
  });

  const sandbox = (box: z.infer<typeof SandboxCreate> & { id: string } & Size) => ({
    id: box.id,
    name: box.name,
    organizationId: "org-1",
    target: "us",
    state: "started",
    networkBlockAll: true,
    public: false,
    snapshot: box.snapshot,
    labels: box.labels,
    cpu: box.cpu,
    memory: box.mem,
  });

  const fetchImpl: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (url.pathname === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (url.pathname === "/api/snapshots" && method === "POST") {
        const build = SnapshotBuild.parse(JSON.parse(String(init?.body)));
        builds.push(build);
        snapshots.set("built", { name: build.name, cpu: build.cpu, mem: build.memory });

        return Response.json(snapshot("built"));
      }

      if (url.pathname.startsWith("/api/snapshots/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/snapshots/".length));

        return snapshots.has(id)
          ? Response.json(snapshot(id))
          : new Response(null, { status: 404 });
      }

      if (url.pathname === "/api/sandbox" && method === "POST") {
        const request = SandboxCreate.parse(JSON.parse(String(init?.body)));
        creates.push(request);

        const size = snapshots.get(request.snapshot);
        const box = { ...request, id: `native-${creates.length}`, cpu: size?.cpu, mem: size?.mem };

        sandboxes.set(box.id, box);

        return Response.json(sandbox(box));
      }

      if (url.pathname.startsWith("/api/sandbox/") && method === "GET") {
        const box = sandboxes.get(url.pathname.slice("/api/sandbox/".length));

        return box ? Response.json(sandbox(box)) : new Response(null, { status: 404 });
      }

      throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );

  const client = await Sandbar.connect({
    adapter: createDaytonaAdapter(fetchImpl),
    config: { target: "us", network: "blocked", resources: { vcpus: 1.5, memoryMiB: 3000 } },
    credentials: { apiKey: "fixture" },
  });

  try {
    await client.images.build({ source: Image.oci("alpine:3.21") });
    expect(builds).toMatchObject([{ cpu: 2, memory: 3 }]);

    for (const id of ["small", "unsized"])
      await expect(
        client.sandboxes.create({ environment: Image.prepared(id) }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });

    expect(creates).toEqual([]);

    const box = await client.sandboxes.create({ environment: Image.prepared("big") });

    expect((await box.inspect()).resources).toEqual({
      status: "known",
      value: { vcpus: 2, memoryMiB: 4096 },
    });
  } finally {
    await client.close();
  }
});
