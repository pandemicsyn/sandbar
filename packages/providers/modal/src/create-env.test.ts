import { expect, test } from "bun:test";
import { Image, Sandbar, type AdapterRecoveryReference } from "sandbar-sdk";
import { createModalAdapter } from "./adapter";
import type { ModalTransport } from "./transport";

const SECRET = "CANARY-modal-env-secret";

test("Modal passes create env to the single native create and saves no value", async () => {
  const creates: Parameters<ModalTransport["create"]>[0][] = [];

  const transport: ModalTransport = {
    async lookupApp() {
      return "ap-fixture";
    },
    async imageExists() {
      return true;
    },
    async create(input) {
      creates.push(input);

      return "sb-env";
    },
    async findByName(_app, _environment, name) {
      const input = creates.find((create) => create.name === name);

      return input ? { id: "sb-env", tags: input.tags, running: true } : null;
    },
    async *list() {},
    async terminate() {
      return true;
    },
    async poll() {
      return "running";
    },
    async readBytes() {
      return new Uint8Array();
    },
    async fileExists() {
      return false;
    },
    async start() {},
    async stdin() {},
    async result() {
      throw new Error("no execution evidence");
    },
    async snapshotFilesystem() {
      throw new Error("unused");
    },
    async deleteImage() {
      return "missing";
    },
    close() {},
  };

  const saved: AdapterRecoveryReference[] = [];

  const client = await Sandbar.connect({
    adapter: createModalAdapter(() => transport),
    config: { appName: "existing", environment: "main", image: Image.prepared("im-fixture") },
    credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
    onReference(reference) {
      saved.push(structuredClone(reference));
    },
  });

  try {
    expect((await client.capabilities()).createEnv).toBe(true);
    const operation = await client.sandboxes.submitCreate({ env: { API_TOKEN: SECRET } });
    await operation.wait();
    expect(creates).toHaveLength(1);
    expect(creates[0]?.env).toEqual({ API_TOKEN: SECRET });
    expect(JSON.stringify([operation.reference, saved])).not.toContain(SECRET);

    await client.sandboxes.create();
    expect(creates[1]).not.toHaveProperty("env");
  } finally {
    await client.close();
  }
});
