import { expect, test } from "bun:test";
import { ControlStore, bundledMigration, migrate, openMysqlBackend } from "@sandbar/store";
import { adapterNativeScope } from "./adapter-driver";
import { publicScope, storedScope } from "./registry";

const url = process.env.SANDBAR_TEST_MYSQL_URL;

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
