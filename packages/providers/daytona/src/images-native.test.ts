import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter, ResourceReference, type Scope } from "@sandbar-sdk/adapter";
import { Sandbar } from "sandbar-sdk";
import { daytonaState } from "./state-native";

const scope: Scope = {
  authority: { kind: "organization", id: "org-one" },
  partition: { region: "us" },
};

type NativeImage = {
  id: string;
  name: string;
  organizationId: string;
  general: boolean;
  state: string;
  sourceSandboxId: string | null;
  sandboxClass: string;
  regionIds: string[];
  createdAt: string;
  imageName: string;
};

const built = (id: string, overrides: Partial<NativeImage> = {}): NativeImage => ({
  id,
  name: `sandbar-image-${id}`,
  organizationId: "org-one",
  general: false,
  state: "active",
  sourceSandboxId: null,
  sandboxClass: "container",
  regionIds: ["us"],
  createdAt: "2026-10-01T12:00:00.000Z",
  imageName: "node:24",
  ...overrides,
});

function fixture(
  images: NativeImage[],
  options: {
    warmPools?:
      | readonly { id: string; organizationId: string; snapshot: string }[]
      | "missing"
      | "error";
    deletion?: "ok" | "lost-after-effect" | "lost-before-effect";
  } = {},
) {
  const store = new Map(images.map((image) => [image.id, image]));
  const calls = { get: 0, list: 0, delete: 0, warmPools: 0 };

  // SAFETY: The fixture implements only the Daytona routes these hooks read or mutate.
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname === "/api/warm-pools") {
        calls.warmPools++;

        if (options.warmPools === "missing") return new Response(null, { status: 404 });

        if (options.warmPools === "error") return new Response(null, { status: 500 });

        return Response.json(options.warmPools ?? []);
      }

      if (url.pathname === "/api/snapshots" && method === "GET") {
        calls.list++;
        const page = Number(url.searchParams.get("page"));
        const limit = Number(url.searchParams.get("limit"));
        const all = [...store.values()];

        return Response.json({
          items: all.slice((page - 1) * limit, page * limit),
          page,
          totalPages: Math.max(1, Math.ceil(all.length / limit)),
        });
      }

      const match = /^\/api\/snapshots\/([^/]+)$/.exec(url.pathname);

      if (match && method === "GET") {
        calls.get++;
        const found = store.get(decodeURIComponent(match[1]!));

        return found ? Response.json(found) : new Response(null, { status: 404 });
      }

      if (match && method === "DELETE") {
        calls.delete++;

        if (options.deletion === "lost-before-effect") throw new Error("lost before effect");
        store.delete(decodeURIComponent(match[1]!));

        if (options.deletion === "lost-after-effect") throw new Error("lost after effect");

        return new Response(null, { status: 200 });
      }

      throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;

  const adapter = defineAdapter({
    name: "daytona",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      const state = daytonaState({
        scope,
        apiUrl: "https://fixture.invalid/api",
        apiKey: "fixture",
        target: "us",
        fetch: fetcher,
      });

      return {
        ...state.fields,
        scope,
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          throw Error("This fixture never allocates compute");
        },
        async destroy() {
          throw Error("This fixture never destroys compute");
        },
      };
    },
  });

  return {
    calls,
    store,
    connect: () => Sandbar.connect({ adapter, config: {}, credentials: {} }),
  };
}

const ref = (nativeId: string, ownership: ResourceReference["ownership"] = "unknown") =>
  ResourceReference.parse({
    version: 1,
    kind: "image",
    provider: "daytona",
    scope,
    nativeId,
    ownership,
  });

