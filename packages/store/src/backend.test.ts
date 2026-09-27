import { expect, test } from "bun:test";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { openMysqlBackend, openSqliteBackend } from "./backend";

test("direct MySQL backend rejects mysqls before connecting", async () => {
  await expect(openMysqlBackend("mysqls://operator:secret@127.0.0.1:1/control")).rejects.toThrow(
    "mysqls:// is unsupported",
  );
});

test("SQLite finalizes statements after queries and errors before closing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-sqlite-statements-"));
  const path = join(directory, "control.sqlite");
  const backend = openSqliteBackend(path);
  const bytes = new Uint8Array([0, 128, 255]);

  try {
    await backend.run(sql`CREATE TABLE payloads (id INTEGER PRIMARY KEY, data BLOB NOT NULL)`);
    await backend.run(sql`INSERT INTO payloads (id, data) VALUES (${7}, ${bytes})`);

    expect(
      await backend.row<{ id: number; data: Uint8Array }>(
        sql`SELECT * FROM payloads WHERE id=${7}`,
      ),
    ).toEqual({ id: 7, data: bytes });
    expect(await backend.rows<{ id: number }>(sql`SELECT id FROM payloads WHERE id=${7}`)).toEqual([
      { id: 7 },
    ]);
    expect(await backend.row(sql`SELECT id FROM payloads WHERE id=${8}`)).toBeUndefined();
    await expect(
      backend.run(sql`INSERT INTO payloads (id, data) VALUES (${7}, ${bytes})`),
    ).rejects.toThrow();
  } finally {
    await backend.close();
  }

  expect(await readdir(`${path}.sandbar.locks`)).toEqual([]);

  const reopened = openSqliteBackend(path);

  try {
    expect(await reopened.row<{ id: number }>(sql`SELECT id FROM payloads WHERE id=${7}`)).toEqual({
      id: 7,
    });
  } finally {
    await reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite owner records exclude a contender and ignore dead owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-sqlite-lock-"));
  const path = join(directory, "control.sqlite");
  const first = openSqliteBackend(path);

  try {
    expect(() => openSqliteBackend(path)).toThrow();
  } finally {
    await first.close();
  }

  await writeFile(
    join(`${path}.sandbar.locks`, "pid-999999999-00000000-0000-0000-0000-000000000000"),
    "stale",
  );
  const reopened = openSqliteBackend(path);
  await reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test("SQLite owner records distinguish process instances and fail closed on ambiguous records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-sqlite-instance-"));
  const path = join(directory, "control.sqlite");
  const lockDir = `${path}.sandbar.locks`;

  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "test-support/hold-sqlite-owner.ts"), path],
    { stdout: "pipe", stderr: "pipe" },
  );

  try {
    const ready = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    expect(() => openSqliteBackend(path)).toThrow("another live contender");

    child.kill("SIGKILL");
    await child.exited;
    const recovered = openSqliteBackend(path);

    try {
      expect(() => openSqliteBackend(path)).toThrow("another live contender");
    } finally {
      await recovered.close();
    }

    const active = openSqliteBackend(path);

    const activeName = (await readdir(lockDir)).find((name) =>
      name.startsWith(`pid-${process.pid}-`),
    );

    expect(activeName).toBeDefined();

    // SAFETY: The backend writes this JSON owner record before it returns.
    const activeRecord = JSON.parse(await readFile(join(lockDir, activeName!), "utf8")) as {
      identity: string;
    };

    await active.close();
    const oldIdentity = `${activeRecord.identity.slice(0, -1)}${activeRecord.identity.endsWith("0") ? "1" : "0"}`;
    const stalePath = join(lockDir, `pid-${process.pid}-${crypto.randomUUID()}`);
    await writeFile(
      stalePath,
      JSON.stringify({ pid: process.pid, identity: oldIdentity, createdAt: Date.now() }),
    );
    const afterReuse = openSqliteBackend(path);
    await afterReuse.close();
    await expect(readFile(stalePath)).rejects.toThrow();

    const legacyPath = join(lockDir, `pid-${process.pid}-${crypto.randomUUID()}`);
    await writeFile(legacyPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    expect(() => openSqliteBackend(path)).toThrow("Cannot verify live SQLite owner");
    expect(await readFile(legacyPath, "utf8")).toContain("createdAt");
    await rm(legacyPath);

    const damagedPath = join(lockDir, `pid-${process.pid}-${crypto.randomUUID()}`);
    await writeFile(damagedPath, "not-json");
    expect(() => openSqliteBackend(path)).toThrow("Cannot verify live SQLite owner");
    expect(await readFile(damagedPath, "utf8")).toBe("not-json");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite ownership uses canonical file paths and rejects hard links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-sqlite-alias-"));
  const path = join(directory, "control.sqlite");
  const alias = join(directory, "alias.sqlite");
  const hardLink = join(directory, "hard.sqlite");

  try {
    const created = openSqliteBackend(path);
    await created.close();
    await symlink(path, alias);

    const direct = openSqliteBackend(path);

    try {
      expect(() => openSqliteBackend(alias)).toThrow("another live contender");
    } finally {
      await direct.close();
    }

    const throughAlias = openSqliteBackend(alias);
    await throughAlias.close();
    await link(path, hardLink);
    expect(() => openSqliteBackend(path)).toThrow("Hard-linked SQLite databases are unsupported");
    expect(() => openSqliteBackend(hardLink)).toThrow(
      "Hard-linked SQLite databases are unsupported",
    );

    const realParent = join(directory, "real-parent");
    const aliasParent = join(directory, "alias-parent");
    await mkdir(realParent);
    await symlink(realParent, aliasParent);
    const newPath = join(realParent, "new.sqlite");
    const newViaAlias = openSqliteBackend(join(aliasParent, "new.sqlite"));

    try {
      await access(newPath);
      expect(() => openSqliteBackend(newPath)).toThrow("another live contender");
    } finally {
      await newViaAlias.close();
    }

    await symlink(join(directory, "missing.sqlite"), join(directory, "dangling.sqlite"));
    expect(() => openSqliteBackend(join(directory, "dangling.sqlite"))).toThrow(
      "dangling or ambiguous alias",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
