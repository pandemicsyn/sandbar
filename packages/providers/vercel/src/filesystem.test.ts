import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesystemHelper, filesystemValue, directorySchema, fileStat } from "./filesystem";

const invoke = (op: string, path: string, destination = "", flag = false, stage = "") => {
  const result = spawnSync(
    "node",
    ["-e", filesystemHelper, JSON.stringify({ op, path, destination, flag, stage })],
    { timeout: 35000, maxBuffer: 1048576 },
  );

  expect(result.status).toBe(0);

  return filesystemValue(result.stdout);
};

test("filesystem helper preserves entry names, dangling links, ordering and metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "vercel-fs-"));

  try {
    await writeFile(join(root, "z\n'quoted"), new Uint8Array([0, 255]));
    await mkdir(join(root, "a"));
    await symlink("missing", join(root, "link"));
    const list = directorySchema.parse(invoke("list", root));
    expect(list.entries).toEqual([
      { name: "a", type: "directory" },
      { name: "link", type: "symlink" },
      { name: "z\n'quoted", type: "file" },
    ]);
    expect(fileStat(invoke("stat", join(root, "link"))).type).toBe("symlink");
    expect(() => invoke("stat", join(root, "link"), "", true)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(() => invoke("remove", root)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    invoke("remove", join(root, "link"));
    invoke("remove", join(root, "link"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem staged copy/publish keeps original bytes on collision and same-filesystem moves", async () => {
  const root = await mkdtemp(join(tmpdir(), "vercel-fs-"));

  try {
    const source = join(root, "source"),
      destination = join(root, "destination"),
      stage = join(root, "stage");

    await writeFile(source, new Uint8Array([0, 255, 129]));
    await writeFile(destination, "original");
    expect(() => invoke("copy", source, destination, false, stage)).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(await readFile(destination, "utf8")).toBe("original");
    expect(await readFile(source)).toEqual(Buffer.from([0, 255, 129]));
    await expect(readFile(stage)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(stage, "another-owner");
    expect(() => invoke("copy", source, destination, true, stage)).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(await readFile(stage, "utf8")).toBe("another-owner");
    await rm(stage);
    invoke("copy", source, destination, true, stage);
    expect(await readFile(destination)).toEqual(Buffer.from([0, 255, 129]));
    const moved = join(root, "moved");
    invoke("move", destination, moved, true);
    expect(await readFile(moved)).toEqual(Buffer.from([0, 255, 129]));
    invoke("mkdir", join(root, "nested/child"), "", true);
    invoke("remove", join(root, "nested"), "", true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem directory overflow rejects a prefix instead of claiming completeness", async () => {
  const root = await mkdtemp(join(tmpdir(), "vercel-fs-"));

  try {
    await Promise.all(Array.from({ length: 1025 }, (_, i) => writeFile(join(root, String(i)), "")));
    expect(() => invoke("list", root)).toThrow(expect.objectContaining({ code: "CAPACITY" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