test("Daytona images inspect and list native snapshots as prepared images", async () => {
  const f = fixture([
    built("img-1"),
    built("img-2", { general: true, organizationId: "daytona", imageName: "ubuntu:24.04" }),
    built("img-3", { state: "pulling" }),
  ]);

  const client = await f.connect();

  try {
    const image = await client.images.get(ref("img-1", "verified-created"));
    expect(await image.inspect()).toEqual({
      reference: ref("img-1", "verified-created"),
      state: "ready",
      createdAt: "2026-10-01T12:00:00.000Z",
      source: { kind: "oci", value: "node:24" },
      visibility: "private",
      nativeDependencies: [],
    });

    const first = await client.images.list({ limit: 2 });
    expect(
      first.items.map((item) => [item.reference.nativeId, item.visibility, item.state]),
    ).toEqual([
      ["img-1", "private", "ready"],
      ["img-2", "public", "ready"],
    ]);
    expect(first).toMatchObject({ nextCursor: "2", coverage: "provider-scope" });
    const second = await client.images.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.state)).toEqual(["creating"]);
    expect(second.nextCursor).toBeUndefined();
    expect(second.items.every((item) => item.reference.ownership === "unknown")).toBe(true);

    expect((await client.capabilities()).imageManagement).toEqual({
      inspect: { status: "supported", value: {} },
      list: { status: "supported", value: { coverage: "provider-scope" } },
      delete: { status: "supported", value: {} },
    });
  } finally {
    await client.close();
  }
});

test("Daytona image delete sends one native DELETE for a private OCI build", async () => {
  const f = fixture([built("img-1")]);
  const client = await f.connect();

  try {
    expect(await client.images.delete(ref("img-1"))).toEqual({
      deleted: true,
      reference: ref("img-1"),
    });
    expect(f.calls.delete).toBe(1);
    await expect(client.images.get(ref("img-1"))).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    await client.close();
  }
});

test.each([
  ["public image", built("img-1", { general: true })],
  ["captured sandbox snapshot", built("img-1", { sourceSandboxId: "box-1" })],
] as const)("Daytona never deletes a %s through images", async (_name, image) => {
  const f = fixture([image]);
  const client = await f.connect();

  try {
    await expect(client.images.delete(ref("img-1"))).rejects.toMatchObject({
      code: "CONFLICT",
      effect: "none",
    });
    expect(f.calls.delete).toBe(0);
    expect(f.store.has("img-1")).toBe(true);
  } finally {
    await client.close();
  }
});

test.each([
  ["a warm pool uses it", [{ id: "pool-1", organizationId: "org-one", snapshot: "img-1" }]],
  ["dependencies are unreadable", "error"],
] as const)("Daytona image delete is refused when %s", async (_name, warmPools) => {
  const f = fixture([built("img-1")], { warmPools });
  const client = await f.connect();

  try {
    await expect(client.images.delete(ref("img-1"))).rejects.toMatchObject({
      code: "CONFLICT",
      effect: "none",
    });
    expect(f.calls.delete).toBe(0);
  } finally {
    await client.close();
  }
});

test("a lost Daytona delete response is confirmed by absence without a second DELETE", async () => {
  const f = fixture([built("img-1")], { warmPools: "missing", deletion: "lost-after-effect" });
  const client = await f.connect();

  try {
    expect(await client.images.delete(ref("img-1"))).toMatchObject({ deleted: true });
    expect(f.calls.delete).toBe(1);
  } finally {
    await client.close();
  }
});

test("an unconfirmed Daytona delete never reports success or replays the DELETE", async () => {
  const f = fixture([built("img-1")], { deletion: "lost-before-effect" });
  const client = await f.connect();

  try {
    const operation = await client.images.submitDelete(ref("img-1"));
    expect(await operation.observe()).toBeNull();
    expect(await (await client.recover(operation.reference)).observe()).toBeNull();
    expect(f.calls.delete).toBe(1);
    expect(f.store.has("img-1")).toBe(true);
  } finally {
    await client.close();
  }
});

test("foreign or mismatched image references fail before native reads", async () => {
  const f = fixture([built("img-1"), built("img-2")]);
  const client = await f.connect();

  try {
    const foreign = {
      ...ref("img-1"),
      scope: { ...scope, authority: { kind: "organization", id: "other" } },
    };

    await expect(client.images.delete(foreign)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.calls).toMatchObject({ get: 0, delete: 0 });

    f.store.set("img-1", built("img-2"));
    await expect(client.images.get(ref("img-1"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.calls.delete).toBe(0);
  } finally {
    await client.close();
  }
});
