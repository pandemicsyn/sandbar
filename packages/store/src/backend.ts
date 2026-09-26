import { Database } from "bun:sqlite";
import { readFileSync, openSync, closeSync, unlinkSync } from "node:fs";
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

/** Only one process may own a SQLite control database. WAL does not replace this lease. */
export function openSqliteBackend(path: string): Backend {
  if (path === ":memory:") return sqliteBackend(new Database(path), undefined);
  const lockPath = `${path}.sandbar.lock`;
  let fd: number;
  try { fd = openSync(lockPath, "wx", 0o600); }
  catch { throw new Error(`SQLite database is already owned: ${lockPath}`); }
  try { return sqliteBackend(new Database(path, { create: true }), { path: lockPath, fd }); }
  catch (error) { closeSync(fd); unlinkSync(lockPath); throw error; }
}

function sqliteBackend(native: Database, lock?: { path: string; fd: number }): Backend {
  native.exec("PRAGMA foreign_keys = ON");
  native.exec("PRAGMA journal_mode = WAL");
  native.exec("PRAGMA synchronous = FULL");
  native.exec("PRAGMA busy_timeout = 5000");
  const db = drizzleSqlite({ client: native });
  let tail: Promise<unknown> = Promise.resolve();
  const connection: QueryConnection = {
    rows: async <T>(query: SQL) => db.all<T>(query),
    row: async <T>(query: SQL) => db.get<T>(query),
    run: async (query: SQL) => { db.run(query); },
  };
  return {
    dialect: "sqlite", ...connection,
    transaction: async <T>(work: (tx: QueryConnection) => Promise<T>): Promise<T> => {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      native.exec("BEGIN IMMEDIATE");
      try { const value = await work(connection); native.exec("COMMIT"); return value; }
      catch (error) { native.exec("ROLLBACK"); throw error; }
      finally { release(); }
    },
    close: async () => {
      await tail;
      native.close();
      if (lock) { closeSync(lock.fd); unlinkSync(lock.path); }
    },
  };
}

export async function openMysqlBackend(url: string): Promise<Backend> {
  const pool = mysql.createPool({ uri: url, connectionLimit: 8, timezone: "Z", decimalNumbers: false, multipleStatements: false });
  const db = drizzleMysql({ client: pool });
  function wrap(source: Pick<typeof db, "execute">): QueryConnection {
    return {
      rows: async <T>(query: SQL) => {
        const result = await source.execute(query) as unknown as [T[], unknown];
        return result[0];
      },
      row: async <T>(query: SQL) => {
        const result = await source.execute(query) as unknown as [T[], unknown];
        return result[0][0];
      },
      run: async (query: SQL) => { await source.execute(query); },
    };
  }
  return {
    dialect: "mysql", ...wrap(db),
    transaction: <T>(work: (tx: QueryConnection) => Promise<T>) => db.transaction(async tx => work(wrap(tx))),
    close: () => pool.end(),
  };
}

/** Apply committed SQL migration files. Startup must own the SQLite lock or the MySQL migration lock. */
export async function migrate(backend: Backend, migrationSql: string): Promise<void> {
  if (backend.dialect === "sqlite") {
    await backend.transaction(async tx => {
      for (const statement of migrationSql.split(";").map(s => s.trim()).filter(Boolean)) await tx.run(sql.raw(statement));
    });
  } else {
    // DDL auto-commits in MySQL. An exclusive service startup lock must guard this path.
    for (const statement of migrationSql.split(";").map(s => s.trim()).filter(Boolean)) await backend.run(sql.raw(statement));
  }
}

export function bundledMigration(dialect: Dialect): string {
  return readFileSync(join(import.meta.dir, `../migrations/${dialect}/0001_control.sql`), "utf8");
}
