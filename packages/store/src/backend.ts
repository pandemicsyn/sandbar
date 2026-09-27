import { Database } from "bun:sqlite";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { sql, type SQL } from "drizzle-orm";
import mysql from "mysql2/promise";

export type Dialect = "sqlite" | "mysql";

export interface QueryConnection {
  rows<T>(query: SQL): Promise<T[]>;
  row<T>(query: SQL): Promise<T | undefined>;
  run(query: SQL): Promise<void>;
}

export interface Backend extends QueryConnection {
  readonly dialect: Dialect;
  transaction<T>(work: (tx: QueryConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Every contender publishes its own live PID before checking for other owners. */
export function openSqliteBackend(path: string): Backend {
  if (path === ":memory:") return sqliteBackend(new Database(path));
  const lockDir = `${path}.sandbar.locks`;
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const ownName = `pid-${process.pid}-${crypto.randomUUID()}`;
  const ownPath = join(lockDir, ownName);
  const fd = openSync(ownPath, "wx", 0o600);

  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
  } catch (error) {
    unlinkSync(ownPath);
    throw error;
  } finally {
    closeSync(fd);
  }

  try {
    for (const name of readdirSync(lockDir)) {
      if (name === ownName) continue;
      const match = /^pid-([1-9][0-9]*)-[0-9a-f-]+$/i.exec(name);

      if (!match) throw new Error("SQLite lock directory contains an unrecognized entry");
      const pid = Number(match[1]);

      try {
        process.kill(pid, 0);
        throw new Error(`SQLite database has another live contender: PID ${pid}`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        unlinkSync(join(lockDir, name));
      }
    }
  } catch (error) {
    unlinkSync(ownPath);
    throw error;
  }

  try {
    const native = new Database(path, { create: true });

    try {
      return sqliteBackend(native, ownPath);
    } catch (error) {
      native.close();
      throw error;
    }
  } catch (error) {
    unlinkSync(ownPath);
    throw error;
  }
}

function sqliteBackend(native: Database, ownLockPath?: string): Backend {
  native.exec("PRAGMA foreign_keys = ON");
  native.exec("PRAGMA journal_mode = WAL");
  native.exec("PRAGMA synchronous = FULL");
  native.exec("PRAGMA busy_timeout = 5000");
  const db = drizzleSqlite({ client: native });
  let tail: Promise<unknown> = Promise.resolve();

  const direct: QueryConnection = {
    rows: async <T>(query: SQL) => db.all<T>(query),
    row: async <T>(query: SQL) => db.get<T>(query),
    run: async (query: SQL) => {
      db.run(query);
    },
  };

  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = tail;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      return await work();
    } finally {
      release();
    }
  }

  const connection: QueryConnection = {
    rows: <T>(query: SQL) => exclusive(() => direct.rows<T>(query)),
    row: <T>(query: SQL) => exclusive(() => direct.row<T>(query)),
    run: (query: SQL) => exclusive(() => direct.run(query)),
  };

  return {
    dialect: "sqlite",
    ...connection,
    transaction: <T>(work: (tx: QueryConnection) => Promise<T>): Promise<T> =>
      exclusive(async () => {
        native.exec("BEGIN IMMEDIATE");

        try {
          const value = await work(direct);
          native.exec("COMMIT");

          return value;
        } catch (error) {
          native.exec("ROLLBACK");
          throw error;
        }
      }),
    close: () =>
      exclusive(async () => {
        native.close();

        if (ownLockPath) unlinkSync(ownLockPath);
      }),
  };
}

export async function openMysqlBackend(url: string): Promise<Backend> {
  const pool = mysql.createPool({
    uri: url,
    connectionLimit: 8,
    timezone: "Z",
    decimalNumbers: false,
    multipleStatements: false,
  });

  let lockConnection: Awaited<ReturnType<typeof pool.getConnection>> | undefined;
  let lockName: string | undefined;

  try {
    lockConnection = await pool.getConnection();

    // SAFETY: This SELECT returns one row with the selected database name.
    const [databaseRows] = (await lockConnection.query("SELECT DATABASE() AS name")) as [
      { name: string | null }[],
      unknown,
    ];

    const databaseName = databaseRows[0]?.name;

    if (!databaseName) throw new Error("MySQL control database must select a database");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(databaseName));
    lockName = `sandbar-control-${Buffer.from(digest).toString("hex").slice(0, 40)}`;

    // SAFETY: GET_LOCK returns one row with its numeric acquired flag.
    const [lockRows] = (await lockConnection.query("SELECT GET_LOCK(?, 0) AS acquired", [
      lockName,
    ])) as [{ acquired: number }[], unknown];

    if (Number(lockRows[0]?.acquired) !== 1)
      throw new Error("MySQL control database is already owned by another service");
  } catch (error) {
    lockConnection?.release();
    await pool.end();
    throw error;
  }

