import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore, recordLegacyReference as recordReference } from "./ledger";
import { parseReport, renderLiveMatrix } from "./report";

const reference = {
  version: 2,
  mode: "direct",
  provider: "daytona",
  kind: "create",
  scope: { authority: { kind: "app", id: "fixture" }, partition: {} },
  operationId: "op",
  submissionId: "sub",
  invocationKey: "inv",
} as const;

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function ledger(checkpoint?: ConstructorParameters<typeof LedgerStore>[2]) {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-qualification-test-"));
  directories.push(directory);
  const store = new LedgerStore(directory, crypto.randomUUID(), checkpoint);
  await store.initialize("daytona", { kind: "borrowed-prepared", class: "base-template" });

  return store;
}

test("private ledger retains nonsecret connection routing for crash cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-qualification-test-"));
  directories.push(directory);
  const runId = crypto.randomUUID();
  const store = new LedgerStore(directory, runId);
  await store.initialize(
    "daytona",
    { kind: "borrowed-prepared", class: "prepared" },
    { target: "fixture-app", region: "us", timeoutSeconds: 300 },
  );
  const reopened = new LedgerStore(directory, runId);
  expect((await reopened.read()).connection).toEqual({
    target: "fixture-app",
    region: "us",
    timeoutSeconds: 300,
  });
});

test("admission preserves known saved Daytona routing and still rejects unresolved or malformed custody", async () => {
  const previous = await ledger();

  const connection = {
    target: "us",
    snapshotId: "fixture-snapshot",
    ttlMinutes: 10 as const,
    restartAfterCapture: false,
  };

  await previous.update((value) => ({ ...value, connection, cleanup: "confirmed" }));
  const saved = await readFile(previous.path, "utf8");
  const next = new LedgerStore(join(previous.path, ".."), crypto.randomUUID());
  expect((await previous.read()).connection).toEqual(connection);
  await next.requirePreviousCleanup("daytona");
  expect(await readFile(previous.path, "utf8")).toBe(saved);

  await previous.update((value) => ({
    ...value,
    createIntent: true,
    createReference: reference,
    cleanup: "unresolved",
  }));
  await expect(next.requirePreviousCleanup("daytona")).rejects.toThrow("unresolved resources");

  for (const malformed of [
    { ...connection, ttlMinutes: 11 },
    { ...connection, unknown: true },
  ]) {
    await writeFile(previous.path, JSON.stringify({ ...JSON.parse(saved), connection: malformed }));
    await expect(next.requirePreviousCleanup("daytona")).rejects.toThrow();
  }
});

test("only latest live evidence is rendered; fixtures cannot make green cells", () => {
  const base = {
    schemaVersion: 1,
    provider: "daytona",
    scenario: "exec-argv",
    runCleanup: "confirmed",
    sdkCommit: "a".repeat(40),
    harnessCommit: "b".repeat(40),
    sdkVersion: "0.0.0",
    nativeVersion: "0.10.1",
    runtime: "Bun 1.3.14",
    platform: "macos-arm64",
    configuration: { imageClass: "prepared", network: "blocked", regionClass: "us" },
    evidenceRef: "evidence/daytona-1.json",
  };

  const report = parseReport({
    schemaVersion: 1,
    records: [
      { ...base, mode: "fixture", status: "passed", timestamp: "2026-09-25T00:00:00Z" },
      { ...base, mode: "live", status: "passed", timestamp: "2026-09-26T00:00:00Z" },
      { ...base, mode: "live", status: "failed", timestamp: "2026-09-27T00:00:00Z" },
    ],
  });

  expect(() =>
    parseReport({
      schemaVersion: 1,
      records: [{ ...report.records[1], harnessCommit: undefined }],
    }),
  ).toThrow("Live records require the exact harness commit");

  const profiles = parseReport({
    schemaVersion: 1,
    records: [
      {
        ...report.records[1],
        provider: "e2b",
        configuration: {
          ...base.configuration,
          templateClass: "public-base",
          authorityClass: "api-key",
        },
      },
      {
        ...report.records[2],
        provider: "e2b",
        configuration: {
          ...base.configuration,
          templateClass: "borrowed-template",
          authorityClass: "verified-team",
        },
      },
    ],
  });

  const distinct = renderLiveMatrix([profiles]);
  expect(distinct).toContain("public-base / api-key");
  expect(distinct).toContain("borrowed-template / verified-team");
  expect(distinct).toMatch(/\| passed\s+\| 2026-09-26/);
  expect(distinct).toMatch(/\| failed\s+\| 2026-09-27/);
  expect(() =>
    parseReport({ schemaVersion: 1, records: [{ ...report.records[1], provider: "e2b" }] }),
  ).toThrow("E2B live records require template and authority classes");

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

  const offsets = parseReport({
    schemaVersion: 1,
    records: [
      { ...base, mode: "live", status: "passed", timestamp: "2026-09-27T00:00:00+02:00" },
      { ...base, mode: "live", status: "failed", timestamp: "2026-09-26T23:00:00Z" },
    ],
  });

  expect(renderLiveMatrix([offsets])).toMatch(/\| failed\s+\| 2026-09-26/);

  const sameInstant = parseReport({
    schemaVersion: 1,
    records: [
      {
        ...base,
        mode: "live",
        status: "failed",
        runCleanup: "incomplete",
        timestamp: "2026-09-27T00:00:00Z",
      },
      {
        ...base,
        mode: "live",
        status: "passed",
        runCleanup: "confirmed",
        timestamp: "2026-09-27T00:00:00Z",
      },
    ],
  });

  expect(renderLiveMatrix([sameInstant])).toMatch(/\| failed\s+\| 2026-09-27/);
});

