import { execFileSync } from "node:child_process";
import { z } from "zod";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbar } from "sandbar-sdk";
import { createBoxdAdapter } from "./adapter";
import { boxdFixture } from "./fixture.test-support";

const roots: string[] = [];

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function setup() {
  const fixture = await boxdFixture();
  fixture.localFilesystem();
  const root = mkdtempSync(join(tmpdir(), "boxd-files-"));
  roots.push(root);

  const client = await Sandbar.connect({
    adapter: createBoxdAdapter(fixture.factory),
    config: { org: "main", networkPolicy: "internet" },
    credentials: { apiKey: "fixture-main" },
  });

  const box = await client.sandboxes.create();

  return {
    fixture,
    root,
    box,
    async close() {
      await box.destroy();
      await client.close();
      fixture.close();
    },
  };
}

test("finite stdin uses bounded native byte frames followed by EOF, including empty input", async () => {
  const f = await setup();

  try {
    const input = new Uint8Array(131077).map((_, i) => i % 256);
    const before = f.fixture.calls.length;
    await f.box.exec({ command: { kind: "argv", argv: ["cat"] }, stdin: input });

    const frames = f.fixture.calls
      .slice(before)
      .filter((c) => c.method === "Exec")
      .map((c) =>
        z
          .object({ command: z.string(), stdin: z.boolean(), data: z.instanceof(Uint8Array) })
          .parse(c.request),
      );

    expect(frames[0]?.command).toBe("cat");
    expect(frames.slice(1).map((f) => f.data.length)).toEqual([65536, 65536, 5]);
    expect(frames.slice(1).every((f) => f.stdin && f.command === "")).toBe(true);
    expect(Buffer.concat(frames.slice(1).map((f) => f.data))).toEqual(Buffer.from(input));
    await f.box.exec({ command: { kind: "argv", argv: ["cat"] }, stdin: new Uint8Array() });
  } finally {
    await f.close();
  }
}, 60000);

