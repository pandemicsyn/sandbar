import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@sandbar/provider-fake";
import { startFakeProviderServer } from "@sandbar/provider-fake/server";
import { Image, Sandbar } from "./index";

test("fake snapshots capture sandbox files, restore them fresh and delete once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-fake-snapshots-"));
  const token = "long-fake-snapshot-token";

  const server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "state.json"),
    token,
    testMode: true,
  });

  const client = await Sandbar.connect({
    adapter: createFakeAdapter({ url: `http://127.0.0.1:${server.port}`, token, snapshots: true }),
    config: {},
    credentials: {},
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
    await box.writeFile("/work/state.txt", new TextEncoder().encode("warm"));

    const { snapshot } = await box.snapshot();
    expect(snapshot.reference.ownership).toBe("verified-created");
    expect((await client.snapshots.list()).items.map((info) => info.reference.nativeId)).toEqual([
      snapshot.id,
    ]);
    // Snapshots are not images.
    expect((await client.images.list()).items.map((info) => info.reference.nativeId)).toEqual([
      "fake-starter",
    ]);

    const restored = await snapshot.restore();
    expect(restored.id).not.toBe(box.id);
    expect(new TextDecoder().decode(await restored.readFile("/work/state.txt"))).toBe("warm");

    await restored.destroy();
    await box.destroy();
    await snapshot.delete();
    await expect(client.snapshots.get(snapshot.reference)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  } finally {
    await client.close();
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
