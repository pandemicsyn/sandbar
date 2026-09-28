import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import mysql from "mysql2/promise";
import {
  bundledMigration,
  migrate,
  openSqliteBackend,
  openMysqlBackend,
  type Backend,
} from "./backend";
import { ControlStore } from "./store";

const preservedTables = [
  "projects",
  "provider_connections",
  "sandboxes",
  "operations",
  "operation_attempts",
  "executions",
  "invocation_keys",
  "reservations",
  "resource_events",
  "usage_evidence",
];

async function snapshot(backend: Backend) {
  return Promise.all(
    preservedTables.map((table) => backend.rows(sql.raw(`SELECT * FROM ${table} ORDER BY rowid`))),
  );
}

test("SQLite image-build migration preserves populated rows and foreign keys through rollback and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-image-migration-"));
  const path = join(directory, "control.sqlite");
  let backend = openSqliteBackend(path);
  const original = bundledMigration("sqlite");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(original));
  const checksum = Buffer.from(digest).toString("hex");

  try {
    await backend.transaction(async (tx) => {
      for (const statement of original
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean))
        await tx.run(sql.raw(statement));
      await tx.run(
        sql`CREATE TABLE _sandbar_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL)`,
      );
      await tx.run(sql`INSERT INTO _sandbar_migrations VALUES ('0001_control', ${checksum})`);
    });

    const store = new ControlStore(backend);
    const project = await store.createProject("migration fixture");

    const connection = await store.createConnection({
      id: "conn_migration",
      projectId: project.id,
      provider: "fake",
      name: "fixture",
      encryptedCredentials: "sealed",
    });

    await store.verifyConnection(project.id, connection.id, "fixture");

    const accepted = await store.admitCreate({
      projectId: project.id,
      endpoint: "POST /sandboxes",
      key: Bun.randomUUIDv7(),
      intentHash: "create",
      request: { environment: { kind: "prepared", imageId: "prepared" } },
    });

    const claim = (await store.claimDue("migration"))!;

    await store.beginSubmission(claim);
    await store.complete(claim, {
      effect: "applied",
      value: {
        kind: "sandbox",
        observation: { ref: { nativeId: "native_fixture" }, state: "running" },
      },
    });
    await store.admitExec({
      projectId: project.id,
      sandboxId: accepted.sandbox.id,
      endpoint: "POST /executions",
      key: Bun.randomUUIDv7(),
      intentHash: "exec",
      encryptedRequest: "sealed execution",
      captureBytes: 32,
    });
    const rows = await snapshot(backend);

    const indexes = await backend.rows(
      sql`SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='operations' ORDER BY name`,
    );

    const dialect = new SQLiteSyncDialect();

    const failing: Backend = {
      ...backend,
      transaction: (work) =>
        backend.transaction((tx) =>
          work({
            ...tx,
            run: async (query) => {
              if (dialect.sqlToQuery(query).sql.startsWith("ALTER TABLE operations_image_build"))
                throw new Error("injected migration interruption");
              await tx.run(query);
            },
          }),
        ),
    };

    await expect(migrate(failing, original)).rejects.toThrow("injected migration interruption");
    expect(await snapshot(backend)).toEqual(rows);
    expect(await backend.rows(sql`SELECT * FROM _sandbar_migrations`)).toEqual([
      { version: "0001_control", checksum },
    ]);
    expect(await backend.rows(sql`PRAGMA foreign_key_check`)).toEqual([]);
    await backend.close();
    backend = openSqliteBackend(path);
    await migrate(backend, original);
    expect(await snapshot(backend)).toEqual(rows);
    expect(
      await backend.rows(
        sql`SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='operations' ORDER BY name`,
      ),
    ).toEqual(indexes);
    expect(await backend.rows(sql`PRAGMA foreign_key_check`)).toEqual([]);
    expect(
      await backend.row<{ checksum: string }>(
        sql`SELECT checksum FROM _sandbar_migrations WHERE version='0001_control'`,
      ),
    ).toEqual({ checksum });
    await backend.close();
    backend = openSqliteBackend(path);
    await migrate(backend, original);
    expect(await snapshot(backend)).toEqual(rows);

    const nullable = await backend.rows<{ name: string; notnull: number }>(
      sql`PRAGMA table_info(operations)`,
    );

    expect(nullable.find((column) => column.name === "sandbox_id")?.notnull).toBe(0);

    const build = await new ControlStore(backend).admitImageBuild({
      projectId: project.id,
      endpoint: "POST /images/builds",
      key: Bun.randomUUIDv7(),
      intentHash: "build",
      request: { source: { kind: "oci", value: "fixture/image:1" } },
    });

    expect(build.operation.sandbox_id).toBeNull();
    expect(await backend.rows(sql`PRAGMA foreign_key_check`)).toEqual([]);
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(!process.env.SANDBAR_TEST_MYSQL_URL)(
  "MySQL image-build DDL can resume after an interruption before recording its checksum",
  async () => {
    const url = new URL(process.env.SANDBAR_TEST_MYSQL_URL!);
    const schema = `sandbar_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    url.pathname = "/";
    const admin = await mysql.createConnection(url.toString());
    let backend: Backend | undefined;
    let schemaCreated = false;

    try {
      await admin.query(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
      schemaCreated = true;
      url.pathname = `/${schema}`;
      backend = await openMysqlBackend(url.toString());
      const original = bundledMigration("mysql");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(original));
      const checksum = Buffer.from(digest).toString("hex");

      for (const statement of original
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean))
        await backend.run(sql.raw(statement));
      await backend.run(
        sql`CREATE TABLE _sandbar_migrations (version varchar(128) PRIMARY KEY, checksum char(64) NOT NULL)`,
      );
      await backend.run(sql`INSERT INTO _sandbar_migrations VALUES ('0001_control', ${checksum})`);
      const store = new ControlStore(backend);
      const project = await store.createProject("migration fixture");

      const connection = await store.createConnection({
        id: "conn_migration",
        projectId: project.id,
        provider: "fake",
        name: "fixture",
        encryptedCredentials: "sealed",
      });

      await store.verifyConnection(project.id, connection.id, "fixture");
      await store.admitCreate({
        projectId: project.id,
        endpoint: "POST /sandboxes",
        key: Bun.randomUUIDv7(),
        intentHash: "create",
        request: { environment: { kind: "prepared", imageId: "prepared" } },
      });
      await store.claimDue("fixture");

      const rows = await Promise.all(
        preservedTables.map((table) => backend!.rows(sql.raw(`SELECT * FROM ${table}`))),
      );

      const active = backend;
      const dialect = new MySqlDialect();

      const failing: Backend = {
        ...active,
        run: async (query) => {
          await active.run(query);

          if (dialect.sqlToQuery(query).sql.startsWith("ALTER TABLE operations"))
            throw new Error("interrupted after MySQL DDL");
        },
      };

      await expect(migrate(failing, original)).rejects.toThrow("interrupted after MySQL DDL");
      expect(
        await backend.row(
          sql`SELECT checksum FROM _sandbar_migrations WHERE version='0002_image_build'`,
        ),
      ).toBeUndefined();
      await backend.close();
      backend = await openMysqlBackend(url.toString());
      await migrate(backend, original);
      await migrate(backend, original);
      expect(
        await Promise.all(
          preservedTables.map((table) => backend!.rows(sql.raw(`SELECT * FROM ${table}`))),
        ),
      ).toEqual(rows);
      expect(
        await backend.row<{ checksum: string }>(
          sql`SELECT checksum FROM _sandbar_migrations WHERE version='0001_control'`,
        ),
      ).toEqual({ checksum });

      const column = await backend.row<{ nullable: string }>(
        sql`SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=${schema} AND TABLE_NAME='operations' AND COLUMN_NAME='sandbox_id'`,
      );

      expect(column?.nullable).toBe("YES");
    } finally {
      await backend?.close();

      if (schemaCreated) await admin.query(`DROP DATABASE ${schema}`);
      await admin.end();
    }
  },
);
