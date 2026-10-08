import { expect, test } from "bun:test";
import { z } from "zod";
import {
  AdapterError,
  defineAdapter,
  type AdapterSession,
  type DirectoryResult,
} from "sandbar-adapter";
import { Image, Sandbar } from "./index";

async function fixture(files: NonNullable<AdapterSession["files"]>) {
  const adapter = defineAdapter({
    name: "extensions",
    config: z.object({}),
    credentials: z.object({}),
    async connect() {
      return {
        scope: { authority: { kind: "fixture", id: "extensions" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: async () => ({ id: "one", state: "running" as const }),
        files,
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const box = await client.sandboxes.create({ environment: Image.prepared("base") });

  return { client, box };
}

function listing(
  entries: DirectoryResult["entries"],
  completeness: DirectoryResult["completeness"] = "complete",
): DirectoryResult {
  return { entries, completeness, observedAt: "2026-10-08T00:00:00Z" };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];

  for await (const value of source) result.push(value);

  return result;
}

test("walk has deterministic depth-first paths, intentional depth and subtree exclusions without link descent", async () => {
  const calls: string[] = [];

  const directories = new Map([
    [
      "/root",
      listing([
        { name: "z", type: "unknown" },
        { name: "b", type: "symlink" },
        { name: "a", type: "directory" },
      ]),
    ],
    [
      "/root/a",
      listing([
        { name: "deep", type: "directory" },
        { name: "file", type: "file" },
      ]),
    ],
    ["/root/a/deep", listing([{ name: "leaf", type: "file" }])],
  ]);

  const f = await fixture({
    readDirectory: async ({ path }) => {
      calls.push(path);

      return directories.get(path)!;
    },
  });

  try {
    expect(f.box.supports("walkFiles")).toBe(true);
    expect(f.box.supports("readTextLines")).toBe(false);
    const entries = await collect(f.box.walkFiles("/root//"));
    expect(entries.map(({ relativePath }) => relativePath)).toEqual([
      "a",
      "a/deep",
      "a/deep/leaf",
      "a/file",
      "b",
      "z",
    ]);
    expect(entries[2]).toMatchObject({ path: "/root/a/deep/leaf", depth: 3 });
    expect(calls).toEqual(["/root", "/root/a", "/root/a/deep"]);
    calls.length = 0;
    expect(
      (await collect(f.box.walkFiles("/root", { maxDepth: 1 }))).map(({ name }) => name),
    ).toEqual(["a", "b", "z"]);
    expect(calls).toEqual(["/root"]);
    calls.length = 0;
    expect(
      (await collect(f.box.walkFiles("/root", { exclude: ["a/deep"] }))).map(
        ({ relativePath }) => relativePath,
      ),
    ).toEqual(["a", "a/file", "b", "z"]);
    expect(calls).toEqual(["/root", "/root/a"]);
    await expect(
      collect(f.box.walkFiles("/root", { maxEntries: 2, exclude: ["a"] })),
    ).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
    expect(() => f.box.walkFiles("/root", { exclude: ["../escape"] })).toThrow();
  } finally {
    await f.client.close();
  }
});

test("walk rejects incomplete or unreadable subtrees and cancellation stops further dispatch", async () => {
  let calls = 0;
  let incomplete = true;

  const f = await fixture({
    readDirectory: async ({ path }) => {
      calls++;

      if (path === "/") return listing([{ name: "sub", type: "directory" }]);

      if (incomplete) return listing([], "unknown");
      throw new AdapterError("PERMISSION_DENIED", "Subtree denied");
    },
  });

  try {
    await expect(collect(f.box.walkFiles("/"))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    incomplete = false;
    await expect(collect(f.box.walkFiles("/"))).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    const controller = new AbortController();
    const iterator = f.box.walkFiles("/", { signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    const before = calls;
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "WAIT_ABORTED" });
    expect(calls).toBe(before);
    const early = f.box.walkFiles("/")[Symbol.asyncIterator]();
    await early.next();
    const beforeReturn = calls;
    await early.return?.();
    expect(calls).toBe(beforeReturn);
    const closing = f.box.walkFiles("/")[Symbol.asyncIterator]();
    await closing.next();
    await f.client.close();
    await expect(closing.next()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(calls).toBe(beforeReturn + 1);
  } finally {
    await f.client.close();
  }
});

test("text lines decode split UTF-8, BOM, CRLF, empty and unterminated lines and malformed boundaries", async () => {
  let payload = new TextEncoder().encode("\uFEFF🙂\r\n\nlast\r");

  const f = await fixture({
    readStream: async () => {
      let offset = 0;

      return new ReadableStream(
        {
          pull(controller) {
            if (offset === payload.length) controller.close();
            else controller.enqueue(payload.subarray(offset, ++offset));
          },
        },
        { highWaterMark: 0 },
      );
    },
  });

  try {
    expect(await collect(f.box.readTextLines("/log"))).toEqual(["🙂", "", "last\r"]);
    payload = Uint8Array.of(0xc2, 10, 0xa9, 10);
    expect(await collect(f.box.readTextLines("/log"))).toEqual(["�", "�"]);
    payload = new Uint8Array();
    expect(await collect(f.box.readTextLines("/log"))).toEqual([]);
    payload = new TextEncoder().encode("\n");
    expect(await collect(f.box.readTextLines("/log", { maxLineBytes: 0 }))).toEqual([""]);
  } finally {
    await f.client.close();
  }
});

test("line byte limits include multibyte content but exclude CRLF, and release streams on failures and early return", async () => {
  let payload = new TextEncoder().encode("é\r\n");
  let cancelled = 0;

  const f = await fixture({
    readStream: async () => {
      let offset = 0;

      return new ReadableStream(
        {
          pull(controller) {
            if (offset === payload.length) controller.close();
            else controller.enqueue(payload.subarray(offset, ++offset));
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      );
    },
  });

  try {
    expect(await collect(f.box.readTextLines("/log", { maxLineBytes: 2 }))).toEqual(["é"]);
    payload = new TextEncoder().encode("é\nunused");
    await expect(collect(f.box.readTextLines("/log", { maxLineBytes: 1 }))).rejects.toMatchObject({
      code: "OUTPUT_CAPACITY",
    });
    expect(cancelled).toBe(1);
    payload = new TextEncoder().encode("a\nb\n");
    const iterator = f.box.readTextLines("/log")[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("a");
    await iterator.return?.();
    expect(cancelled).toBe(2);
    payload = new TextEncoder().encode("a\r");
    await expect(collect(f.box.readTextLines("/log", { maxLineBytes: 1 }))).rejects.toMatchObject({
      code: "OUTPUT_CAPACITY",
    });
    payload = new TextEncoder().encode("a\nb\n");
    const closing = f.box.readTextLines("/log")[Symbol.asyncIterator]();
    await closing.next();
    await f.client.close();
    await expect(closing.next()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  } finally {
    await f.client.close();
  }
});

test("text line cancellation interrupts a blocked read and cancels its reader", async () => {
  let started!: () => void;

  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });

  let cancelled = false;

  const f = await fixture({
    readStream: async () =>
      new ReadableStream(
        {
          pull() {
            started();

            return new Promise<void>(() => {});
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
  });

  try {
    const controller = new AbortController();

    const iterator = f.box
      .readTextLines("/log", { signal: controller.signal })
      [Symbol.asyncIterator]();

    const pending = iterator.next();
    await ready;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "WAIT_ABORTED" });
    expect(cancelled).toBe(true);
  } finally {
    await f.client.close();
  }
});
