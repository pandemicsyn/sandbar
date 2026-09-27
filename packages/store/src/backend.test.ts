import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteBackend } from "./backend";

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
