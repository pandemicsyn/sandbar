import { expect, test } from "bun:test";
import { z } from "zod";
import { AdapterError, defineAdapter, type AdapterSession, type FileEntry } from "sandbar-adapter";
import { Image, Sandbar, type AdapterRecoveryReference } from "./index";

async function directoryFixture(files: NonNullable<AdapterSession["files"]>) {
  const saved: AdapterRecoveryReference[] = [];

  const adapter = defineAdapter({
    name: "directory.fixture",
    config: z.object({}),
    credentials: z.object({}),
    async connect() {
      return {
        scope: { authority: { kind: "fixture", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: async () => ({ id: "one", state: "running" as const }),
        destroy: async () => ({ computeStopped: true, retainedResources: [] }),
        files,
      };
    },
  });

  const client = await Sandbar.connect({
    adapter,
    config: {},
    credentials: {},
    onReference: (ref) => {
      saved.push(ref);
    },
  });

  const box = await client.sandboxes.create({ environment: Image.prepared("base") });

  return { box, client, saved };
}

test("optional methods reject without effects; path and root validation precede dispatch", async () => {
  const f = await directoryFixture({ maxBytes: 1024 });

  try {
    for (const method of ["listFiles", "fileExists", "makeDirectory", "removeFile"] as const) {
      expect(f.box.supports(method)).toBe(false);
      await expect(f.box[method]("/path")).rejects.toMatchObject({
        code: "UNSUPPORTED",
        effect: "none",
      });

      for (const path of ["relative", "/a/../b", "/a/./b", "/a\0b"]) {
        await expect(f.box[method](path)).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
          effect: "none",
        });
      }
    }

    for (const path of ["/", "//", "////"]) {
      await expect(f.box.removeFile(path, { recursive: true })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        effect: "none",
      });
    }

    expect(f.saved).toHaveLength(1);
  } finally {
    await f.client.close();
  }
});

test("listing includes unknown/link entries and sorts code units; normalization is limited to new methods", async () => {
  const entries: FileEntry[] = [
    { name: "z", type: "unknown" },
    { name: "a", type: "symlink" },
    { name: "A", type: "directory" },
    { name: "ä", type: "file" },
  ];

  const f = await directoryFixture({
    maxBytes: 1024,
    list: async (input) => {
      expect(input.path).toBe("/job/results");

      return entries;
    },
  });

  try {
    const result = await f.box.listFiles("//job///results//");
    expect(result.map((entry) => entry.name)).toEqual(["A", "a", "z", "ä"]);
    result[0]!.name = "changed";
    expect(entries[2]!.name).toBe("A");
  } finally {
    await f.client.close();
  }
});

test("listing rejects invalid, duplicate and overflowing results instead of returning prefixes", async () => {
  let entries: FileEntry[] = [];
  const f = await directoryFixture({ maxBytes: 1024, list: async () => entries });

  try {
    const invalid: FileEntry[][] = [
      [{ name: ".", type: "file" }],
      [{ name: "..", type: "file" }],
      [{ name: "a/b", type: "file" }],
      [{ name: "a\0b", type: "file" }],
      [
        { name: "same", type: "file" },
        { name: "same", type: "directory" },
      ],
    ];

    for (const value of invalid) {
      entries = value;
      await expect(f.box.listFiles("/job")).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        effect: "none",
      });
    }

    entries = Array.from({ length: 1024 }, (_, i) => ({ name: `${i}`, type: "unknown" }));
    expect(await f.box.listFiles("/job")).toHaveLength(1024);
    entries.push({ name: "overflow", type: "file" });
    await expect(f.box.listFiles("/job")).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
    entries = Array.from({ length: 32 }, (_, i) => ({
      name: String(i).padStart(4, "0") + "é".repeat(1022),
      type: "file",
    }));
    expect(await f.box.listFiles("/job")).toHaveLength(32); // Exactly 65,536 encoded bytes.
    entries.push({ name: "x", type: "file" });
    await expect(f.box.listFiles("/job")).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  } finally {
    await f.client.close();
  }
});

test("exists returns explicit boolean only; native errors do not become false", async () => {
  const f = await directoryFixture({
    maxBytes: 1024,
    exists: async (input) => {
      if (input.path === "/missing") return false;

      if (input.path === "/link") return true;
      throw new AdapterError("FORBIDDEN", "fixture denied");
    },
  });

  try {
    expect(await f.box.fileExists("/missing")).toBe(false);
    expect(await f.box.fileExists("/link/")).toBe(true);
    await expect(f.box.fileExists("/denied")).rejects.toMatchObject({
      code: "FORBIDDEN",
      effect: "none",
    });
  } finally {
    await f.client.close();
  }
});

