import { expect, test } from "bun:test";
import { status } from "@grpc/grpc-js";
import { OutcomeUnknownError, Preserve, Sandbar } from "sandbar-sdk";
import { snapshotSuite } from "@sandbar-sdk/adapter/testing";
import { createModalAdapter } from "./adapter";
import { createRejection, type ModalTransport } from "./transport";

type Record = { id: string; tags: { [key: string]: string }; running: boolean };

function fixture() {
  const records = new Map<string, Record>();
  const images = new Set(["im-base"]);
  const creates: Parameters<ModalTransport["create"]>[0][] = [];
  const effects = { snapshot: 0, delete: 0 };
  let nextSnapshot: "lose" | "reject" | undefined;
  let loseDelete = false;

  const transport: ModalTransport = {
    async lookupApp(_name, environment) {
      return environment === "main" ? "ap-main" : "ap-alternate";
    },
    async imageExists(id) {
      return images.has(id);
    },
    async create(input) {
      creates.push(input);
      const record = { id: `sb-${creates.length}`, tags: input.tags, running: true };
      records.set(input.name, record);

      return record.id;
    },
    async findByName(_app, _environment, name) {
      return records.get(name) ?? null;
    },
    async *list() {
      for (const record of records.values()) yield record;
    },
    async terminate() {
      return true;
    },
    async poll() {
      return "stopped";
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
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false };
    },
    async snapshotFilesystem(sandboxId) {
      effects.snapshot++;

      if (nextSnapshot === "reject") {
        nextSnapshot = undefined;

        const error = Object.assign(new Error("denied"), {
          name: "ClientError",
          code: status.PERMISSION_DENIED,
          details: "snapshots are not enabled",
        });

        throw createRejection(error, "snapshot", []);
      }

      const id = `im-snap-${sandboxId}-${effects.snapshot}`;
      images.add(id);

      if (nextSnapshot === "lose") {
        nextSnapshot = undefined;
        throw new Error("response lost after native effect");
      }

      return id;
    },
    async deleteImage(imageId) {
      effects.delete++;

      if (!images.delete(imageId)) return "missing";

      if (loseDelete) {
        loseDelete = false;
        throw new Error("response lost after native effect");
      }

      return "deleted";
    },
    close() {},
  };

  const connect = (environment = "main") =>
    Sandbar.connect({
      adapter: createModalAdapter(() => transport),
      config: { appName: "existing", environment, image: "im-base" },
      credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
    });

  return {
    transport,
    records,
    images,
    creates,
    effects,
    connect,
    loseNextSnapshot() {
      nextSnapshot = "lose";
    },
    rejectNextSnapshot() {
      nextSnapshot = "reject";
    },
    loseNextDelete() {
      loseDelete = true;
    },
  };
}

