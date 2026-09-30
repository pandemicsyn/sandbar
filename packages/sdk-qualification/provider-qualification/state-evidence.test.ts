import { expect, test } from "bun:test";
import { assertStateEvidence } from "./state-evidence";
import { parseReport, renderLiveMatrix } from "./report";

test("RAM certification requires process observations and confirmed storage teardown", () => {
  const fs = {
    probe: "snapshot-roundtrip-v3" as const,
    preserve: "filesystem" as const,
    captureMode: "native-default" as const,
    restoreExecution: "fresh" as const,
    sourceProcesses: "ended" as const,
    freshExecution: "verified-missing-guest-process" as const,
    sourceState: "running" as const,
    capturedBytes: true as const,
    newIdentity: true as const,
    metadataInspected: true as const,
    serializedReferenceReopened: true as const,
    freshConnectionAfterSourceDeletion: true as const,
    restoredWriteIndependent: true as const,
    sourceWriteIndependent: true,
    secondRestoreOriginalBytes: true as const,
    memory: "not-applicable" as const,
    ownedArtifactDeleted: true as const,
  };

  expect(() =>
    assertStateEvidence("snapshot-roundtrip", { ...fs, preserve: "filesystem+memory" }),
  ).toThrow("observable independent memory");

  expect(() =>
    assertStateEvidence("snapshot-roundtrip", { ...fs, sourceWriteIndependent: false }),
  ).toThrow("two-way filesystem write isolation");
  expect(() =>
    assertStateEvidence("snapshot-roundtrip", { ...fs, sourceState: "stopped" }),
  ).toThrow("two-way filesystem write isolation");

  const record = {
    schemaVersion: 1,
    provider: "daytona",
    scenario: "snapshot-roundtrip",
    mode: "live",
    status: "passed",
    sdkCommit: "a".repeat(40),
    harnessCommit: "a".repeat(40),
    sdkVersion: "0.1.0",
    nativeVersion: "fixture",
    runtime: "bun 1.3.14",
    platform: "macos",
    timestamp: "2026-09-28T00:00:00Z",
    configuration: {
      imageClass: "prepared",
      network: "blocked-requested",
      regionClass: "fixture",
      stateProbe: "snapshot-roundtrip-v3",
      preserve: "filesystem",
      restoreExecution: "fresh",
      sourceAfter: "running",
    },
    stateEvidence: fs,
    evidenceRef: "fixture/state",
    runCleanup: "confirmed",
  };

  expect(() =>
    parseReport({ schemaVersion: 1, records: [{ ...record, runCleanup: "incomplete" }] }),
  ).toThrow("confirmed resource teardown");
  expect(() =>
    parseReport({
      schemaVersion: 1,
      records: [
        { ...record, configuration: { ...record.configuration, preserve: "filesystem+memory" } },
      ],
    }),
  ).toThrow("preservation differs");
  expect(renderLiveMatrix([parseReport({ schemaVersion: 1, records: [record] })])).toContain(
    "snapshot-roundtrip",
  );
});
