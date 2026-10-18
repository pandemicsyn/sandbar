import { expect, test } from "bun:test";
import { Image, OutcomeUnknownError, Sandbar, type AdapterRecoveryReference } from "sandbar-sdk";
import { createE2BAdapter } from "./index";
import {
  createSdkTransport,
  E2BTemplateDeleteRejected,
  type E2BRecord,
  type E2BTemplateState,
  type E2BTransport,
} from "./transport";

type Template = E2BTemplateState & { aliases?: string[] };

type FixtureModes = {
  deletion: "ok" | "lost-after-effect" | "lost-before-effect" | "forbidden";
  pagedTemplates: boolean;
};

function fixture() {
  const templates = new Map<string, Template>();
  const boxes = new Map<string, E2BRecord>();
  const snapshots: { snapshotId: string; names: string[] }[] = [];
  const calls = { build: 0, template: 0, templates: 0, deleteTemplate: 0 };

  const modes: FixtureModes = { deletion: "ok", pagedTemplates: false };

  const transport: E2BTransport = {
    async verifyAuth() {},
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      if (!templates.has(id) && id !== "base") throw new Error("template outside team");

      return id;
    },
    async buildImage(_reference, name) {
      calls.build++;
      templates.set("built_template", {
        templateId: "built_template",
        names: [name],
        public: false,
        builds: [{ buildId: "build_one", status: "ready" }],
      });

      return { templateId: "built_template", buildId: "build_one" };
    },
    async findBuild(_team, name) {
      const found = [...templates.values()].find((value) => value.names.includes(name));

      return found
        ? { templateId: found.templateId, buildId: found.builds[0]!.buildId, status: "ready" }
        : null;
    },
    async create(input) {
      const id = `box_${boxes.size + 1}`;
      boxes.set(id, {
        id,
        templateId: input.templateId,
        metadata: input.metadata,
        state: "running",
        allowPublicTraffic: input.allowPublicTraffic,
      });

      return id;
    },
    async get(id) {
      return boxes.get(id) ?? null;
    },
    async list(metadata, limit) {
      return {
        items: [...boxes.values()]
          .filter((box) =>
            Object.entries(metadata).every(([key, value]) => box.metadata[key] === value),
          )
          .slice(0, limit),
      };
    },
    async kill(id) {
      return boxes.delete(id);
    },
    async run() {
      throw new Error("No process fixture");
    },
    async read() {
      throw new Error("No filesystem fixture");
    },
    async write() {},
    async remove() {},
    close() {},
    state: {
      async template(id) {
        calls.template++;
        const value = templates.get(id);

        return value
          ? {
              templateId: value.templateId,
              names: value.names,
              public: value.public,
              builds: value.builds,
            }
          : null;
      },
      async templates(input) {
        calls.templates++;
        const all = [...templates.values()];
        const start = Number(input.cursor ?? 0);
        const limit = modes.pagedTemplates ? 1 : input.limit;
        const page = all.slice(start, start + limit);

        return {
          items: page.map((value) => ({
            templateId: value.templateId,
            // Like the native listing: the latest ready build, or the nil UUID when none is ready.
            buildId:
              [...value.builds].reverse().find((build) => build.status === "ready")?.buildId ??
              "00000000-0000-0000-0000-000000000000",
            buildStatus: value.builds[value.builds.length - 1]?.status ?? "error",
            names: [...value.names, ...(value.aliases ?? [])],
          })),
          nextCursor: start + limit < all.length ? String(start + limit) : undefined,
        };
      },
      async deleteTemplate(id) {
        calls.deleteTemplate++;

        if (modes.deletion === "forbidden") throw new E2BTemplateDeleteRejected(403);

        if (modes.deletion === "lost-before-effect") throw new Error("lost before effect");
        const existed = templates.delete(id);

        if (modes.deletion === "lost-after-effect") throw new Error("lost after effect");

        return existed;
      },
      async verifyAddress() {},
      async tags() {
        return [];
      },
      async capture() {
        throw new Error("No capture fixture");
      },
      async snapshots(input) {
        return { items: snapshots.slice(0, input.limit) };
      },
      async deleteSnapshot() {
        throw new Error("Image deletion must never delete a snapshot");
      },
      async createVolume() {
        throw new Error("No volume fixture");
      },
      async volume() {
        throw new Error("No volume fixture");
      },
      async volumes() {
        return [];
      },
      async deleteVolume() {
        throw new Error("No volume fixture");
      },
    },
  };

  const saved: AdapterRecoveryReference[] = [];

  const connect = () =>
    Sandbar.connect({
      adapter: createE2BAdapter(() => transport),
      config: { teamId: "team_one" },
      credentials: { apiKey: "fixture-key" },
      onReference: (reference) => void saved.push(reference),
    });

  return { templates, boxes, snapshots, calls, modes, saved, connect };
}

