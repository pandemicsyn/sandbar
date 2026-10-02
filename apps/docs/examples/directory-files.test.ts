import { expect, test } from "bun:test";
import { z } from "zod";
import { Sandbar, Image } from "sandbar-sdk";
import { defineAdapter } from "sandbar-adapter";
import { directoryFiles, listChildren } from "./directory-files";

test("public directory example preserves bytes and requests recursion deliberately", async () => {
  const files = new Map<string, Uint8Array>();
  const mutations: { path: string; recursive: boolean }[] = [];

  const adapter = defineAdapter({
    name: "docs.directory-example",
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
        create: async () => ({ id: "one", state: "running" as const }),
        destroy: async () => ({ computeStopped: true, retainedResources: [] }),
        files: {
          maxBytes: 1024,
          read: async (input) => files.get(input.path)!,
          write: async (input) => {
            files.set(input.path, input.bytes);

            return { bytesWritten: input.bytes.length };
          },
          exists: async (input) => files.has(input.path),
          list: async () => [
            { name: "z", type: "unknown" as const },
            { name: "a", type: "symlink" as const },
          ],
          makeDirectory: async (input) => {
            mutations.push(input);

            return { acknowledged: true as const };
          },
          remove: async (input) => {
            mutations.push(input);
            files.clear();

            return { acknowledged: true as const };
          },
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("base") });
    expect(await directoryFiles(box)).toEqual(Uint8Array.of(0, 255, 129));
    expect(mutations).toEqual([
      expect.objectContaining({ path: "/home/user/sandbar-job/results", recursive: true }),
      expect.objectContaining({ path: "/home/user/sandbar-job", recursive: true }),
    ]);
    expect(await listChildren(box, "/job")).toEqual([
      { name: "a", type: "symlink" },
      { name: "z", type: "unknown" },
    ]);
    await box.destroy();
  } finally {
    await client.close();
  }
});
