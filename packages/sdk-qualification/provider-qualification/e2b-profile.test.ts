import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { E2BTransport } from "sandbar-sdk/e2b";
import { e2bConfiguration, e2bConnection } from "./e2b-profile";
import { LedgerStore, requirePrivateDirectory } from "./ledger";
import { publicCleanupAccess, reconcile, recordReference, runPrepared } from "./lifecycle";

const directories: string[] = [];

const config = e2bConfiguration.parse({});

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(
  options: { loseCreate?: boolean; pendingDestroy?: boolean; failOverwrite?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-e2b-qualification-"));
  directories.push(directory);
  const ledger = new LedgerStore(directory, crypto.randomUUID());
  await ledger.initialize("e2b", { kind: "borrowed-prepared", class: "prepared" }, config);
  let record: Awaited<ReturnType<E2BTransport["get"]>> = null;
  const counters = { create: 0, kill: 0, close: 0, build: 0 };
  let writes = 0;
  const filePaths: string[] = [];

  const path = (value: string) => {
    const prefix = value.startsWith("/home/user/") ? "/home/user/" : "/tmp/";

    if (!value.startsWith(prefix))
      throw new Error("Fixture path must be in the selected file root");

    return join(directory, value.slice(prefix.length));
  };

  const transport: E2BTransport = {
    async verifyAuth() {},
    async verifyTeam() {
      throw new Error("API-key/base profile must not require a team");
    },
    async verifyTemplate() {
      throw new Error("Public base is validated by the native create, not a team template list");
    },
    async buildImage() {
      counters.build++;
      throw new Error("Prepared profile must never build");
    },
    async findBuild() {
      return null;
    },
    async create(input) {
      counters.create++;
      expect(input.templateId).toBe(config.templateId);
      expect(input.timeoutMs).toBe(300_000);
      expect(input.allowInternetAccess).toBe(false);
      record = {
        id: "sandbox_fixture",
        templateId: input.templateId,
        metadata: input.metadata,
        state: "running",
      };

      if (options.loseCreate) throw new Error("lost native create acknowledgement");

      return record.id;
    },
    async get(id) {
      return record?.id === id ? record : null;
    },
    async list(metadata, limit) {
      const match =
        record && Object.entries(metadata).every(([key, value]) => record!.metadata[key] === value);

      return { items: match ? [record!].slice(0, limit) : [] };
    },
    async kill(id) {
      expect(id).toBe("sandbox_fixture");
      counters.kill++;

      if (!options.pendingDestroy) record = null;

      return true;
    },
    async run(id, script, options) {
      expect(id).toBe("sandbox_fixture");
      const link = process.platform === "darwin" ? "gln" : "ln";

      const rewritten = script
        .replaceAll("/tmp/", `${directory}/`)
        .replaceAll("/home/user/", `${directory}/`)
        .replace("ln -T --", `${link} -T --`);

      const result = Bun.spawnSync({
        cmd: ["/bin/sh", "-c", rewritten],
        cwd: directory,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.env },
        stdout: "pipe",
        stderr: "pipe",
      });

      if (result.exitCode !== 0) throw new Error("Fixture control command failed");

      return new TextDecoder().decode(result.stdout);
    },
    async read(_id, filename, maxBytes) {
      const bytes = new Uint8Array(await readFile(path(filename)));

      return { bytes: bytes.slice(0, maxBytes), truncated: bytes.length > maxBytes };
    },
    async write(_id, filename, bytes) {
      writes++;
      filePaths.push(filename);

      if (options.failOverwrite && writes === 2) return;
      await writeFile(path(filename), bytes);
    },
    async remove(_id, filename) {
      await rm(path(filename), { force: true });
    },
    close() {
      counters.close++;
    },
  };

  return {
    ledger,
    counters,
    writes: () => writes,
    filePaths,
    stop: () => {
      record = null;
    },
    factory: e2bConnection(config, "synthetic-fixture-key", () => transport),
  };
}

