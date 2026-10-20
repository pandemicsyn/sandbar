import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivePath, Extractor, readTar, tarStream, type TarEntry } from "../src/tar";
import { Excludes, localTree } from "../src/transfer";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sandbar-tar-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function* list(entries: TarEntry[]): AsyncIterable<TarEntry> {
  yield* entries;
}

function file(path: string, text: string, mode = 0o644): TarEntry {
  const bytes = new TextEncoder().encode(text);

  return {
    type: "file",
    path,
    mode,
    mtime: 1_700_000_000,
    size: bytes.length,
    async *body() {
      yield bytes;
    },
  };
}

async function archive(entries: TarEntry[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of tarStream(list(entries))) chunks.push(chunk);

  return new Uint8Array(Buffer.concat(chunks));
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  // Odd-sized chunks exercise the reader's buffering.
  for (let at = 0; at < bytes.length; at += 333) yield bytes.subarray(at, at + 333);
}

/** Extract an archive under `dest` the way `cp -r` does, with every path kept. */
async function extract(bytes: Uint8Array, dest: string, noClobber = false) {
  const extractor = new Extractor(dest, noClobber);
  await mkdir(dest, { recursive: true });
  await readTar(once(bytes), (entry, body) =>
    extractor.add(entry, archivePath(entry.path), body, archivePath),
  );

  return extractor.finish();
}

async function run(argv: string[], cwd: string) {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });

  return stdout;
}