test("home-directory file evidence cannot supersede a sticky-tmp failure", () => {
  const base = {
    schemaVersion: 1,
    provider: "e2b",
    scenario: "file-overwrite",
    mode: "live",
    runCleanup: "confirmed",
    sdkCommit: "a".repeat(40),
    harnessCommit: "b".repeat(40),
    sdkVersion: "0.0.0",
    nativeVersion: "e2b 2.51.0",
    runtime: "Bun 1.3.14",
    platform: "darwin-arm64",
    evidenceRef: "evidence/e2b-file-root.json",
    configuration: {
      imageClass: "prepared",
      templateClass: "public-base",
      authorityClass: "api-key",
      network: "blocked-requested",
      regionClass: "provider-default",
    },
  };

  const report = parseReport({
    schemaVersion: 1,
    records: [
      {
        ...base,
        status: "failed",
        timestamp: "2026-09-27T00:00:00Z",
        configuration: { ...base.configuration, fileRoot: "/tmp" },
      },
      {
        ...base,
        status: "passed",
        timestamp: "2026-09-28T00:00:00Z",
        configuration: { ...base.configuration, fileRoot: "/home/user" },
      },
    ],
  });

  const rows = renderLiveMatrix([report])
    .split("\n")
    .filter((row) => row.includes("file-overwrite"));

  expect(rows).toHaveLength(2);
  expect(rows.some((row) => row.includes("/tmp") && row.includes("failed"))).toBe(true);
  expect(rows.some((row) => row.includes("/home/user") && row.includes("passed"))).toBe(true);
});

