import { expect, test } from "bun:test";
import { Image, Sandbar } from "sandbar-sdk";
import { createModalAdapter } from "./adapter";
import { ModalCreateRejected, type ModalTransport } from "./transport";

function fixture(failure: Error) {
  let creates = 0;

  const transport: ModalTransport = {
    async lookupApp() {
      return "ap-fixture";
    },
    async imageExists() {
      return true;
    },
    async create() {
      creates++;
      throw failure;
    },
    async findByName() {
      return null;
    },
    async *list() {},
    async terminate() {
      return true;
    },
    async poll() {
      return "missing";
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
    close() {},
  };

  const connect = () =>
    Sandbar.connect({
      adapter: createModalAdapter(() => transport),
      config: { appName: "existing", environment: "main" },
      credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
    });

  return { connect, creates: () => creates };
}

test("a definitive Modal create rejection keeps its code and native reason", async () => {
  const { connect, creates } = fixture(
    new ModalCreateRejected(
      "FORBIDDEN",
      "Modal rejected sandbox creation (PERMISSION_DENIED): workspace sandbox limit reached",
    ),
  );

  const client = await connect();

  try {
    await expect(
      client.sandboxes.create({
        environment: Image.prepared("im-fixture"),
        networkPolicy: "blocked",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("workspace sandbox limit reached"),
    });
    expect(creates()).toBe(1);
  } finally {
    await client.close();
  }
});

test("an unclassified Modal create failure stays an unknown outcome", async () => {
  const { connect, creates } = fixture(new Error("lost response"));
  const client = await connect();

  try {
    await expect(
      client.sandboxes.create({
        environment: Image.prepared("im-fixture"),
        networkPolicy: "blocked",
      }),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(creates()).toBe(1);
  } finally {
    await client.close();
  }
});

test("a Modal sandbox rejection after an OCI image build stays unknown with its reason", async () => {
  const { connect } = fixture(
    new ModalCreateRejected(
      "CAPACITY",
      "Modal rejected sandbox creation (RESOURCE_EXHAUSTED): no capacity",
      true,
    ),
  );

  const client = await connect();

  try {
    await expect(
      client.sandboxes.create({
        environment: Image.prepared("im-fixture"),
        networkPolicy: "blocked",
      }),
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      message: expect.stringContaining("no capacity; the built image remains"),
    });
  } finally {
    await client.close();
  }
});
