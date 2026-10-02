import { expect, test } from "bun:test";
import { storageFixture, startupReport, checkStartup } from "./storage-composition.test";

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
