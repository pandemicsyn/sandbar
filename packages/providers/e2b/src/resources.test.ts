import { expect, test } from "bun:test";
import { Image, Sandbar } from "sandbar-sdk";
import { createE2BAdapter } from "./index";
import type { E2BRecord, E2BTemplateSize, E2BTransport } from "./transport";

test("E2B resources size built templates and gate prepared ones before any effect", async () => {
  const builds: (E2BTemplateSize | undefined)[] = [];
  const created: string[] = [];
  const records = new Map<string, E2BRecord>();
  const built = new Map<string, { templateId: string; buildId: string; status: string }>();

  const sizes = new Map([
    ["small", { cpuCount: 1, memoryMB: 1024 }],
    ["big", { cpuCount: 2, memoryMB: 4096 }],
  ]);

  const transport: E2BTransport = {
    async verifyAuth() {},
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      return id;
    },
    async templateSize(_team, id) {
      return sizes.get(id) ?? null;
    },
    async buildImage(_reference, name, size) {
      builds.push(size);
      const templateId = `built-${builds.length}`;
      sizes.set(templateId, { cpuCount: size?.cpuCount ?? 2, memoryMB: size?.memoryMB ?? 512 });
      built.set(name, { templateId, buildId: `${name}-build`, status: "ready" });

      return { templateId, buildId: `${name}-build` };
    },
    async findBuild(_team, name) {
      return built.get(name) ?? null;
    },
    async create(input) {
      const id = `sandbox_${records.size + 1}`;
      created.push(input.templateId);
      records.set(id, {
        id,
        templateId: input.templateId,
        metadata: input.metadata,
        state: "running",
        allowPublicTraffic: input.allowPublicTraffic,
        ...sizes.get(input.templateId),
      });

      return id;
    },
    async get(id) {
      return records.get(id) ?? null;
    },
    async list() {
      return { items: [...records.values()] };
    },
    async kill() {
      return true;
    },
    async run() {
      return "";
    },
    async read() {
      return { bytes: new Uint8Array(), truncated: false };
    },
    async write() {},
    async remove() {},
    close() {},
  };

  const client = await Sandbar.connect({
    adapter: createE2BAdapter(() => transport),
    config: { resources: { vcpus: 1.5, memoryMiB: 3001 } },
    credentials: { apiKey: "private-key" },
  });

  try {
    for (const environment of [undefined, Image.prepared("small"), Image.prepared("unlisted")])
      await expect(client.sandboxes.create({ environment })).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
    expect(created).toEqual([]);

    const big = await client.sandboxes.create({ environment: Image.prepared("big") });
    expect((await big.inspect()).resources).toEqual({
      status: "known",
      value: { vcpus: 2, memoryMiB: 4096 },
    });

    await client.sandboxes.create({ environment: Image.oci("python:3.12") });
    expect(builds).toEqual([{ cpuCount: 2, memoryMB: 3002 }]);
  } finally {
    await client.close();
  }
});
