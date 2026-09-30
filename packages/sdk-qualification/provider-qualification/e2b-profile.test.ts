import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { E2BTransport } from "sandbar-sdk/e2b";
import { e2bConfiguration, e2bConnection } from "./e2b-profile";
import { LedgerStore, requirePrivateDirectory } from "./ledger";
import { TestResources } from "../live/fixtures/resources";
import { cleanupLedger } from "../live/fixtures/reconcile";
import { lifecycle, execution, files } from "../live/sandbox.test";

const directories: string[] = [];

const config = e2bConfiguration.parse({});

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(
  options: {
    loseCreate?: boolean;
    pendingDestroy?: boolean;
    failOverwrite?: boolean;
    failNoClobber?: boolean;
    failReadAfterNoClobber?: boolean;
  } = {},
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
    async run(id, script, execution) {
      expect(id).toBe("sandbox_fixture");

      if (options.failNoClobber && script.includes("ln -T --"))
        throw new Error("offline native link failure");

      const link = process.platform === "darwin" ? "gln" : "ln";

      const rewritten = script
        .replaceAll("/tmp/", `${directory}/`)
        .replaceAll("/home/user/", `${directory}/`)
        .replace("ln -T --", `${link} -T --`);

      const result = Bun.spawnSync({
        cmd: ["/bin/sh", "-c", rewritten],
        cwd: directory,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...execution.env },
        stdout: "pipe",
        stderr: "pipe",
      });

      if (result.exitCode !== 0) throw new Error("Fixture control command failed");

      return new TextDecoder().decode(result.stdout);
    },
    async read(_id, filename, maxBytes) {
      if (options.failReadAfterNoClobber && writes >= 3)
        throw new Error("offline readback failure");
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

function resources(native: Awaited<ReturnType<typeof fixture>>, cleanupMs = 1000) {
  return new TestResources(native.factory, native.ledger, config.templateId, "blocked", {
    compute: 1,
    snapshots: 0,
    volumes: 0,
    exerciseMs: 5000,
    cleanupMs,
  });
}

test("E2B public baseline tests home-directory files and owned cleanup with native TTL", async () => {
  const native = await fixture();
  const t = resources(native);

  try {
    await t.open();
    const box = await t.create("sandbox/source");
    await lifecycle(t, box);
    await execution(t, box);
    await files(t, box, "/home/user");
  } finally {
    await t.close();
  }

  expect(config).toEqual({ templateId: "base", timeoutSeconds: 300 });
  expect(native.counters).toEqual({ create: 1, kill: 1, close: 1, build: 0 });
  expect(native.filePaths.length).toBe(3);
  expect(native.filePaths.every((p) => p.startsWith("/home/user/"))).toBe(true);
  expect((await native.ledger.read()).cleanup).toBe("confirmed");
});

test("E2B lost create is observed and owned compute removed without retry", async () => {
  const native = await fixture({ loseCreate: true });
  const t = resources(native);

  try {
    await t.open();
    await expect(t.create("sandbox/source")).rejects.toThrow();
  } finally {
    await t.close();
  }

  expect(native.counters).toEqual({ create: 1, kill: 1, close: 1, build: 0 });
  expect((await native.ledger.read()).cleanup).toBe("confirmed");
});

test("E2B pending deletion checkpoints and reconciles with a fresh client without replay", async () => {
  const native = await fixture({ pendingDestroy: true });
  const connect = native.factory;
  let interrupted = false;

  // Interrupt only after the accepted deletion checkpoint is durable, regardless of disk speed.
  native.factory = (onReference, onDiagnostic) =>
    connect(async (reference) => {
      await onReference(reference);

      if (reference.kind === "destroy" && native.counters.kill === 1 && !interrupted) {
        interrupted = true;
        throw new Error("Fixture interruption after accepted delete checkpoint");
      }
    }, onDiagnostic);
  const t = resources(native, 5000);
  await t.open();
  await t.create("sandbox/source");
  await expect(t.close()).rejects.toThrow();
  const state = await native.ledger.read();
  expect(interrupted).toBe(true);
  const deletion = state.stateMutations!.find((e) => !e.creation)!;
  expect(deletion.reference).toMatchObject({
    token: { stage: "accepted", sandboxId: "sandbox_fixture" },
    tokenVersion: 2,
  });
  expect(state.cleanup).toBe("unresolved");
  native.stop();
  await cleanupLedger(native.factory, native.ledger, 5000);
  expect(native.counters).toEqual({ create: 1, kill: 1, close: 2, build: 0 });
  expect((await native.ledger.read()).cleanup).toBe("confirmed");
});

for (const mode of ["failOverwrite", "failNoClobber"] as const)
  test(`E2B ${mode} fails observable file assertions and still cleans owned compute`, async () => {
    const native = await fixture({ [mode]: true });
    const t = resources(native);

    try {
      await t.open();
      const box = await t.create("sandbox/source");
      await expect(files(t, box, "/home/user")).rejects.toThrow();
    } finally {
      await t.close();
    }

    expect(native.writes()).toBe(mode === "failOverwrite" ? 2 : 3);
    expect((await native.ledger.read()).cleanup).toBe("confirmed");
  });

test("E2B profile refuses excessive native lifetime", () => {
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
