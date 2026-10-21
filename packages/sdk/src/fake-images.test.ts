import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@sandbar/provider-fake";
import { startFakeProviderServer } from "@sandbar/provider-fake/server";
import { Image, OutcomeUnknownError, Sandbar, type RecoveryReference } from "./index";

const token = "fake-images-token-123456";

let directory: string;

let server: Awaited<ReturnType<typeof startFakeProviderServer>>;

let calls: Record<string, number>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sandbar-fake-images-"));
  server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "state.json"),
    token,
    testMode: true,
  });
  calls = {};
});

afterEach(async () => {
  await server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

// SAFETY: The test counts native actions and forwards every request to the real fake server.
const counting = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const action = JSON.parse(String(init?.body));
    calls[action.kind] = (calls[action.kind] ?? 0) + 1;

    return fetch(input, init);
  },
  { preconnect: fetch.preconnect },
) as typeof fetch;

async function connect(saved: RecoveryReference[] = []) {
  return Sandbar.connect({
    adapter: createFakeAdapter({
      url: `http://127.0.0.1:${server.port}`,
      token,
      fetch: counting,
      imageBuild: true,
    }),
    config: {},
    credentials: {},
    onReference: (reference) => void saved.push(reference),
  });
}

test("fake builds, lists, guards and deletes an owned image exactly once", async () => {
  const client = await connect();

  try {
    const built = await client.images.build({ source: Image.oci("node:24") });
    expect(built.reference).toMatchObject({
      kind: "image",
      provider: "fake",
      nativeId: "fake-image-1",
      ownership: "verified-created",
    });
    expect(built.retainedResources).toEqual([
      { kind: "fake-image", id: "fake-image-1", ownership: "verified", cleanup: "manual" },
    ]);

    const page = await client.images.list({ limit: 10 });
    expect(page.coverage).toBe("provider-scope");
    // Omitting the page selection uses the default page size.
    expect((await client.images.list()).items).toEqual(page.items);
    expect(
      page.items.map((item) => [
        item.reference.nativeId,
        item.reference.ownership,
        item.visibility,
      ]),
    ).toEqual([
      ["fake-starter", "borrowed", "public"],
      ["fake-image-1", "unknown", "private"],
    ]);

    const image = await client.images.get(built.reference);
    expect(await image.inspect()).toMatchObject({
      state: "ready",
      source: { kind: "oci", value: "node:24" },
    });

    const box = await client.sandboxes.create({ environment: Image.prepared(image.prepared) });

    await expect(image.delete()).rejects.toMatchObject({ code: "CONFLICT", effect: "none" });
    expect((await image.inspect()).state).toBe("ready");
    expect((await box.inspect()).state).toBe("running");

    await box.destroy();
    expect(await image.delete()).toEqual({ deleted: true, reference: built.reference });
    await expect(client.images.get(built.reference)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toMatchObject({ imageBuild: 1, imageDelete: 2 });

    expect((await client.capabilities()).imageManagement).toEqual({
      inspect: { status: "supported", value: {} },
      list: { status: "supported", value: { coverage: "provider-scope" } },
      delete: { status: "supported", value: {} },
    });
  } finally {
    await client.close();
  }
});

test("the borrowed starter image is never deleted and rejects before dispatch", async () => {
  const client = await connect();

  try {
    const starter = (await client.images.list({ limit: 1 })).items[0]!.reference;
    await expect(client.images.delete(starter)).rejects.toMatchObject({
      code: "CONFLICT",
      effect: "none",
    });
    expect(calls.imageDelete).toBeUndefined();
  } finally {
    await client.close();
  }
});

test("a lost build response is unknown, observed without replay and not verified", async () => {
  const saved: RecoveryReference[] = [];
  const client = await connect(saved);

  try {
    await expect(client.images.build({ source: Image.oci("lost/tool:1") })).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    const reference = saved.at(-1)!;
    expect(reference.kind).toBe("image_build");

    const recovered = await (await client.recover(reference)).wait();
    expect(recovered).toMatchObject({
      prepared: { value: "fake-image-1" },
      reference: { nativeId: "fake-image-1", ownership: "unknown" },
    });
    expect(calls.imageBuild).toBe(1);
  } finally {
    await client.close();
  }
});

test("a lost delete response is unknown and recovery confirms it without a second delete", async () => {
  const saved: RecoveryReference[] = [];
  const client = await connect(saved);

  try {
    const built = await client.images
      .build({ source: Image.oci("lost/tool:2") })
      .catch(async () => (await client.recover(saved.at(-1)!)).wait());

    if (!("reference" in built)) throw new Error("Expected a recovered image build");

    await expect(client.images.delete(built.reference)).rejects.toBeInstanceOf(OutcomeUnknownError);
    const reference = saved.at(-1)!;
    expect(reference).toMatchObject({ kind: "image_delete", resource: built.reference });

    expect(await (await client.recover(reference)).wait()).toEqual({
      deleted: true,
      reference: built.reference,
    });
    expect(calls.imageDelete).toBe(1);
  } finally {
    await client.close();
  }
});
