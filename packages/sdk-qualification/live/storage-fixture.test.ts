import { expect, test } from "bun:test";
import { SandbarError } from "sandbar-sdk";
import {
  storageFixture,
  startupReport,
  checkStartup,
  readPublishedReport,
} from "./storage-composition.test";

const report = {
  sandboxId: "current",
  nonce: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  marker: "a",
  dataHash: "hash",
  privateState: "v1" as const,
  policy: "daytona-default" as const,
  firstAttempt: true as const,
  applicationStarted: true as const,
};

const expected = {
  sandboxId: "current",
  runId: report.runId,
  marker: "a",
  dataHash: "hash",
  priorNonces: [],
};

test("startup evidence cannot pass for stale compute, wrong selected profile", () => {
  checkStartup(startupReport.parse(report), expected);

  for (const changed of [
    { ...report, sandboxId: "source" },
    { ...report, marker: "b", dataHash: null },
    { ...report, runId: "33333333-3333-4333-8333-333333333333" },
  ])
    expect(() => checkStartup(startupReport.parse(changed), expected)).toThrow();
  expect(() =>
    checkStartup(startupReport.parse(report), { ...expected, priorNonces: [report.nonce] }),
  ).toThrow();

  for (const changed of [
    { ...report, firstAttempt: false },
    { ...report, applicationStarted: false },
    { ...report, policy: "blocked" },
  ])
    expect(startupReport.safeParse(changed).success).toBe(false);
});

test("report publication can lag Toolbox without retrying its evidence", async () => {
  let reads = 0;
  const published = JSON.stringify(report);

  const raw = await readPublishedReport(async () => {
    if (++reads === 1) throw new SandbarError("NOT_FOUND", "Not published");

    return published;
  }, new AbortController().signal);

  expect(reads).toBe(2);
  expect(raw).toBe(published);
  checkStartup(startupReport.parse(JSON.parse(raw)), expected);

  reads = 0;

  const wrong = await readPublishedReport(async () => {
    reads++;

    return JSON.stringify({ ...report, marker: "wrong" });
  }, new AbortController().signal);

  expect(() => checkStartup(startupReport.parse(JSON.parse(wrong)), expected)).toThrow();
  expect(reads).toBe(1);
});

test("publication waits are finite and never retry other read failures", async () => {
  let reads = 0;

  await expect(
    readPublishedReport(async () => {
      reads++;
      throw new SandbarError("NOT_FOUND", "Not published");
    }, new AbortController().signal),
  ).rejects.toThrow();
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThanOrEqual(20);

  reads = 0;
  await expect(
    readPublishedReport(async () => {
      reads++;
      throw new SandbarError("INVALID_RESPONSE", "Read failed");
    }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  expect(reads).toBe(1);
}, 7000);

test("fixture prerequisite refuses oversized defaults, missing sentinel", () => {
  const fixture = {
    imageId: "provided",
    firstActionSentinel: true,
    vcpu: 1,
    memoryMiB: 1024,
    diskMiB: 3072,
  };

  expect(storageFixture.safeParse(fixture).success).toBe(true);

  for (const changed of [
    { ...fixture, vcpu: 3 },
    { ...fixture, memoryMiB: 4097 },
    { ...fixture, diskMiB: 10241 },
    { ...fixture, firstActionSentinel: false },
  ])
    expect(storageFixture.safeParse(changed).success).toBe(false);
});
