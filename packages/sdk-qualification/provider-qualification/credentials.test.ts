import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials } from "./credentials";

test("credential file imports only keys and preserves injected environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-credential-fixture-"));

  try {
    const file = join(directory, "sandbar.env");
    await writeFile(
      file,
      [
        "DAYTONA_API_KEY=fixture-daytona",
        "E2B_API_KEY='fixture-e2b'",
        "SANDBAR_QUAL_LIVE_AUTHORIZED=yes",
        "SANDBAR_DAYTONA_LIVE=1",
      ].join("\n"),
      { mode: 0o600 },
    );
    const environment: NodeJS.ProcessEnv = { E2B_API_KEY: "injected-fixture" };
    await loadCredentials(file, environment);
    expect(environment.SANDBAR_DAYTONA_API_KEY).toBe("fixture-daytona");
    expect(environment.E2B_API_KEY).toBe("injected-fixture");
    expect(environment.SANDBAR_QUAL_LIVE_AUTHORIZED).toBeUndefined();
    expect(environment.SANDBAR_DAYTONA_LIVE).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing credential file leaves environment untouched", async () => {
  const environment: NodeJS.ProcessEnv = {};
  await loadCredentials(join(tmpdir(), `missing-sandbar-${crypto.randomUUID()}.env`), environment);
  expect(environment).toEqual({});
});

test("oversized credential file is rejected without importing partial keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-credential-size-fixture-"));

  try {
    const file = join(directory, "sandbar.env");
    await writeFile(file, "E2B_API_KEY=fixture\n" + "#".repeat(65_537), { mode: 0o600 });
    const environment: NodeJS.ProcessEnv = {};
    await expect(loadCredentials(file, environment)).rejects.toThrow(
      "Unable to read Sandbar credential file",
    );
    expect(environment).toEqual({});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential file rejects group-readable secrets before importing keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-credential-mode-fixture-"));

  try {
    const file = join(directory, "sandbar.env");
    await writeFile(file, "E2B_API_KEY=fixture\n", { mode: 0o640 });
    const environment: NodeJS.ProcessEnv = {};
    await expect(loadCredentials(file, environment)).rejects.toThrow(
      "Unable to read Sandbar credential file",
    );
    expect(environment).toEqual({});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