test("guest filesystem preserves links, recursive opt-in, exact bytes and no-clobber copy/move", async () => {
  const f = await setup();

  try {
    const dir = join(f.root, "odd ' $(false)\n name");
    await f.box.makeDirectory(dir);
    await f.box.makeDirectory(dir);
    await f.box.makeDirectory(join(dir, "nested", "deep"), { recursive: true });
    const path = join(dir, "data");
    await f.box.writeFile(path, Uint8Array.of(0, 255, 128));
    expect(readFileSync(path)).toEqual(Buffer.from([0, 255, 128]));
    await expect(f.box.writeFile(path, Uint8Array.of(7))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    symlinkSync("missing", join(dir, "dangling"));
    expect(await f.box.fileExists(join(dir, "dangling"))).toBe(true);
    expect(await f.box.fileExists(join(dir, "missing"))).toBe(false);
    expect((await f.box.statFile(join(dir, "dangling"))).type).toBe("symlink");
    await expect(
      f.box.statFile(join(dir, "dangling"), { followSymlinks: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await f.box.statFile(path)).sizeBytes).toBe(3);
    await f.box.copyFile(path, join(dir, "copy"));
    await expect(f.box.copyFile(path, join(dir, "copy"))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await f.box.moveFile(join(dir, "copy"), join(dir, "moved"), { overwrite: true });
    await expect(f.box.moveFile(path, join(dir, "moved"))).rejects.toMatchObject({
      code: process.platform === "linux" ? "CONFLICT" : "UNSUPPORTED",
    });
    expect(readFileSync(path)).toEqual(Buffer.from([0, 255, 128]));
    await expect(f.box.removeFile(dir)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.box.removeFile(dir, { recursive: true });
    await f.box.removeFile(dir);
  } finally {
    await f.close();
  }
}, 60000);

test("incremental transfers preserve bytes above buffered bound and retain interrupted staging", async () => {
  const f = await setup();

  try {
    const path = join(f.root, "large");
    const chunk = new Uint8Array(65536).map((_, i) => i % 251);
    let produced = 0;

    async function* input() {
      for (let i = 0; i < 20; i++) {
        produced++;
        yield chunk;
      }
    }

    await f.box.writeFileStream(path, input());
    expect(produced).toBe(20);
    let read = 0;

    for await (const bytes of f.box.readFileStream(path)) {
      expect(bytes).toEqual(chunk);
      read += bytes.length;
    }

    expect(read).toBe(20 * chunk.length);
    const aborted = new AbortController();

    async function* interrupted() {
      yield chunk;
      aborted.abort();
      yield chunk;
    }

    await expect(
      f.box.writeFileStream(join(f.root, "interrupted"), interrupted(), { signal: aborted.signal }),
    ).rejects.toBeDefined();
    expect(await f.box.fileExists(join(f.root, "interrupted"))).toBe(false);
    expect(readdirSync(f.root).some((name) => name.startsWith(".sandbar-"))).toBe(true);
    const before = f.fixture.calls.length;
    await expect(f.box.statFile(path, { signal: AbortSignal.abort() })).rejects.toBeDefined();
    expect(f.fixture.calls).toHaveLength(before);
  } finally {
    await f.close();
  }
}, 60000);

test("failed publication retains staging and uncertain applied publication is never replayed", async () => {
  const f = await setup();

  try {
    const path = join(f.root, "destination");

    async function* chunks() {
      yield Uint8Array.of(0, 255, 128);
    }

    await f.box.writeFileStream(path, chunks());

    try {
      await f.box.writeFileStream(path, chunks());
      throw Error("Expected publication conflict");
    } catch (error) {
      const failure = z
        .object({
          code: z.literal("CONFLICT"),
          details: z.object({
            destination: z.literal(path),
            temporaryPaths: z.array(z.string()).length(1),
            bytesTransferred: z.literal(3),
          }),
        })
        .parse(error);

      expect(readFileSync(failure.details.temporaryPaths[0]!)).toEqual(Buffer.from([0, 255, 128]));
    }

    const link = join(f.root, "destination-link");
    symlinkSync(path, link);

    for (const collision of [link, f.root]) {
      await expect(f.box.writeFileStream(collision, chunks())).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(f.box.copyFile(path, collision)).rejects.toMatchObject({ code: "CONFLICT" });
    }

    expect(readFileSync(path)).toEqual(Buffer.from([0, 255, 128]));
    const target = join(f.root, "lost-publish");
    f.fixture.loseLocalHelperResponse("publish");
    const before = f.fixture.calls.length;
    await expect(f.box.writeFileStream(target, chunks())).rejects.toMatchObject({
      details: {
        effect: "possible",
        destination: target,
        bytesTransferred: 3,
        temporaryPaths: [expect.stringContaining(".sandbar-")],
      },
    });
    expect(readFileSync(target)).toEqual(Buffer.from([0, 255, 128]));
    const helpers = f.fixture.calls.slice(before).filter((call) => call.method === "LocalHelper");
    expect(helpers).toHaveLength(3); // One reserve, append and publish; no replay.
  } finally {
    await f.close();
  }
});

test("metadata helper uses the published exec codec with an exact argv path", async () => {
  const f = await setup();

  try {
    // Local helper runner is covered separately; use a fresh native-only client here.
    const fixture = await boxdFixture();

    const client = await Sandbar.connect({
      adapter: createBoxdAdapter(fixture.factory),
      config: { org: "main", networkPolicy: "internet" },
      credentials: { apiKey: "fixture-main" },
    });

    try {
      const box = await client.sandboxes.create();
      fixture.execFrames([
        {
          data: Buffer.from(
            JSON.stringify({
              ok: true,
              value: { type: "file", sizeBytes: 3, modifiedAt: 0, mode: 384 },
            }),
          ),
          exitCode: 0,
        },
      ]);
      expect(await box.statFile("/odd ' $(false) name")).toEqual({
        type: "file",
        sizeBytes: 3,
        modifiedAt: "1970-01-01T00:00:00.000Z",
        mode: 384,
      });

      const frame = z
        .object({ command: z.string() })
        .parse(fixture.calls.filter((call) => call.method === "Exec").at(-1)?.request);

      const quoted = "'" + "/odd ' $(false) name".replaceAll("'", "'\"'\"'") + "'";
      expect(frame.command.endsWith(` stat ${quoted} '' false ''`)).toBe(true);
      await box.destroy();
    } finally {
      await client.close();
      fixture.close();
    }
  } finally {
    await f.close();
  }
});

test("producer failures and byte-limit failure keep discoverable staging", async () => {
  const f = await setup();

  try {
    async function* failed() {
      yield Uint8Array.of(1, 2);
      throw Error("producer stopped");
    }

    await expect(f.box.writeFileStream(join(f.root, "failed"), failed())).rejects.toMatchObject({
      details: {
        destination: join(f.root, "failed"),
        bytesTransferred: 2,
        temporaryPaths: [expect.stringContaining(".sandbar-")],
      },
    });

    async function* oversized() {
      yield Uint8Array.of(1);
      yield Uint8Array.of(2);
    }

    await expect(
      f.box.writeFileStream(join(f.root, "oversized"), oversized(), { maxBytes: 1 }),
    ).rejects.toMatchObject({
      code: "OUTPUT_CAPACITY",
      details: {
        destination: join(f.root, "oversized"),
        bytesTransferred: 1,
        temporaryPaths: [expect.stringContaining(".sandbar-")],
      },
    });
    const fifo = join(f.root, "fifo");
    execFileSync("mkfifo", [fifo]);
    const read = f.box.readFileStream(fifo)[Symbol.asyncIterator]();
    await expect(read.next()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await f.box.fileExists(join(f.root, "failed"))).toBe(false);
    expect(await f.box.fileExists(join(f.root, "oversized"))).toBe(false);
  } finally {
    await f.close();
  }
});
