import { expect, test } from "bun:test";
import { AdapterError, defineAdapter, type ReadContext } from "sandbar-adapter";
import { z } from "zod";
import { Image, Sandbar, type SandboxHandle } from "./index";

async function fixture(
  options: {
    maxBytes?: number;
    read?: (ctx: ReadContext) => Promise<Uint8Array | ReadableStream<Uint8Array>>;
    lostWrite?: boolean;
  } = {},
) {
  const files = new Map<string, Uint8Array>();
  const writes: { path: string; bytes: Uint8Array; overwrite: boolean }[] = [];
  let reads = 0;

  const adapter = defineAdapter({
    name: "example.text-files",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: {
          images: ["prepared"],
          network: ["blocked"],
          fileWrite: { noClobber: true, overwrite: true },
        },
        async create() {
          return { id: "box", state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
        files: {
          maxBytes: options.maxBytes ?? 1024,
          async read(input, ctx) {
            reads++;

            if (options.read) return options.read(ctx);
            const bytes = files.get(input.path);

            if (!bytes) throw new AdapterError("NOT_FOUND", "Missing file");

            return bytes;
          },
          async write(input, ctx) {
            writes.push(input);

            if (!input.overwrite && files.has(input.path))
              return ctx.reject("CONFLICT", "File exists");
            files.set(input.path, input.bytes);

            if (options.lostWrite) throw new Error("Acknowledgement lost");

            return { bytesWritten: input.bytes.length };
          },
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

  const box: SandboxHandle = await client.sandboxes.create({
    environment: Image.prepared("image"),
  });

  return { client, box, files, writes, reads: () => reads };
}

test("text roundtrips empty and multibyte content without changing newlines or byte APIs", async () => {
  const f = await fixture();

  try {
    for (const text of ["", "Ada 🌊 café\r\n終\n", "\uFEFFBOM"]) {
      await f.box.writeTextFile("/text", text, { overwrite: true });
      expect(await f.box.readFile("/text")).toEqual(new TextEncoder().encode(text));
      expect(await f.box.readTextFile("/text")).toBe(text.replace(/^\uFEFF/, ""));
    }

    await f.box.writeFile("/binary", Uint8Array.of(0, 255, 128));
    expect(await f.box.readFile("/binary")).toEqual(Uint8Array.of(0, 255, 128));
    expect(await f.box.readTextFile("/binary")).toBe("\0��");
  } finally {
    await f.client.close();
  }
});

test("complete streamed decoding handles split BOM, multibyte and malformed suffixes", async () => {
  const f = await fixture({
    read: async () =>
      new ReadableStream({
        start(c) {
          for (const bytes of [[239], [187, 191, 240, 159], [140, 138, 195], [40, 226, 130]])
            c.enqueue(Uint8Array.from(bytes));
          c.close();
        },
      }),
  });

  try {
    expect(await f.box.readTextFile("/text")).toBe("🌊�(�");
  } finally {
    await f.client.close();
  }
});

test("limits count encoded bytes and reject an oversized read without a prefix", async () => {
  const f = await fixture({ maxBytes: 4 });

  try {
    await f.box.writeTextFile("/exact", "🌊");
    expect(await f.box.readTextFile("/exact")).toBe("🌊");
    await expect(f.box.writeTextFile("/over", "🌊a")).rejects.toMatchObject({
      code: "CAPACITY",
      effect: "none",
    });
    expect(f.writes).toHaveLength(1);
    f.files.set("/over", new TextEncoder().encode("🌊a"));
    await expect(f.box.readTextFile("/over")).rejects.toMatchObject({
      code: "OUTPUT_CAPACITY",
      effect: "unknown",
    });
  } finally {
    await f.client.close();
  }
});

test("no-clobber, explicit overwrite, paths and native errors follow the byte methods", async () => {
  const f = await fixture();

  try {
    await f.box.writeTextFile("/text", "original");
    expect(f.writes[0]?.overwrite).toBe(false);
    await expect(f.box.writeTextFile("/text", "replacement")).rejects.toMatchObject({
      code: "CONFLICT",
      effect: "none",
    });
    expect(await f.box.readTextFile("/text")).toBe("original");
    await f.box.writeTextFile("/text", "replacement", { overwrite: true });
    expect(await f.box.readTextFile("/text")).toBe("replacement");
    await expect(f.box.readTextFile("/missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
      effect: "none",
    });
    const calls = [f.reads(), f.writes.length];
    await expect(f.box.readTextFile("relative")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(f.box.writeTextFile("relative", "text")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect([f.reads(), f.writes.length]).toEqual(calls);
    // @ts-expect-error JavaScript callers cannot pass non-text data.
    await expect(f.box.writeTextFile("/text", 42)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  } finally {
    await f.client.close();
  }
});

test("pre-aborted text IO makes no native call", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();

  try {
    await expect(f.box.readTextFile("/text", { signal: controller.signal })).rejects.toMatchObject({
      code: "WAIT_ABORTED",
      effect: "none",
    });
    await expect(
      f.box.writeTextFile("/text", "text", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "WAIT_ABORTED", effect: "none" });
    expect(f.reads()).toBe(0);
    expect(f.writes).toHaveLength(0);
  } finally {
    await f.client.close();
  }
});

test("abort during text read releases the byte reader", async () => {
  let entered!: () => void;

  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });

  let cancelled = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull() {
      entered();

      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled++;
    },
  });

  const f = await fixture({ read: async () => stream });
  const controller = new AbortController();

  try {
    const result = f.box.readTextFile("/text", { signal: controller.signal });
    const error = result.catch((reason: Error) => reason);
    await reading;
    controller.abort();
    expect(await error).toMatchObject({ code: "WAIT_ABORTED", effect: "none" });
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
  } finally {
    await f.client.close();
  }
});

test("lost text-write acknowledgement remains uncertain and is never retried", async () => {
  const f = await fixture({ lostWrite: true });

  try {
    await expect(f.box.writeTextFile("/text", "🌊")).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      effect: "possible",
      reference: { kind: "file_write", file: { path: "/text", bytes: 4 } },
    });
    expect(f.writes).toHaveLength(1);
  } finally {
    await f.client.close();
  }
});