test("Modal filesystem snapshots capture, inspect, restore and delete with exact identities", async () => {
  const native = fixture();
  const client = await native.connect();

  try {
    const source = await client.sandboxes.create();

    for (const request of [
      { requirements: { preserve: "filesystem+memory" as const } },
      { requirements: { maxInterruption: "none" as const } },
      { retention: { cleanupAfterSeconds: 3600 } },
      { retention: { minimumSeconds: 31 * 86_400 } },
    ])
      await expect(source.snapshot(request)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(native.effects.snapshot).toBe(0);

    const captured = await source.snapshot({ retention: { minimumSeconds: 7 * 86_400 } });
    const { snapshot } = captured;
    expect(snapshot.id).toBe(`im-snap-${source.id}-1`);
    expect(snapshot.reference).toMatchObject({ provider: "modal", ownership: "verified-created" });
    expect(captured.capture).toEqual({
      preserve: "filesystem",
      interruption: "pause",
      restoreExecution: "fresh",
    });
    expect((await source.inspect()).state).toBe("running");

    const info = await snapshot.inspect();
    expect(info).toMatchObject({
      preserve: "filesystem",
      restoreExecution: "fresh",
      state: "ready",
      restore: { networkPolicies: ["blocked"], resources: false, mounts: false },
    });

    // A saved reference reopens in a fresh connection to the same App.
    const saved = JSON.parse(JSON.stringify(snapshot.reference));
    expect((await client.snapshots.get(saved)).id).toBe(snapshot.id);

    await expect(client.snapshots.list({ limit: 10 })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });

    await expect(snapshot.restore({ networkPolicy: "internet" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    const restored = await snapshot.restore();
    expect(restored.id).not.toBe(source.id);
    expect(native.creates.at(-1)).toMatchObject({ imageId: snapshot.id });
    expect(native.creates.at(-1)?.ociReference).toBeUndefined();
    expect((await restored.inspect()).state).toBe("running");

    await snapshot.delete();
    expect(native.images.has(snapshot.id)).toBe(false);
    await expect(snapshot.inspect()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(snapshot.restore()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(snapshot.delete()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(native.effects.delete).toBe(1);
  } finally {
    await client.close();
  }
});

test("Modal capture reports native rejections and never replays a lost response", async () => {
  const native = fixture();
  const client = await native.connect();

  try {
    const source = await client.sandboxes.create();

    native.rejectNextSnapshot();
    await expect(source.snapshot()).rejects.toMatchObject({ code: "FORBIDDEN" });

    native.loseNextSnapshot();
    const lost = await source.snapshot().catch((error: Error) => error);
    expect(lost).toBeInstanceOf(OutcomeUnknownError);
    expect(native.effects.snapshot).toBe(2);
    // The image Modal made is not claimed; it expires with the native retention.
    expect(native.images.has(`im-snap-${source.id}-2`)).toBe(true);
  } finally {
    await client.close();
  }
});

test("Modal snapshot deletion observes a lost response without replay", async () => {
  const native = fixture();
  const client = await native.connect();

  try {
    const { snapshot } = await (await client.sandboxes.create()).snapshot();

    native.loseNextDelete();
    const lost = await snapshot.delete().catch((error: Error) => error);
    expect(lost).toBeInstanceOf(OutcomeUnknownError);

    if (!(lost instanceof OutcomeUnknownError)) throw lost;

    const recovered = await (await client.recover(lost.reference)).observe();
    expect(recovered).toMatchObject({ deleted: true, reference: snapshot.reference });
    expect(native.effects.delete).toBe(1);
  } finally {
    await client.close();
  }
});

test("Modal snapshot references are bound to the verified App and environment", async () => {
  const native = fixture();
  const main = await native.connect("main");
  const other = await native.connect("alternate");

  try {
    const { snapshot } = await (await main.sandboxes.create()).snapshot();
    await expect(other.snapshots.get(snapshot.reference)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(native.creates).toHaveLength(1);
  } finally {
    await main.close();
    await other.close();
  }
});

test("Modal accepts filesystem-only preserve and rejects memory at connect before any call", async () => {
  let factories = 0;
  const native = fixture();

  const adapter = createModalAdapter(() => {
    factories++;

    return native.transport;
  });

  const connect = (preserve: (typeof Preserve)[keyof typeof Preserve]) =>
    Sandbar.connect({
      adapter,
      config: {
        appName: "existing",
        environment: "main",
        image: "im-base",
        snapshots: { preserve },
      },
      credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
    });

  await expect(connect(Preserve.FILESYSTEM_AND_MEMORY)).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(factories).toBe(0);

  const client = await connect(Preserve.FILESYSTEM);

  try {
    const { capture } = await (await client.sandboxes.create()).snapshot();
    expect(capture.preserve).toBe(Preserve.FILESYSTEM);
  } finally {
    await client.close();
  }
});

test("Modal passes the shared snapshot suite without listing", async () => {
  const native = fixture();

  const client = await Sandbar.connect({
    adapter: createModalAdapter(() => native.transport),
    config: {
      appName: "existing",
      environment: "main",
      image: "im-base",
      snapshots: { preserve: Preserve.FILESYSTEM },
    },
    credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
  });

  try {
    // The fixture models no guest files; Modal has no snapshot listing API.
    await snapshotSuite({ client, preserve: Preserve.FILESYSTEM, list: false });
    expect(native.effects).toEqual({ snapshot: 1, delete: 1 });
  } finally {
    await client.close();
  }
});
