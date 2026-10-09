import { expect, test } from "bun:test";
import { z } from "zod";
import { AdapterError, defineAdapter, type AdapterSession } from "sandbar-adapter";
import { Sandbar, Image } from "./index";

/** Independently authored adapter stores chunk records, never a contiguous file buffer. */
async function fixture() {
  const files = new Map<string, Uint8Array[]>();

  const api: NonNullable<AdapterSession["files"]> = {
    maxBytes: 16_777_216,
    readDirectory: async () => ({
      entries: [...files.keys()].map((path) => ({ name: path.slice(1), type: "file" })),
      completeness: "complete",
      observedAt: new Date().toISOString(),
    }),
    stat: async ({ path }) => {
      const chunks = files.get(path);

      if (!chunks) throw new AdapterError("NOT_FOUND", "Missing file");

      return { type: "file", sizeBytes: chunks.reduce((n, chunk) => n + chunk.length, 0) };
    },
    readStream: async ({ path }) => {
      const chunks = files.get(path);

      if (!chunks) throw new AdapterError("NOT_FOUND", "Missing file");
      let offset = 0;

      return new ReadableStream(
        {
          pull(controller) {
            if (offset === chunks.length) controller.close();
            else controller.enqueue(chunks[offset++]!);
          },
        },
        { highWaterMark: 0 },
      );
    },
    writeStream: async ({ path, bytes, overwrite }) => {
      const chunks: Uint8Array[] = [];
      let count = 0;

      for await (const chunk of bytes) {
        expect(chunk.length).toBeLessThanOrEqual(65_536);
        chunks.push(chunk);
        count += chunk.length;
      }

      if (!overwrite && files.has(path)) throw new AdapterError("CONFLICT", "File exists");
      files.set(path, chunks);

      return { bytesWritten: count };
    },
    copy: async ({ source, destination, overwrite }) => {
      if (!overwrite && files.has(destination)) throw new AdapterError("CONFLICT", "File exists");
      const chunks = files.get(source);

      if (!chunks) throw new AdapterError("NOT_FOUND", "Missing file");
      files.set(
        destination,
        chunks.map((chunk) => chunk.slice()),
      );

      return { acknowledged: true };
    },
    move: async ({ source, destination, overwrite }) => {
      if (!overwrite && files.has(destination)) throw new AdapterError("CONFLICT", "File exists");
      const chunks = files.get(source);

      if (!chunks) throw new AdapterError("NOT_FOUND", "Missing file");
      files.set(destination, chunks);
      files.delete(source);

      return { acknowledged: true };
    },
  };

  const adapter = defineAdapter({
    name: "chunks",
    config: z.object({}),
    credentials: z.object({}),
    async connect() {
      return {
        scope: { authority: { kind: "fixture", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: async () => ({ id: "one", state: "running" as const }),
        destroy: async () => ({ computeStopped: true, retainedResources: [] }),
        files: api,
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const box = await client.sandboxes.create({ environment: Image.prepared("base") });

  return { client, box, files };
}

test("portable large artifact workflow preserves 32 MiB binary bytes with pull-based chunks and collisions", async () => {
  const f = await fixture();

  try {
    async function* input() {
      for (let i = 0; i < 512; i++) yield new Uint8Array(65_536).fill(i % 256);
    }

    expect(await f.box.writeFileStream("/input", input())).toBe(33_554_432);
    expect((await f.box.statFile("/input")).sizeBytes).toBe(33_554_432);
    await f.box.copyFile("/input", "/copy");
    await expect(f.box.copyFile("/input", "/copy")).rejects.toMatchObject({ code: "CONFLICT" });
    await f.box.moveFile("/copy", "/output");
    expect((await f.box.readDirectory("/")).entries.map((entry) => entry.name)).toEqual([
      "input",
      "output",
    ]);
    let count = 0;

    for await (const chunk of f.box.readFileStream("/output")) {
      expect(chunk.every((value) => value === count % 256)).toBe(true);
      count++;
    }

    expect(count).toBe(512);
    await expect(f.box.moveFile("/input", "/input")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  } finally {
    await f.client.close();
  }
});

test("stream limits and producer failure leave destination unpublished; consumer delays do not count as inactivity", async () => {
  const f = await fixture();

  try {
    async function* failure() {
      yield new Uint8Array(65_536);
      throw new Error("producer failed");
    }

    await expect(f.box.writeFileStream("/broken", failure())).rejects.toThrow("producer failed");
    expect(f.files.has("/broken")).toBe(false);

    async function* two() {
      yield Uint8Array.of(1);
      yield Uint8Array.of(2);
    }

    await expect(f.box.writeFileStream("/bounded", two(), { maxBytes: 1 })).rejects.toMatchObject({
      code: "OUTPUT_CAPACITY",
    });
    expect(f.files.has("/bounded")).toBe(false);
    await f.box.writeFileStream("/valid", two());

    for await (const chunk of f.box.readFileStream("/valid", { inactivityTimeoutMs: 5 })) {
      expect(chunk.length).toBe(1);
      await Bun.sleep(15);
    }

    const controller = new AbortController();
    controller.abort();
    await expect(
      f.box.writeFileStream("/aborted", two(), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "WAIT_ABORTED" });
    expect(f.files.has("/aborted")).toBe(false);

    const blocked = new AbortController();
    let started!: () => void;
    let release!: () => void;
    let returned = false;

    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });

    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });

    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            started();
            await wait;

            return { done: true as const, value: undefined };
          },
          async return() {
            returned = true;

            return { done: true as const, value: undefined };
          },
        };
      },
    };

    const pending = f.box.writeFileStream("/blocked", source, { signal: blocked.signal });
    await ready;
    blocked.abort();
    await expect(pending).rejects.toMatchObject({ code: "WAIT_ABORTED", effect: "possible" });
    expect(returned).toBe(true);
    expect(f.files.has("/blocked")).toBe(false);
    release();
  } finally {
    await f.client.close();
  }
});