test("E2B builds a template image and deletes it with one native DELETE", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const built = await client.images.build({ source: Image.oci("node:24") });
    expect(built.reference).toMatchObject({
      nativeId: "built_template",
      generation: "build_one",
      ownership: "verified-created",
    });

    const image = await client.images.get(built.reference);
    expect(await image.inspect()).toEqual({
      reference: built.reference,
      state: "ready",
      createdAt: null,
      source: null,
      visibility: "private",
      nativeDependencies: [],
    });

    const page = await client.images.list({ limit: 10 });
    expect(page.items.map((item) => item.reference)).toEqual([
      { ...built.reference, ownership: "unknown" },
    ]);
    expect(page.coverage).toBe("provider-scope");

    expect(await image.delete()).toEqual({ deleted: true, reference: built.reference });
    expect(f.calls).toMatchObject({ build: 1, deleteTemplate: 1 });
    await expect(image.inspect()).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    await client.close();
  }
});

test("a template with no ready build lists without a build generation and still inspects", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const built = await client.images.build({ source: { kind: "oci", value: "node:22" } });
    f.templates.get("built_template")!.builds = [{ buildId: "build_pending", status: "building" }];

    const page = await client.images.list({ limit: 10 });
    expect(page.items).toMatchObject([{ state: "creating" }]);
    expect(page.items[0]!.reference.generation).toBeUndefined();
    expect(page.items[0]!.reference.nativeId).toBe(built.reference.nativeId);

    const listed = await client.images.get(page.items[0]!.reference);
    expect(await listed.inspect()).toMatchObject({ state: "creating" });
  } finally {
    await client.close();
  }
});

test.each([
  [
    "a public template",
    (f: ReturnType<typeof fixture>) => {
      f.templates.get("built_template")!.public = true;
    },
  ],
  [
    "a multi-build template",
    (f: ReturnType<typeof fixture>) => {
      f.templates.get("built_template")!.builds.push({ buildId: "build_two", status: "ready" });
    },
  ],
  [
    "a template shadowed by another alias",
    (f: ReturnType<typeof fixture>) => {
      f.modes.pagedTemplates = true;
      f.templates.set("other", {
        templateId: "other",
        names: [],
        aliases: ["team/built_template"],
        public: false,
        builds: [{ buildId: "other_build", status: "ready" }],
      });
    },
  ],
  [
    "a captured sandbox snapshot",
    (f: ReturnType<typeof fixture>) => {
      f.snapshots.push({ snapshotId: "built_template:default", names: [] });
    },
  ],
  [
    "a template a sandbox still uses",
    (f: ReturnType<typeof fixture>) => {
      f.boxes.set("box_9", {
        id: "box_9",
        templateId: "built_template",
        metadata: {},
        state: "running",
      });
    },
  ],
] as const)("E2B refuses to delete %s before dispatch", async (_name, arrange) => {
  const f = fixture();
  const client = await f.connect();

  try {
    const built = await client.images.build({ source: Image.oci("node:24") });
    arrange(f);
    await expect(client.images.delete(built.reference)).rejects.toMatchObject({
      code: "CONFLICT",
      effect: "none",
    });
    expect(f.calls.deleteTemplate).toBe(0);
    expect(f.templates.has("built_template")).toBe(true);
  } finally {
    await client.close();
  }
});

test("a native refusal is a no-effect rejection", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const built = await client.images.build({ source: Image.oci("node:24") });
    f.modes.deletion = "forbidden";
    await expect(client.images.delete(built.reference)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      effect: "none",
    });
    expect(f.calls.deleteTemplate).toBe(1);
  } finally {
    await client.close();
  }
});

test("a lost E2B DELETE response is unknown and never replayed", async () => {
  for (const deletion of ["lost-after-effect", "lost-before-effect"] as const) {
    const f = fixture();
    const client = await f.connect();

    try {
      const built = await client.images.build({ source: Image.oci("node:24") });
      f.modes.deletion = deletion;
      await expect(client.images.delete(built.reference)).rejects.toBeInstanceOf(
        OutcomeUnknownError,
      );
      const reference = f.saved.at(-1)!;
      expect(reference).toMatchObject({ kind: "image_delete", resource: built.reference });

      const recovered = await (await client.recover(reference)).observe();

      if (deletion === "lost-after-effect")
        expect(recovered).toEqual({ deleted: true, reference: built.reference });
      else expect(recovered).toBeNull();

      expect(f.calls.deleteTemplate).toBe(1);
    } finally {
      await client.close();
    }
  }
});

test("the native template DELETE is one request with no retry", async () => {
  const requests: { method: string; url: string }[] = [];

  // SAFETY: The fixture returns only the statuses the transport classifies.
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ method: init?.method ?? "GET", url: String(input) });

      return new Response(null, { status: requests.length === 1 ? 503 : 204 });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;

  const state = createSdkTransport("fixture-key", fetcher).state!;
  await expect(state.deleteTemplate!("built_template")).rejects.toThrow("unavailable (503)");
  expect(requests).toEqual([
    { method: "DELETE", url: "https://api.e2b.app/templates/built_template" },
  ]);
  expect(await state.deleteTemplate!("built_template")).toBe(true);
  expect(requests).toHaveLength(2);
});