test("E2B prepared profile qualifies documented home-directory file workflow with one native TTL sandbox", async () => {
  const native = await fixture();
  expect(config).toEqual({ templateId: "base", timeoutSeconds: 300 });

  const steps = await runPrepared(native.factory, native.ledger, config.templateId, {
    network: "blocked",
    fileRoot: "/home/user",
    cleanupWaitMs: 100,
  });

  expect(steps.every((step) => step.status === "passed")).toBe(true);
  expect(native.counters).toEqual({ create: 1, kill: 1, close: 1, build: 0 });
  expect(native.filePaths.length).toBe(3);
  expect(native.filePaths.every((path) => path.startsWith("/home/user/"))).toBe(true);
  expect((await native.ledger.read()).cleanup).toBe("confirmed");
  expect((await native.ledger.read()).connection).toEqual(config);
});

test("E2B lost create is observed and cleaned without another create or borrowed template delete", async () => {
  const native = await fixture({ loseCreate: true });

  const steps = await runPrepared(native.factory, native.ledger, config.templateId, {
    network: "blocked",
    cleanupWaitMs: 100,
  });

  expect(steps.find((step) => step.scenario === "create-prepared")?.status).toBe("failed");
  expect(steps.find((step) => step.scenario === "confirm-cleanup")?.status).toBe("passed");
  expect(native.counters).toEqual({ create: 1, kill: 1, close: 1, build: 0 });
});

test("E2B pending destroy checkpoints its token and reconciles after restart without replay", async () => {
  const native = await fixture({ pendingDestroy: true });
  await runPrepared(native.factory, native.ledger, config.templateId, {
    network: "blocked",
    cleanupWaitMs: 30,
    selectedScenarios: new Set(["inspect"]),
  });
  const state = await native.ledger.read();
  expect(state.cleanup).toBe("unresolved");
  expect(state.destroyReference?.token).toEqual({});
  expect(state.destroyReference?.tokenVersion).toBe(1);
  native.stop();
  const client = await native.factory((reference) => recordReference(native.ledger, reference));

  try {
    expect(
      (await reconcile(publicCleanupAccess(client, native.ledger), native.ledger, 100))[1]?.status,
    ).toBe("passed");
  } finally {
    await client.close();
  }

  expect(native.counters).toEqual({ create: 1, kill: 1, close: 2, build: 0 });
  expect((await native.ledger.read()).cleanup).toBe("confirmed");
});

test("E2B profile refuses a longer native lifetime before connection", () => {
  expect(() => e2bConfiguration.parse({ ...config, timeoutSeconds: 3600 })).toThrow();
});

test("operator preflight refuses a permissive ledger directory before credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-permissions-fixture-"));
  directories.push(directory);
  await chmod(directory, 0o755);
  await expect(requirePrivateDirectory(directory)).rejects.toThrow(
    "Unsafe ledger directory permissions",
  );
  await chmod(directory, 0o500);
  await expect(requirePrivateDirectory(directory)).rejects.toThrow(
    "Unsafe ledger directory permissions",
  );
  await chmod(directory, 0o700);
  await requirePrivateDirectory(directory);
});

test("manual run rejects missing authorization and CI before operator credentials", () => {
  for (const extra of [{}, { CI: "1", SANDBAR_QUAL_LIVE_AUTHORIZED: "yes" }]) {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "packages/sdk-qualification/provider-qualification/manual.ts",
        "live-prepared",
      ],
      env: {
        SANDBAR_QUAL_PROVIDER: "e2b",
        SANDBAR_CREDENTIALS_FILE: "/dev/null/never-read",
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const error = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).not.toBe(0);
    expect(error).toMatch(/SANDBAR_QUAL_LIVE_AUTHORIZED|off-runner checkpoint/);
    expect(error).not.toContain("Unable to read Sandbar credential file");
  }
});

test("failed overwrite blocks no-clobber without another write and still confirms teardown", async () => {
  const native = await fixture({ failOverwrite: true });

  const steps = await runPrepared(native.factory, native.ledger, config.templateId, {
    network: "blocked",
    cleanupWaitMs: 100,
  });

  expect(steps.find((step) => step.scenario === "file-binary")?.status).toBe("passed");
  expect(steps.find((step) => step.scenario === "file-overwrite")?.status).toBe("failed");
  expect(steps.find((step) => step.scenario === "file-no-clobber")).toEqual({
    scenario: "file-no-clobber",
    status: "blocked",
    issue: "dependency-failed",
  });
  expect(native.writes()).toBe(2);
  expect((await native.ledger.read()).cleanup).toBe("confirmed");
});
