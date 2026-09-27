import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAdapter } from "../../adapter/src/index";
import { Image, Sandbar } from "sandbar-sdk";
import { z } from "zod";
import { LedgerStore } from "./ledger";
import { reconcile, recordReference, runPrepared, type CleanupAccess } from "./lifecycle";
import { parseReport, renderLiveMatrix } from "./report";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function ledger(checkpoint?: ConstructorParameters<typeof LedgerStore>[2]) {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-qualification-test-"));
  directories.push(directory);
  const store = new LedgerStore(directory, crypto.randomUUID(), checkpoint);
  await store.initialize("modal", { kind: "borrowed-prepared", class: "base-template" });

  return store;
}

test("private ledger retains nonsecret connection routing for crash cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-qualification-test-"));
  directories.push(directory);
  const runId = crypto.randomUUID();
  const store = new LedgerStore(directory, runId);
  await store.initialize(
    "modal",
    { kind: "borrowed-prepared", class: "prepared" },
    { appName: "fixture-app", environment: "test", region: "us", timeoutSeconds: 300 },
  );
  const reopened = new LedgerStore(directory, runId);
  expect((await reopened.read()).connection).toEqual({
    appName: "fixture-app",
    environment: "test",
    region: "us",
    timeoutSeconds: 300,
  });
});

const reference = {
  version: 2,
  mode: "direct",
  provider: "modal",
  kind: "create",
  scope: { authority: { kind: "app", id: "fixture" }, partition: {} },
  operationId: "op",
  submissionId: "sub",
  invocationKey: "inv",
} as const;

function access(overrides: Partial<CleanupAccess> = {}) {
  let destroyed = false;
  let calls = 0;

  const result: CleanupAccess = {
    async verifyReference() {},
    async observeCreate() {
      return { id: "owned-sandbox" };
    },
    async observeDestroy() {},
    sandbox(id) {
      expect(id).toBe("owned-sandbox");

      return {
        async inspect() {
          return { state: destroyed ? ("destroyed" as const) : ("running" as const) };
        },
        async destroy() {
          calls++;
          destroyed = true;
        },
      };
    },
    ...overrides,
  };

  return { result, calls: () => calls };
}

test("cleanup recovers a lost create result once and never deletes borrowed image", async () => {
  const store = await ledger();
  await store.update((value) => ({ ...value, createIntent: true, createReference: reference }));
  const fixture = access();
  expect((await reconcile(fixture.result, store)).map((step) => step.status)).toEqual([
    "passed",
    "passed",
  ]);
  expect(fixture.calls()).toBe(1);
  expect((await store.read()).cleanup).toBe("confirmed");
  expect((await store.read()).image.kind).toBe("borrowed-prepared");
  await reconcile(fixture.result, store);
  expect(fixture.calls()).toBe(1);
});

test("uncertain create remains actionable without guessing an ID", async () => {
  const store = await ledger();
  await store.update((value) => ({ ...value, createIntent: true, createReference: reference }));

  const fixture = access({
    async observeCreate() {
      return null;
    },
    sandbox() {
      throw new Error("must not delete");
    },
  });

  expect((await reconcile(fixture.result, store))[0]?.status).toBe("blocked");
  expect((await store.read()).cleanup).toBe("unresolved");
});

test("failed cleanup survives restart and a later reconcile confirms it", async () => {
  const store = await ledger();
  await store.update((value) => ({
    ...value,
    createIntent: true,
    createReference: reference,
    sandboxId: "owned-sandbox",
  }));

  const failed = access({
    sandbox() {
      return {
        async inspect() {
          return { state: "running" as const };
        },
        async destroy() {
          throw new Error("provider outage");
        },
      };
    },
  });

  expect((await reconcile(failed.result, store))[0]?.status).toBe("failed");
  const restarted = new LedgerStore(join(store.path, ".."), store.runId);
  expect((await restarted.read()).cleanup).toBe("unresolved");
  expect((await reconcile(access().result, restarted))[1]?.status).toBe("passed");
});

