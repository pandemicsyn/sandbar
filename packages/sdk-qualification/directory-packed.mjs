import assert from "node:assert/strict";
import { Sandbar, Image } from "sandbar-sdk";
import { defineAdapter } from "sandbar-adapter";
import { z } from "zod";
import { artifactFiles, directoryFiles, listChildren } from "./directory-files.js";

const bytes = new Map();

const mutations = [];

const adapter = defineAdapter({
  name: "packed.directories",
  config: z.object({}),
  credentials: z.object({}),
  async connect() {
    return {
      scope: { authority: { kind: "fixture", id: "one" }, partition: {} },
      supports: {
        images: ["prepared"],
        network: ["blocked"],
        fileWrite: { noClobber: true, overwrite: true },
      },
      create: async () => ({ id: "one", state: "running" }),
      destroy: async () => ({ computeStopped: true, retainedResources: [] }),
      files: {
        maxBytes: 1024,
        read: async (input) => bytes.get(input.path),
        write: async (input) => {
          bytes.set(input.path, input.bytes);

          return { bytesWritten: input.bytes.length };
        },
        exists: async (input) => bytes.has(input.path),
        readDirectory: async (input) => {
          const children = new Map();

          for (const path of bytes.keys()) {
            if (!path.startsWith(`${input.path}/`)) continue;
            const relative = path.slice(input.path.length + 1);
            const slash = relative.indexOf("/");
            children.set(
              slash < 0 ? relative : relative.slice(0, slash),
              slash < 0 ? "file" : "directory",
            );
          }

          return {
            entries: Array.from(children, ([name, type]) => ({ name, type })),
            completeness: "complete",
            observedAt: new Date().toISOString(),
          };
        },
        stat: async (input) => ({ type: "file", sizeBytes: bytes.get(input.path).length }),
        copy: async (input) => {
          bytes.set(input.destination, bytes.get(input.source).slice());

          return { acknowledged: true };
        },
        move: async (input) => {
          bytes.set(input.destination, bytes.get(input.source));
          bytes.delete(input.source);

          return { acknowledged: true };
        },
        writeStream: async (input) => {
          let bytesWritten = 0;
          const chunks = [];

          for await (const chunk of input.bytes) {
            chunks.push(chunk);
            bytesWritten += chunk.length;
          }

          const value = new Uint8Array(bytesWritten);
          let offset = 0;

          for (const chunk of chunks) {
            value.set(chunk, offset);
            offset += chunk.length;
          }

          bytes.set(input.path, value);

          return { bytesWritten };
        },
        readStream: async (input) =>
          new ReadableStream({
            start(controller) {
              for (const byte of bytes.get(input.path)) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
        list: async () => [
          { name: "z", type: "unknown" },
          { name: "a", type: "symlink" },
        ],
        makeDirectory: async (input) => {
          mutations.push(["mkdir", input.path, input.recursive]);

          return { acknowledged: true };
        },
        remove: async (input) => {
          mutations.push(["remove", input.path, input.recursive]);
          bytes.clear();

          return { acknowledged: true };
        },
      },
    };
  },
});

const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

try {
  const box = await client.sandboxes.create({ environment: Image.prepared("one") });
  assert.deepEqual(await directoryFiles(box), Uint8Array.of(0, 255, 129));
  assert.deepEqual(mutations, [
    ["mkdir", "/home/user/sandbar-job/results", true],
    ["remove", "/home/user/sandbar-job", true],
  ]);
  assert.deepEqual(await listChildren(box, "/job"), [
    { name: "a", type: "symlink" },
    { name: "z", type: "unknown" },
  ]);
  assert.equal(await box.fileExists("/missing"), false);
  const downloaded = [];

  const artifact = await artifactFiles(
    box,
    (async function* () {
      yield Uint8Array.of(0, 255);
      yield Uint8Array.of(129);
    })(),
    {
      async write(chunk) {
        downloaded.push(...chunk);
      },
    },
  );

  assert.deepEqual(downloaded, [0, 255, 129]);
  assert.equal(artifact.uploaded, 3);
  assert.deepEqual(artifact.lines, ["ready ✓", "complete"]);
  assert.deepEqual(
    artifact.entries.map((entry) => entry.relativePath),
    ["archive.bin", "final.json", "results", "results/events.txt", "results/report.json"],
  );
  assert.equal(artifact.directory.completeness, "complete");
  assert.equal(artifact.info.type, "file");
  assert.equal(bytes.size, 0);
  await box.destroy();
} finally {
  await client.close();
}

console.log("directory public consumer passed");