test("reads honor pre-abort and promptly stop ignored native signals on abort/close", async () => {
  for (const method of ["listFiles", "fileExists"] as const) {
    for (const stop of ["abort", "close"] as const) {
      let calls = 0;
      let entered = () => {};

      const dispatched = new Promise<void>((resolve) => {
        entered = resolve;
      });

      const pending = async () => {
        calls++;
        entered();

        return new Promise<never>(() => {});
      };

      const f = await directoryFixture({ maxBytes: 1024, list: pending, exists: pending });
      const pre = AbortSignal.abort();
      await expect(f.box[method]("/job", { signal: pre })).rejects.toMatchObject({
        code: "WAIT_ABORTED",
        effect: "none",
      });
      expect(calls).toBe(0);
      const controller = new AbortController();
      const read = f.box[method]("/job", { signal: controller.signal });
      await dispatched;

      if (stop === "close") await f.client.close();
      else controller.abort();
      await expect(read).rejects.toMatchObject({
        code: stop === "close" ? "CLIENT_CLOSED" : "WAIT_ABORTED",
        effect: "none",
      });
      await f.client.close();
    }
  }
});

test("mutations retain normalized path/explicit recursion; lost ACK never replays on recovery", async () => {
  const calls: { path: string; recursive: boolean }[] = [];

  const f = await directoryFixture({
    maxBytes: 1024,
    makeDirectory: async (input) => {
      calls.push(input);

      return { acknowledged: true };
    },
    remove: async (input) => {
      calls.push(input);
      throw Error("lost ack");
    },
  });

  try {
    await f.box.makeDirectory("//job///results//");
    expect(calls[0]).toMatchObject({ path: "/job/results", recursive: false });
    expect(f.saved.at(-1)).toMatchObject({
      kind: "file_mkdir",
      fileMutation: { path: "/job/results", recursive: false },
    });
    await expect(f.box.removeFile("/job/link/", { recursive: true })).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      effect: "possible",
    });
    const reference = f.saved.at(-1)!;
    expect(reference).toMatchObject({
      kind: "file_remove",
      fileMutation: { path: "/job/link", recursive: true },
    });
    const recovered = await f.client.recover(JSON.parse(JSON.stringify(reference)));
    await expect(recovered.observe()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(recovered.wait()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(calls).toHaveLength(2);
    const { fileMutation: ignored, ...missingIntent } = reference;
    void ignored;
    await expect(f.client.recover(missingIntent)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  } finally {
    await f.client.close();
  }
});

test("pre-aborted mutation and advanced root removal do not call adapter", async () => {
  let calls = 0;

  const f = await directoryFixture({
    maxBytes: 1024,
    remove: async () => {
      calls++;

      return { acknowledged: true };
    },
  });

  try {
    await expect(
      f.box.removeFile("/job", { signal: AbortSignal.abort(), recursive: true }),
    ).rejects.toMatchObject({ code: "WAIT_ABORTED", effect: "none" });
    await expect(
      f.client.operations.prepare("file_remove", {
        sandbox: { id: f.box.id },
        path: "///",
        recursive: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls).toBe(0);
  } finally {
    await f.client.close();
  }
});

test("native listing capacity maps to output capacity without changing other filesystem errors", async () => {
  const capacity = async (): Promise<never> => {
    throw new AdapterError("CAPACITY", "Native enumeration bound exceeded");
  };

  let malformed: string | undefined;

  const f = await directoryFixture({
    maxBytes: 1024,
    list: capacity,
    readDirectory: async () => (malformed === undefined ? capacity() : JSON.parse(malformed)),
    exists: capacity,
  });

  try {
    for (const method of ["listFiles", "readDirectory"] as const)
      await expect(f.box[method]("/job")).rejects.toMatchObject({
        code: "OUTPUT_CAPACITY",
        effect: "none",
      });
    await expect(f.box.fileExists("/job")).rejects.toMatchObject({ code: "CAPACITY" });

    for (const value of ["null", '{"entries":[],"completeness":"complete","observedAt":123}']) {
      malformed = value;
      await expect(f.box.readDirectory("/job")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }

    const options = JSON.parse('{"overwrite":"false","followSymlinks":"false"}');
    await expect(f.box.statFile("/job", options)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(f.box.copyFile("/source", "/destination", options)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(f.box.moveFile("/source", "/destination", options)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });

    async function* bytes() {
      yield Uint8Array.of(1);
    }

    await expect(f.box.writeFileStream("/destination", bytes(), options)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  } finally {
    await f.client.close();
  }
});
