import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import mysql from "mysql2/promise";
import { bundledMigration, migrate, openMysqlBackend } from "./backend";
import { ControlStore } from "./store";

const url = process.env.SANDBAR_TEST_MYSQL_URL;

const otherUrl = process.env.SANDBAR_TEST_MYSQL_OTHER_URL;

const latin1Url = process.env.SANDBAR_TEST_MYSQL_LATIN1_URL;

test.skipIf(!url)("MySQL excludes another controller of the same database", async () => {
  const first = await openMysqlBackend(url!);

  try {
    await expect(openMysqlBackend(url!)).rejects.toThrow("already owned");
  } finally {
    await first.close();
  }

  const reopened = await openMysqlBackend(url!);
  await reopened.close();
});

test.skipIf(!url)("MySQL fails closed when its ownership session is killed", async () => {
  const first = await openMysqlBackend(url!);
  const killer = await mysql.createConnection(url!);

  try {
    const session = await first.row<{ id: number }>(sql`SELECT CONNECTION_ID() AS id`);

    expect(Number.isSafeInteger(Number(session?.id))).toBe(true);
    await killer.query(`KILL CONNECTION ${Number(session!.id)}`);
    const second = await openMysqlBackend(url!);

    try {
      await expect(first.row(sql`SELECT 1 AS value`)).rejects.toThrow();
      await expect(first.transaction((tx) => tx.row(sql`SELECT 1 AS value`))).rejects.toThrow();
      expect(await second.row<{ value: number }>(sql`SELECT 1 AS value`)).toEqual({ value: 1 });
    } finally {
      await second.close();
    }
  } finally {
    await killer.end();
    await first.close();
  }
});

test.skipIf(!url || !otherUrl)(
  "MySQL allows distinct control databases on the same server",
  async () => {
    const first = await openMysqlBackend(url!);

    try {
      const second = await openMysqlBackend(otherUrl!);
      await second.close();
    } finally {
      await first.close();
    }
  },
);

test.skipIf(!url)(
  "MySQL 8.4 runs the same admission, lease and observation invariants",
  async () => {
    const backend = await openMysqlBackend(url!);

    try {
      await migrate(backend, bundledMigration("mysql"));
      const store = new ControlStore(backend);
      const project = await store.createProject(`mysql-test-${crypto.randomUUID()}`);

      const connection = await store.createConnection({
        id: `conn_${crypto.randomUUID().replaceAll("-", "")}`,
        projectId: project.id,
        provider: "fake",
        name: "Fake",
        encryptedCredentials: "ciphertext",
      });

      await store.verifyConnection(project.id, connection.id, "fake-local");
      const key = Bun.randomUUIDv7();
      const request = { environment: { kind: "prepared", imageId: "fake-starter" } };

      const first = await store.admitCreate({
        projectId: project.id,
        endpoint: "POST /sandboxes",
        key,
        intentHash: "x",
        request,
        connectionId: connection.id,
      });

      const same = await store.admitCreate({
        projectId: project.id,
        endpoint: "POST /sandboxes",
        key,
        intentHash: "x",
        request,
        connectionId: connection.id,
      });

      expect(same.operation.id).toBe(first.operation.id);
      await expect(
        store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key,
          intentHash: "different",
          request,
          connectionId: connection.id,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const claim = (await store.claimDue("mysql-runner", -1, project.id))!;
      expect(claim.observeOnly).toBe(false);
      expect(await store.beginSubmission(claim)).toBe(true);
      const recovered = (await store.claimDue("mysql-recovery", 1000, project.id))!;
      expect(recovered.operation.id).toBe(first.operation.id);
      expect(recovered.observeOnly).toBe(true);
      await store.complete(recovered, {
        effect: "applied",
        value: {
          kind: "sandbox",
          observation: { ref: { nativeId: "native_mysql" }, state: "running" },
        },
      });
      expect((await store.getSandbox(project.id, first.sandbox.id))?.observed_state).toBe(
        "running",
      );
    } finally {
      await backend.close();
    }
  },
);

test.skipIf(!latin1Url)(
  "MySQL tables round-trip Unicode under a latin1 database default",
  async () => {
    const backend = await openMysqlBackend(latin1Url!);

    try {
      const database = await backend.row<{ charset: string }>(
        sql`SELECT DEFAULT_CHARACTER_SET_NAME AS charset FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()`,
      );

      expect(database?.charset).toBe("latin1");
      await migrate(backend, bundledMigration("mysql"));
      const store = new ControlStore(backend);
      const name = "München 東京 🚀";
      const project = await store.createProject(name);

      expect((await store.listProjects()).find((item) => item.id === project.id)?.name).toBe(name);

      const connection = await store.createConnection({
        id: `conn_${crypto.randomUUID().replaceAll("-", "")}`,
        projectId: project.id,
        provider: "fake",
        name: "接続 🌙",
        encryptedCredentials: "ciphertext",
      });

      await store.verifyConnection(project.id, connection.id, "fake-local");

      const admitted = await store.admitCreate({
        projectId: project.id,
        endpoint: "POST /sandboxes",
        key: Bun.randomUUIDv7(),
        intentHash: "unicode",
        request: {
          environment: { kind: "prepared", imageId: "fake-starter" },
          labels: { note: "雪と星 🌌" },
        },
        connectionId: connection.id,
      });

      expect(JSON.parse(admitted.sandbox.labels_json)).toEqual({ note: "雪と星 🌌" });
      expect(JSON.parse(admitted.operation.request_json).labels).toEqual({ note: "雪と星 🌌" });
      expect((await store.getConnection(project.id, connection.id))?.name).toBe("接続 🌙");
    } finally {
      await backend.close();
    }
  },
);
