import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  readFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { fillPlaceholders, sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import mysql from "mysql2/promise";
import { z } from "zod";

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

const SqliteOwnerRecord = z.strictObject({
  pid: z.number().int().positive(),
  identity: z.string().min(1),
  createdAt: z.number().int(),
});

function processIdentity(pid: number): string {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");

    if (!stat.startsWith(`${pid} (`) || commandEnd < 0)
      throw new Error(`Cannot verify SQLite owner process ${pid}`);

    // Fields after the parenthesized command start at field 3; starttime is field 22.
    const startTicks = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/)[19];

    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

    if (!startTicks || !/^[1-9][0-9]*$/.test(startTicks) || !bootId)
      throw new Error(`Cannot verify SQLite owner process ${pid}`);

    return `linux:${bootId}:${startTicks}`;
  }

  if (process.platform === "darwin") {
    // ps reports whole seconds on macOS; same-second PID reuse remains ambiguous.
    const started = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    })
      .trim()
      .replace(/\s+/g, " ");

    if (!started) throw new Error(`Cannot verify SQLite owner process ${pid}`);

    return `darwin:${started}`;
  }

  throw new Error(`SQLite process ownership is unsupported on ${process.platform}`);
}

/** Every contender publishes its process instance before checking for other owners. */
export function openSqliteBackend(path: string): Backend {
  if (path === ":memory:") return sqliteBackend(new Database(path));
  const absolutePath = resolve(path);
  let entry: ReturnType<typeof lstatSync> | undefined;

  try {
    entry = lstatSync(absolutePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  let canonicalPath: string;

  if (entry) {
    try {
      canonicalPath = realpathSync(absolutePath);
    } catch {
      throw new Error(`SQLite path is a dangling or ambiguous alias: ${absolutePath}`);
    }

    const target = statSync(canonicalPath);

    if (!target.isFile()) throw new Error(`SQLite database path is not a regular file: ${path}`);

    if (target.nlink > 1)
      throw new Error(`Hard-linked SQLite databases are unsupported; remove aliases to ${path}`);
  } else {
    canonicalPath = join(realpathSync(dirname(absolutePath)), basename(absolutePath));
  }

  const lockDir = `${canonicalPath}.sandbar.locks`;
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const identity = processIdentity(process.pid);
  const ownName = `pid-${process.pid}-${crypto.randomUUID()}`;
  const ownPath = join(lockDir, ownName);
  const fd = openSync(ownPath, "wx", 0o600);

  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, identity, createdAt: Date.now() }));
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
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        unlinkSync(join(lockDir, name));
        continue;
      }

      const otherPath = join(lockDir, name);

      const unverified = () =>
        new Error(
          `Cannot verify live SQLite owner PID ${pid} at ${otherPath}; stop all Sandbar processes and remove this lock file only after confirming no owner remains`,
        );

      let observedIdentity: string;

      try {
        observedIdentity = processIdentity(pid);
      } catch {
        throw unverified();
      }

      let recordedIdentity: string | undefined;

      try {
        const record = SqliteOwnerRecord.safeParse(JSON.parse(readFileSync(otherPath, "utf8")));

        if (record.success && record.data.pid === pid) recordedIdentity = record.data.identity;
      } catch {
        // Legacy or damaged live-owner records cannot be removed safely.
      }

      if (!recordedIdentity || !recordedIdentity.startsWith(`${process.platform}:`))
        throw unverified();

      if (recordedIdentity === observedIdentity)
        throw new Error(`SQLite database has another live contender: PID ${pid}`);

      unlinkSync(otherPath);
    }
  } catch (error) {
    unlinkSync(ownPath);
    throw error;
  }

  let native: Database | undefined;

  try {
    native = new Database(canonicalPath, { create: true });

    return sqliteBackend(native, ownPath);
  } catch (error) {
    native?.close(true);
    unlinkSync(ownPath);
    throw error;
  }
}

