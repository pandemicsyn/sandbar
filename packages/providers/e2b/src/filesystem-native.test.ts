import { test, expect } from "bun:test";
import { mkdtemp, writeFile, symlink, readFile, rm, mkdir, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILESYSTEM_HELPER } from "./filesystem-native";

async function helper(op: string, path: string, destination = "", flag = false, stage = "") {
  const process = Bun.spawn(
    ["python3", "-c", FILESYSTEM_HELPER, op, path, destination, String(flag), stage],
    { stdout: "pipe", stderr: "pipe" },
  );

  const output = await new Response(process.stdout).json();
  expect(await process.exited).toBe(0);

  return output;
}

test("E2B guest helper preserves unusual names, dangling links and nonrecursive directory protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbar-e2b-fs-"));

  try {
    const name = "quote'\n雪";
    await writeFile(join(root, name), "bytes");
    await symlink("missing", join(root, "dangling"));
    await mkdir(join(root, "directory"));
    const fifo = Bun.spawn(["mkfifo", join(root, "pipe")], { stdout: "ignore", stderr: "pipe" });
    expect(await fifo.exited).toBe(0);
    await symlink("directory", join(root, "directory-link"));
    await writeFile(join(root, "directory", "child"), "retained");
    const listed = await helper("list", root);
    expect(listed.value.entries).toContainEqual({ name, type: "file" });
    expect(listed.value.entries).toContainEqual({ name: "dangling", type: "symlink" });
    expect(listed.value.entries).toContainEqual({ name: "pipe", type: "unknown" });
    expect((await helper("list", join(root, "directory-link"))).value.entries).toEqual([
      { name: "child", type: "file" },
    ]);
    expect(await helper("remove", join(root, "directory-link"))).toMatchObject({ ok: true });
    expect(await readFile(join(root, "directory", "child"), "utf8")).toBe("retained");
    expect((await helper("stat", join(root, "dangling"))).value.type).toBe("symlink");
    expect(await helper("stat", join(root, "dangling"), "", true)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await helper("remove", root)).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(await helper("mkdir", join(root, "directory"))).toMatchObject({ ok: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("E2B staged copy keeps destination and source on collision, refuses links, and copies 32 MiB incrementally", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbar-e2b-copy-"));

  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    const stage = join(root, ".stage");
    const content = new Uint8Array(32 * 1024 * 1024).fill(123);
    await writeFile(source, content);
    await writeFile(destination, "original");
    expect(await helper("copy", source, destination, false, stage)).toMatchObject({
      ok: false,
      code: "CONFLICT",
    });
    expect(await readFile(destination, "utf8")).toBe("original");
    expect(await helper("stat", stage)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    await symlink(source, join(root, "link"));
    expect(await helper("copy", join(root, "link"), destination, true, stage)).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENT",
    });
    expect(await helper("copy", source, destination, true, stage)).toMatchObject({ ok: true });
    expect(await readFile(destination)).toEqual(Buffer.from(content));
    expect((await helper("stat", source)).value.sizeBytes).toBe(content.length);
    expect(await helper("move", source, destination)).toMatchObject({
      ok: false,
      code: process.platform === "linux" ? "CONFLICT" : "UNSUPPORTED",
    });
    expect((await helper("stat", source)).ok).toBe(true);

    if (process.platform === "linux") {
      const oldDirectory = join(root, "old-directory");
      const newDirectory = join(root, "new-directory");
      await mkdir(oldDirectory);
      await writeFile(join(oldDirectory, "child"), "directory bytes");
      expect(await helper("move", oldDirectory, newDirectory)).toMatchObject({ ok: true });
      expect(await readFile(join(newDirectory, "child"), "utf8")).toBe("directory bytes");

      if ((await fsStat(root)).dev !== (await fsStat("/dev/shm")).dev) {
        const otherFilesystem = await mkdtemp("/dev/shm/sandbar-e2b-move-");

        try {
          expect(await helper("move", source, join(otherFilesystem, "moved"))).toMatchObject({
            ok: false,
            code: "UNSUPPORTED",
          });
          expect((await helper("stat", source)).ok).toBe(true);
        } finally {
          await rm(otherFilesystem, { recursive: true, force: true });
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