  if (!lockConnection || !lockName)
    throw new Error("MySQL control database lock was not initialized");
  const ownedConnection = lockConnection;
  const db = drizzleMysql({ client: ownedConnection });
  let tail: Promise<unknown> = Promise.resolve();

  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = tail;

    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      return await work();
    } finally {
      release();
    }
  }

  function wrap(source: Pick<typeof db, "execute">): QueryConnection {
    return {
      rows: async <T>(query: SQL) => {
        const result: unknown = await source.execute(query);

        // SAFETY: Drizzle's MySQL execute returns rows as the first tuple member.
        return (result as [T[], unknown])[0];
      },
      row: async <T>(query: SQL) => {
        const result: unknown = await source.execute(query);

        // SAFETY: Drizzle's MySQL execute returns rows as the first tuple member.
        return (result as [T[], unknown])[0][0];
      },
      run: async (query: SQL) => {
        await source.execute(query);
      },
    };
  }

  const direct = wrap(db);

  return {
    dialect: "mysql",
    rows: <T>(query: SQL) => exclusive(() => direct.rows<T>(query)),
    row: <T>(query: SQL) => exclusive(() => direct.row<T>(query)),
    run: (query: SQL) => exclusive(() => direct.run(query)),
    transaction: <T>(work: (tx: QueryConnection) => Promise<T>) =>
      exclusive(() => db.transaction(async (tx) => work(wrap(tx)))),
    close: () =>
      exclusive(async () => {
        try {
          await ownedConnection.query("SELECT RELEASE_LOCK(?)", [lockName]);
        } catch {
          // A dead session has already released its lock; closing the pool still fails it closed.
        } finally {
          ownedConnection.release();
          await pool.end();
        }
      }),
  };
}

/** Apply committed SQL migration files. Startup must own the SQLite lock or the MySQL migration lock. */
export async function migrate(backend: Backend, migrationSql: string): Promise<void> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(migrationSql));
  const checksum = Buffer.from(digest).toString("hex");
  const version = "0001_control";

  if (backend.dialect === "sqlite") {
    await backend.transaction(async (tx) => {
      await tx.run(
        sql.raw(
          "CREATE TABLE IF NOT EXISTS _sandbar_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL)",
        ),
      );

      const prior = await tx.row<{ checksum: string }>(
        sql`SELECT checksum FROM _sandbar_migrations WHERE version=${version}`,
      );

      if (prior) {
        if (prior.checksum !== checksum)
          throw new Error("Committed SQLite migration checksum differs from applied version");

        return;
      }

      for (const statement of migrationSql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await tx.run(sql.raw(statement));
      await tx.run(
        sql`INSERT INTO _sandbar_migrations (version,checksum) VALUES (${version},${checksum})`,
      );
    });
  } else {
    // DDL auto-commits in MySQL. An exclusive service startup lock must guard this path.
    await backend.run(
      sql.raw(
        "CREATE TABLE IF NOT EXISTS _sandbar_migrations (version varchar(128) COLLATE utf8mb4_bin PRIMARY KEY, checksum char(64) COLLATE utf8mb4_bin NOT NULL) ENGINE=InnoDB",
      ),
    );

    const prior = await backend.row<{ checksum: string }>(
      sql`SELECT checksum FROM _sandbar_migrations WHERE version=${version}`,
    );

    if (prior) {
      if (prior.checksum !== checksum)
        throw new Error("Committed MySQL migration checksum differs from applied version");

      return;
    }

    for (const statement of migrationSql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await backend.run(sql.raw(statement));
    await backend.run(
      sql`INSERT INTO _sandbar_migrations (version,checksum) VALUES (${version},${checksum})`,
    );
  }
}

export function bundledMigration(dialect: Dialect): string {
  const source = join(import.meta.dir, `../migrations/${dialect}/0001_control.sql`);
  const bundled = join(import.meta.dir, `migrations/${dialect}/0001_control.sql`);

  return readFileSync(existsSync(source) ? source : bundled, "utf8");
}