function sqliteBackend(native: Database, ownLockPath?: string): Backend {
  native.exec("PRAGMA foreign_keys = ON");
  native.exec("PRAGMA busy_timeout = 5000");
  native.exec("PRAGMA journal_mode = WAL");
  native.exec("PRAGMA synchronous = FULL");
  const dialect = new SQLiteSyncDialect();
  let tail: Promise<unknown> = Promise.resolve();

  const bindings = (params: unknown[]): SQLQueryBindings[] => {
    // SAFETY: Drizzle's SQLite dialect has mapped SQL parameters to native SQLite values.
    return fillPlaceholders(params, {}) as SQLQueryBindings[];
  };

  const direct: QueryConnection = {
    rows: async <T>(query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      const statement = native.prepare(compiled.sql);

      try {
        // SAFETY: QueryConnection callers supply T for the selected raw row shape.
        return statement.all(...bindings(compiled.params)) as T[];
      } finally {
        statement.finalize();
      }
    },
    row: async <T>(query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      const statement = native.prepare(compiled.sql);

      try {
        // SAFETY: QueryConnection callers supply T for the selected raw row shape.
        return (statement.get(...bindings(compiled.params)) ?? undefined) as T | undefined;
      } finally {
        statement.finalize();
      }
    },
    run: async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      const statement = native.prepare(compiled.sql);

      try {
        statement.run(...bindings(compiled.params));
      } finally {
        statement.finalize();
      }
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
        native.close(true);

        if (ownLockPath) unlinkSync(ownLockPath);
      }),
  };
}

export async function openMysqlBackend(url: string): Promise<Backend> {
  if (/^mysqls:\/\//i.test(url))
    throw new Error("mysqls:// is unsupported; a MySQL URI scheme does not configure TLS");

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

/** Apply committed SQL migrations in order. Existing version checksums are preserved. */
export async function migrate(backend: Backend, migrationSql: string): Promise<void> {
  const migrations = [
    { version: "0001_control", source: migrationSql },
    { version: "0002_adapter", source: bundledAdapterMigration(backend.dialect) },
  ];
  for (const migration of migrations) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(migration.source));
    const checksum = Buffer.from(digest).toString("hex");
    if (backend.dialect === "sqlite") {
      await backend.transaction(async (tx) => {
        await tx.run(sql.raw("CREATE TABLE IF NOT EXISTS _sandbar_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL)"));
        const prior = await tx.row<{ checksum: string }>(
          sql`SELECT checksum FROM _sandbar_migrations WHERE version=${migration.version}`,
        );
        if (prior) {
          if (prior.checksum !== checksum)
            throw new Error(`Committed SQLite migration checksum differs from applied ${migration.version}`);
          return;
        }
        for (const statement of migration.source.split(";").map((part) => part.trim()).filter(Boolean))
          await tx.run(sql.raw(statement));
        await tx.run(sql`INSERT INTO _sandbar_migrations (version,checksum) VALUES (${migration.version},${checksum})`);
      });
    } else {
      await backend.run(sql.raw(
        "CREATE TABLE IF NOT EXISTS _sandbar_migrations (version varchar(128) COLLATE utf8mb4_bin PRIMARY KEY, checksum char(64) COLLATE utf8mb4_bin NOT NULL) ENGINE=InnoDB",
      ));
      const prior = await backend.row<{ checksum: string }>(
        sql`SELECT checksum FROM _sandbar_migrations WHERE version=${migration.version}`,
      );
      if (prior) {
        if (prior.checksum !== checksum)
          throw new Error(`Committed MySQL migration checksum differs from applied ${migration.version}`);
        continue;
      }
      for (const statement of migration.source.split(";").map((part) => part.trim()).filter(Boolean))
        await backend.run(sql.raw(statement));
      await backend.run(sql`INSERT INTO _sandbar_migrations (version,checksum) VALUES (${migration.version},${checksum})`);
    }
  }
}

function bundledAdapterMigration(dialect: Dialect): string {
  const source = join(import.meta.dir, `../migrations/${dialect}/0002_adapter.sql`);
  const bundled = join(import.meta.dir, `migrations/${dialect}/0002_adapter.sql`);
  return readFileSync(existsSync(source) ? source : bundled, "utf8");
}

export function bundledMigration(dialect: Dialect): string {
  const source = join(import.meta.dir, `../migrations/${dialect}/0001_control.sql`);
  const bundled = join(import.meta.dir, `migrations/${dialect}/0001_control.sql`);

  return readFileSync(existsSync(source) ? source : bundled, "utf8");
}
