import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAndLoad } from "./build";

test("failed provider compilation rejects qualification instead of loading an existing stale SDK bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbar-build-provenance-"));
  const bundle = join(root, "sdk.js");
  await writeFile(bundle, "stale provider behavior");
  let loads = 0;

  try {
    await expect(
      buildAndLoad(
        root,
        async () => {
          loads++;

          return readFile(bundle, "utf8");
        },
        () => {
          throw new Error("provider compile failed");
        },
      ),
    ).rejects.toThrow("provider compile failed");
    expect(loads).toBe(0);
    expect(await readFile(bundle, "utf8")).toBe("stale provider behavior");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