test("checkpoint failure rejects before a paid create reference can be admitted", async () => {
  const store = await ledger(async (state) => {
    if (state.createReference) throw new Error("off-runner store unavailable");
  });

  await store.update((value) => ({ ...value, createIntent: true }));
  let nativeCreates = 0;

  const adapter = defineAdapter({
    name: "qualification-fixture",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "fixture", id: "test" }, partition: {} },
        supports: { images: ["prepared"] as const, network: ["blocked"] as const },
        async create() {
          nativeCreates++;

          return { id: "created", state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({
    adapter,
    config: {},
    credentials: {},
    onReference: (ref) => store.update((value) => ({ ...value, createReference: ref })),
  });

  try {
    await expect(
      client.sandboxes.create({ environment: Image.prepared("fixture") }),
    ).rejects.toThrow("off-runner store unavailable");
  } finally {
    await client.close();
  }

  expect(nativeCreates).toBe(0);
});

test("destroy checkpoint failure prevents native delete dispatch", async () => {
  const store = await ledger(async (state) => {
    if (state.destroyReference) throw new Error("off-runner checkpoint unavailable");
  });

  await store.update((value) => ({ ...value, createIntent: true }));
  let nativeDeletes = 0;

  const adapter = defineAdapter({
    name: "qualification-destroy-fixture",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "fixture", id: "test" }, partition: {} },
        supports: { images: ["prepared"] as const, network: ["blocked"] as const },
        async create() {
          return { id: "created", state: "running" as const };
        },
        async destroy() {
          nativeDeletes++;

          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const client = await Sandbar.connect({
    adapter,
    config: {},
    credentials: {},
    onReference: (ref) => recordReference(store, ref),
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("fixture") });
    await store.update((value) => ({ ...value, sandboxId: box.id }));
    await expect(box.destroy()).rejects.toThrow("off-runner checkpoint unavailable");
  } finally {
    await client.close();
  }

  expect(nativeDeletes).toBe(0);
});

test("reconcile accepts already terminated owned compute without another delete", async () => {
  const store = await ledger();
  await store.update((value) => ({
    ...value,
    createIntent: true,
    createReference: reference,
    sandboxId: "owned-sandbox",
  }));

  const fixture = access({
    sandbox() {
      return {
        async inspect() {
          return { state: "destroyed" as const };
        },
        async destroy() {
          throw new Error("must not delete twice");
        },
      };
    },
  });

  expect((await reconcile(fixture.result, store))[1]?.status).toBe("passed");
});

test("lost destroy acknowledgement is observed without replay across reconciles", async () => {
  const store = await ledger();
  await store.update((value) => ({
    ...value,
    createIntent: true,
    createReference: reference,
    sandboxId: "owned-sandbox",
    destroyReference: { ...reference, kind: "destroy", sandboxId: "owned-sandbox" },
  }));
  let stopped = false;
  let observations = 0;

  const fixture = access({
    async observeDestroy() {
      observations++;
    },
    sandbox() {
      return {
        async inspect() {
          return { state: stopped ? ("destroyed" as const) : ("running" as const) };
        },
        async destroy() {
          throw new Error("unknown destroy must never be replayed");
        },
      };
    },
  });

  expect((await reconcile(fixture.result, store, 0))[0]?.status).toBe("blocked");
  expect((await reconcile(fixture.result, store, 0))[0]?.status).toBe("blocked");
  expect(observations).toBe(2);
  expect(fixture.calls()).toBe(0);
  stopped = true;
  expect((await reconcile(fixture.result, store, 0))[1]?.status).toBe("passed");
  expect((await store.read()).cleanup).toBe("confirmed");
});

test("an interrupted run before connect makes no native request", async () => {
  const store = await ledger();
  const controller = new AbortController();
  controller.abort();
  let connects = 0;

  const steps = await runPrepared(
    async () => {
      connects++;
      throw new Error("must not connect");
    },
    store,
    "borrowed-image",
    { network: "blocked", signal: controller.signal },
  );

  expect(steps[0]?.status).toBe("blocked");
  expect(connects).toBe(0);
  expect((await store.read()).createIntent).toBe(false);
});

test("a failed exercise still destroys and confirms its one owned sandbox", async () => {
  const store = await ledger();
  let running = true;
  let destroys = 0;

  const adapter = defineAdapter({
    name: "qualification-failure-fixture",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "fixture", id: "test" }, partition: {} },
        supports: {
          images: ["prepared"] as const,
          network: ["blocked"] as const,
          exec: { commands: ["argv", "shell"] as const, maxOutputBytes: 4096 },
        },
        async create() {
          return { id: "owned", state: "running" as const };
        },
        async destroy() {
          destroys++;
          running = false;

          return { computeStopped: true, retainedResources: [] };
        },
        async inspect() {
          return { id: "owned", state: running ? ("running" as const) : ("destroyed" as const) };
        },
        async exec() {
          throw new Error("fixture command failed");
        },
      };
    },
  });

  const steps = await runPrepared(
    (onReference) => Sandbar.connect({ adapter, config: {}, credentials: {}, onReference }),
    store,
    "borrowed-image",
    { network: "blocked", cleanupWaitMs: 0, selectedScenarios: new Set(["inspect", "exec-argv"]) },
  );

  expect(steps.find((step) => step.scenario === "exec-argv")?.status).toBe("failed");
  expect(steps.find((step) => step.scenario === "exec-shell")?.status).toBe("not-run");
  expect(steps.find((step) => step.scenario === "confirm-cleanup")?.status).toBe("passed");
  expect(destroys).toBe(1);
  expect((await store.read()).cleanup).toBe("confirmed");
});

test("only latest live evidence is rendered; fixtures cannot make green cells", () => {
  const base = {
    schemaVersion: 1,
    provider: "modal",
    scenario: "exec-argv",
    runCleanup: "confirmed",
    sdkCommit: "a".repeat(40),
    sdkVersion: "0.0.0",
    nativeVersion: "0.10.1",
    runtime: "Bun 1.3.14",
    platform: "macos-arm64",
    configuration: { imageClass: "prepared", network: "blocked", regionClass: "us" },
    evidenceRef: "evidence/modal-1.json",
  };

  const report = parseReport({
    schemaVersion: 1,
    records: [
      { ...base, mode: "fixture", status: "passed", timestamp: "2026-09-25T00:00:00Z" },
      { ...base, mode: "live", status: "passed", timestamp: "2026-09-26T00:00:00Z" },
      { ...base, mode: "live", status: "failed", timestamp: "2026-09-27T00:00:00Z" },
    ],
  });

  const matrix = renderLiveMatrix([report]);
  expect(matrix).toMatch(/\| failed\s+\| 2026-09-27/);
  expect(matrix).not.toMatch(/\| passed\s+\| 2026-09-26/);
  expect(
    renderLiveMatrix([parseReport({ schemaVersion: 1, records: [report.records[0]] })]),
  ).toContain("No live evidence recorded");

  const incomplete = parseReport({
    schemaVersion: 1,
    records: [
      {
        ...base,
        mode: "live",
        runCleanup: "incomplete",
        status: "passed",
        timestamp: "2026-09-27T00:00:00Z",
      },
    ],
  });

  expect(renderLiveMatrix([incomplete])).toContain("incomplete (scenario passed)");
});