test("directory admission serializes different providers and blocks same-provider unresolved resources", async () => {
  const previous = await ledger();
  const next = new LedgerStore(join(previous.path, ".."), crypto.randomUUID());
  await previous.withAdmissionLock(async () => {
    await expect(
      next.withAdmissionLock(() => next.requirePreviousCleanup("e2b")),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });
  await previous.update((value) => ({
    ...value,
    createIntent: true,
    createReference: reference,
    cleanup: "unresolved",
  }));
  await next.withAdmissionLock(async () => {
    await expect(next.requirePreviousCleanup("daytona")).rejects.toThrow("unresolved resources");
    await previous.update((value) => ({ ...value, cleanup: "confirmed" }));
    await next.requirePreviousCleanup("daytona");
  });
});

test("state reconciliation checkpoints update original custody without exhausting the mutation bound", async () => {
  const store = await ledger();
  await store.update((value) => ({
    ...value,
    stateMutations: [{ role: "snapshot/capture", reference, creation: true, cleanup: "pending" }],
  }));

  for (let stage = 0; stage < 70; stage++)
    await store.saveStateReference({ ...reference, tokenVersion: 1, token: { stage } });
  const state = await store.read();

  expect(state.stateMutations).toHaveLength(1);
  expect(state.stateMutations?.[0]).toMatchObject({
    role: "snapshot/capture",
    creation: true,
    cleanup: "pending",
    reference: { token: { stage: 69 } },
  });
});

test("full legacy checkpoint ledger normalizes custody before recording new cleanup", async () => {
  const store = await ledger();
  await store.update((value) => ({
    ...value,
    stateMutations: Array.from({ length: 64 }, (_, stage) => ({
      role: stage === 0 ? "snapshot/capture" : "reconcile/delete",
      reference: { ...reference, token: { stage } },
      creation: stage === 0,
      cleanup: stage === 0 ? "pending" : "not-required",
      sandboxId: "original",
    })),
  }));
  await store.saveStateReference({ ...reference, token: { stage: 64 } });
  await store.saveStateReference({
    ...reference,
    kind: "destroy",
    operationId: "delete-op",
    submissionId: "delete-sub",
    invocationKey: "delete-inv",
    sandboxId: "original",
  });
  const state = await store.read();

  expect(state.stateMutations).toHaveLength(2);
  expect(state.stateMutations?.[0]).toMatchObject({
    role: "snapshot/capture",
    creation: true,
    cleanup: "pending",
    sandboxId: "original",
    reference: { token: { stage: 64 } },
  });
  expect(state.stateMutations?.[1]).toMatchObject({
    creation: false,
    reference: { kind: "destroy" },
  });
  await expect(store.saveStateReference({ ...reference, provider: "e2b" })).rejects.toThrow(
    "identity conflicts",
  );
  await expect(
    store.saveStateReference({
      ...reference,
      scope: { authority: { kind: "app", id: "foreign" }, partition: {} },
    }),
  ).rejects.toThrow("identity conflicts");
  expect((await store.read()).stateMutations).toHaveLength(2);
});

test("baseline observation checkpoints do not grow the bounded operation inventory", async () => {
  const store = await ledger();
  const exec = { ...reference, kind: "exec" as const, sandboxId: "original" };
  await store.update((value) => ({
    ...value,
    operationReferences: Array.from({ length: 32 }, () => exec),
  }));

  for (let stage = 0; stage < 70; stage++)
    await recordReference(store, { ...exec, token: { stage } });
  await recordReference(store, {
    ...exec,
    operationId: "second-op",
    submissionId: "second-sub",
    invocationKey: "second-inv",
  });
  const state = await store.read();

  expect(state.operationReferences).toHaveLength(2);
  expect(state.operationReferences?.[0]).toMatchObject({ token: { stage: 69 } });
});

test("identified unresolved E2B volume permits Daytona without altering E2B custody", async () => {
  const previous = await ledger();
  await previous.update((value) => ({
    ...value,
    provider: "e2b",
    cleanup: "unresolved",
    stateMutations: [
      {
        role: "volume/create",
        reference: { ...reference, provider: "e2b", kind: "volume_create" },
        creation: true,
        cleanup: "pending",
      },
    ],
  }));
  const before = await readFile(previous.path, "utf8");
  const next = new LedgerStore(join(previous.path, ".."), crypto.randomUUID());
  await next.withAdmissionLock(async () => {
    await next.requirePreviousCleanup("daytona");
    await expect(next.requirePreviousCleanup("e2b")).rejects.toThrow("unresolved resources");
  });
  expect(await readFile(previous.path, "utf8")).toBe(before);
});

test("cross-provider admission rejects missing, malformed and conflicting custody identity", async () => {
  const previous = await ledger();
  const next = new LedgerStore(join(previous.path, ".."), crypto.randomUUID());

  for (const pendingReference of [
    {},
    { ...reference, provider: undefined },
    { ...reference, provider: "daytona" },
    { ...reference, provider: "e2b", scope: undefined },
    { ...reference, provider: "e2b", version: -1 },
    { ...reference, provider: "e2b", version: 1 },
    { ...reference, provider: "e2b", kind: "" },
    { ...reference, provider: "e2b", kind: "exec" },
    { ...reference, provider: "e2b", operationId: "" },
    { ...reference, provider: "e2b", submissionId: "" },
    { ...reference, provider: "e2b", invocationKey: "" },
    { ...reference, provider: "e2b", operationId: "x".repeat(129) },
    { ...reference, provider: "e2b", tokenVersion: 0 },
  ]) {
    await previous.update((value) => ({
      ...value,
      provider: "e2b",
      stateMutations: [
        {
          role: "volume/create",
          reference: pendingReference,
          creation: true,
          cleanup: "pending",
        },
      ],
      cleanup: "unresolved",
    }));
    await expect(next.requirePreviousCleanup("daytona")).rejects.toThrow("unverified identity");
  }
});

test("cross-provider admission rejects conflicting retained resource identity", async () => {
  const previous = await ledger();
  const next = new LedgerStore(join(previous.path, ".."), crypto.randomUUID());
  await previous.update((value) => ({
    ...value,
    provider: "e2b",
    cleanup: "unresolved",
    stateMutations: [
      {
        role: "volume/create",
        reference: { ...reference, provider: "e2b", kind: "volume_create" },
        resource: {
          version: 1,
          kind: "volume",
          provider: "daytona",
          scope: reference.scope,
          nativeId: "fixture-volume",
          ownership: "verified-created",
        },
        creation: true,
        cleanup: "pending",
      },
    ],
  }));
  await expect(next.requirePreviousCleanup("daytona")).rejects.toThrow("unverified identity");
});

test("unknown legacy ledger provider fails closed even for a different selected provider", async () => {
  const previous = await ledger();
  const next = new LedgerStore(join(previous.path, ".."), crypto.randomUUID());
  await previous.update((value) => ({
    ...value,
    createReference: reference,
    cleanup: "unresolved",
  }));
  // Simulate a historical record outside the maintained schema; never migrate away custody.
  const stored = JSON.parse(await readFile(previous.path, "utf8"));
  delete stored.provider;
  await writeFile(previous.path, JSON.stringify(stored));
  await expect(next.requirePreviousCleanup("e2b")).rejects.toThrow();
  expect(await readFile(previous.path, "utf8")).toBe(JSON.stringify(stored));
});

test("E2B zero-volume admission preserves isolated volume custody and blocks overlapping or unknown creators", async () => {
  const previous = await ledger();
  const next = new LedgerStore(join(previous.path, ".."), crypto.randomUUID());

  const pending = {
    role: "volume/create",
    reference: { ...reference, provider: "e2b", kind: "volume_create" },
    creation: true,
    cleanup: "pending" as const,
  };

  await previous.update((value) => ({
    ...value,
    provider: "e2b",
    cleanup: "unresolved",
    stateMutations: [pending],
  }));
  const before = await readFile(previous.path, "utf8");
  await next.withAdmissionLock(async () => {
    await next.requirePreviousCleanup("e2b", { volumes: 0 });
    await expect(next.requirePreviousCleanup("e2b", { volumes: 1 })).rejects.toThrow("unresolved");
    await expect(next.requirePreviousCleanup("e2b")).rejects.toThrow("unresolved");
  });
  expect(await readFile(previous.path, "utf8")).toBe(before);

  for (const extra of [
    { ...pending, reference: { ...reference, provider: "e2b", kind: "create" } },
    {
      ...pending,
      reference: { ...reference, provider: "e2b", kind: "snapshot_capture", sandboxId: "source" },
    },
    { ...pending, reference: {} },
    { ...pending, reference: { ...pending.reference, provider: "daytona" } },
    { ...pending, sandboxId: "possibly-attached" },
    { ...pending, reference: { ...pending.reference, sandboxId: "possibly-attached" } },
    {
      ...pending,
      resource: {
        version: 1,
        kind: "snapshot",
        provider: "e2b",
        scope: reference.scope,
        nativeId: "fixture",
        ownership: "verified-created",
      },
    },
  ]) {
    await previous.update((value) => ({ ...value, stateMutations: [pending, extra] }));
    await expect(next.requirePreviousCleanup("e2b", { volumes: 0 })).rejects.toThrow("unresolved");
  }
});