describe("tar", () => {
  test("archives that system tar unpacks with modes, long paths and links", async () => {
    const deep = `${"nested-folder/".repeat(12)}file-with-a-long-name.txt`;

    const bytes = await archive([
      { type: "directory", path: "src", mode: 0o755, mtime: 1_700_000_000 },
      file("src/run.sh", "#!/bin/sh\necho hi\n", 0o755),
      file(deep, "deep\n"),
      { type: "symlink", path: "src/link", target: "run.sh", mtime: 1_700_000_000 },
    ]);

    const dest = await mkdtemp(join(root, "system-"));
    await writeFile(join(dest, "a.tar"), bytes);
    await mkdir(join(dest, "out"));
    await run(["tar", "-x", "-f", "../a.tar"], join(dest, "out"));

    expect(await readFile(join(dest, "out", "src", "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect((await stat(join(dest, "out", "src", "run.sh"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(dest, "out", deep), "utf8")).toBe("deep\n");
    expect(await readlink(join(dest, "out", "src", "link"))).toBe("run.sh");
  });

  test("reads what system tar writes, including hard links and long names", async () => {
    const source = await mkdtemp(join(root, "source-"));
    const deep = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(60)}.txt`;
    await mkdir(join(source, "tree", "d".repeat(60), "e".repeat(60)), { recursive: true });
    await writeFile(join(source, "tree", deep), "long\n");
    await writeFile(join(source, "tree", "a.txt"), "a\n", { mode: 0o600 });
    await run(["ln", join(source, "tree", "a.txt"), join(source, "tree", "b.txt")], source);
    await symlink("a.txt", join(source, "tree", "c"));
    await run(["tar", "-c", "-f", "t.tar", "tree"], source);

    const dest = join(source, "copy");
    const summary = await extract(new Uint8Array(await readFile(join(source, "t.tar"))), dest);

    expect(summary).toMatchObject({ files: 3, symlinks: 1 });
    expect(await readFile(join(dest, "tree", deep), "utf8")).toBe("long\n");
    expect(await readFile(join(dest, "tree", "b.txt"), "utf8")).toBe("a\n");
    expect((await stat(join(dest, "tree", "a.txt"))).mode & 0o777).toBe(0o600);
    expect(await readlink(join(dest, "tree", "c"))).toBe("a.txt");
  });

  test("refuses paths that leave the destination", async () => {
    for (const path of ["../escape", "a/../../escape", "/etc/escape"]) {
      const dest = await mkdtemp(join(root, "escape-"));

      await expect(extract(await archive([file(path, "x")]), dest)).rejects.toThrow("unsafe path");
    }
  });

  test("never writes through a link, from the archive or already on disk", async () => {
    const outside = await mkdtemp(join(root, "outside-"));
    const dest = await mkdtemp(join(root, "links-"));

    const bytes = await archive([
      { type: "symlink", path: "link", target: outside, mtime: 0 },
      file("link/owned", "x"),
    ]);

    await expect(extract(bytes, dest)).rejects.toThrow("Refusing to write through the link");
    expect(await Array.fromAsync(new Bun.Glob("*").scan(outside))).toEqual([]);

    // A link already at a file's own path is replaced, not followed.
    const target = join(outside, "victim");
    await writeFile(target, "safe");
    const again = await mkdtemp(join(root, "links-"));
    await symlink(target, join(again, "file"));
    await extract(await archive([file("file", "new")]), again);

    expect(await readFile(target, "utf8")).toBe("safe");
    expect((await lstat(join(again, "file"))).isFile()).toBe(true);
  });

  test("--no-clobber keeps existing files", async () => {
    const dest = await mkdtemp(join(root, "clobber-"));
    await writeFile(join(dest, "kept"), "old");

    await expect(extract(await archive([file("kept", "new")]), dest, true)).rejects.toThrow(
      "already exists",
    );
    expect(await readFile(join(dest, "kept"), "utf8")).toBe("old");
  });

  test("drops setuid bits and restores read-only directories after their contents", async () => {
    const dest = await mkdtemp(join(root, "modes-"));

    await extract(
      await archive([
        { type: "directory", path: "ro", mode: 0o555, mtime: 0 },
        file("ro/tool", "x", 0o4755),
      ]),
      dest,
    );

    expect((await stat(join(dest, "ro", "tool"))).mode & 0o7777).toBe(0o755);
    expect((await stat(join(dest, "ro"))).mode & 0o777).toBe(0o555);
  });
});

describe("local trees", () => {
  test("excludes match names anywhere, or paths from the root", () => {
    const excludes = new Excludes(["node_modules", "*.log", "dist/**", "/build"]);

    expect(excludes.matches(["node_modules"])).toBe(true);
    expect(excludes.matches(["pkg", "node_modules", "x.js"])).toBe(true);
    expect(excludes.matches(["logs", "today.log"])).toBe(true);
    expect(excludes.matches(["dist", "a", "b.js"])).toBe(true);
    expect(excludes.matches(["build"])).toBe(true);
    expect(excludes.matches(["src", "build"])).toBe(false);
    expect(excludes.matches(["src", "index.ts"])).toBe(false);
  });

  test("a git work tree sends tracked and unignored files only", async () => {
    const repo = await mkdtemp(join(root, "repo-"));
    await run(["git", "init", "-q"], repo);
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src", "main.ts"), "tracked");
    await writeFile(join(repo, "ignored.txt"), "no");
    await writeFile(join(repo, "untracked.md"), "yes");
    await writeFile(join(repo, "gone.txt"), "deleted later");
    await run(["git", "add", "src/main.ts", ".gitignore", "gone.txt"], repo);
    await rm(join(repo, "gone.txt"));
    const notes: string[] = [];

    const paths = (tree: Awaited<ReturnType<typeof localTree>>) =>
      tree.entries.map((entry) => entry.path);

    expect(
      paths(await localTree(repo, new Excludes([]), true, (text) => notes.push(text))),
    ).toEqual([".gitignore", "src", "src/main.ts", "untracked.md"]);
    expect(paths(await localTree(repo, new Excludes(["*.md"]), true, () => {}))).toEqual([
      ".gitignore",
      "src",
      "src/main.ts",
    ]);
    expect(notes).toEqual([]);

    const everything = paths(await localTree(repo, new Excludes([".git"]), false, () => {}));

    expect(everything).toEqual([".gitignore", "ignored.txt", "src", "src/main.ts", "untracked.md"]);
  });
});
