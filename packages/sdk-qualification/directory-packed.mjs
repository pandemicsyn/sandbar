import assert from "node:assert/strict";
import { Sandbar, Image } from "sandbar-sdk";
import { defineAdapter } from "sandbar-adapter";
import { z } from "zod";
import { directoryFiles, listChildren } from "./directory-files.js";

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
  await box.destroy();
} finally {
  await client.close();
}

console.log("directory public consumer passed");
