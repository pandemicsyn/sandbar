import { expect, test } from "bun:test";
import { ControlStore, bundledMigration, migrate, openMysqlBackend } from "@sandbar/store";
import { adapterNativeScope } from "./adapter-driver";
import { publicScope, storedScope } from "./registry";

const url = process.env.SANDBAR_TEST_MYSQL_URL;

test("stored scope sorts distinct Unicode partition keys by code unit", () => {
  const composed = "é";
  const decomposed = "e\u0301";

  const first = adapterNativeScope("custom", "connection", {
    authority: { kind: "account", id: "one" },
    partition: { [composed]: "same", [decomposed]: "same" },
  });

  const reordered = adapterNativeScope("custom", "connection", {
    authority: { kind: "account", id: "one" },
    partition: { [decomposed]: "same", [composed]: "same" },
  });

  const changed = adapterNativeScope("custom", "connection", {
    authority: { kind: "account", id: "one" },
    partition: { [decomposed]: "same", [composed]: "other" },
  });

  expect(storedScope(reordered)).toBe(storedScope(first));
  expect(storedScope(changed)).not.toBe(storedScope(first));
});

test.skipIf(!url)(
  "MySQL round-trips a valid custom adapter scope above 512 characters",
  async () => {
    const backend = await openMysqlBackend(url!);

    try {
      await migrate(backend, bundledMigration("mysql"));
      const store = new ControlStore(backend);
      const project = await store.createProject(`scope-test-${crypto.randomUUID()}`);

      const connection = await store.createConnection({
        id: `conn_${crypto.randomUUID().replaceAll("-", "")}`,
        projectId: project.id,
        provider: "custom",
        name: "Custom",
        encryptedCredentials: "ciphertext",
      });

      const scope = adapterNativeScope("custom", connection.id, {
        authority: { kind: "account", id: "a".repeat(512) },
        partition: { region: "r".repeat(2048), zone: "z".repeat(2048) },
      });

      const serialized = storedScope(scope);

      expect(serialized.length).toBeGreaterThan(512);
      await store.verifyConnection(project.id, connection.id, serialized);
      const reopened = await store.getConnection(project.id, connection.id);

      expect(reopened?.scope).toBe(serialized);
      expect(storedScope(publicScope(reopened!.scope!))).toBe(serialized);
    } finally {
      await backend.close();
    }
  },
);

test.skipIf(!url)("MySQL persists valid native sandbox IDs through 512 characters", async () => {
  const nativeIds = ["n".repeat(256), "n".repeat(512)];
  const sandboxIds: string[] = [];
  let projectId = "";
  const backend = await openMysqlBackend(url!);

  try {
    await migrate(backend, bundledMigration("mysql"));
    const store = new ControlStore(backend);
    const project = await store.createProject(`native-id-test-${crypto.randomUUID()}`);

    projectId = project.id;

    const connection = await store.createConnection({
      id: `conn_${crypto.randomUUID().replaceAll("-", "")}`,
      projectId,
      provider: "custom",
      name: "Custom",
      encryptedCredentials: "ciphertext",
    });

    await store.verifyConnection(projectId, connection.id, "verified-scope");

    for (const nativeId of nativeIds) {
      const admission = await store.admitCreate({
        projectId,
        endpoint: "POST /sandboxes",
        key: Bun.randomUUIDv7(),
        intentHash: nativeId.length.toString(),
        request: { environment: { kind: "prepared", imageId: "image" } },
        connectionId: connection.id,
      });

      const claim = (await store.claimDue("native-id-test", 1000, projectId))!;

      await store.beginSubmission(claim);
      await store.complete(claim, {
        effect: "applied",
        value: {
          kind: "sandbox",
          observation: { ref: { nativeId }, state: "running" },
        },
      });
      sandboxIds.push(admission.sandbox.id);
      expect((await store.getSandbox(projectId, admission.sandbox.id))?.native_id).toBe(nativeId);
    }
  } finally {
    await backend.close();
  }

  const reopened = await openMysqlBackend(url!);

  try {
    const store = new ControlStore(reopened);

    for (const [index, sandboxId] of sandboxIds.entries()) {
      expect((await store.getSandbox(projectId, sandboxId))?.native_id).toBe(nativeIds[index]);
    }
  } finally {
    await reopened.close();
  }
});
