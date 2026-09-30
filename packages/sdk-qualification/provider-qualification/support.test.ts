import { expect, test } from "bun:test";
import { networkProbeId, networkSampleSchema } from "./network-probe";
import { builtinSupport, renderSupportMatrix } from "./support";
import { renderLiveMatrix, parseReport, type QualificationRecord } from "./report";

function record(
  status: QualificationRecord["status"],
  mode: QualificationRecord["mode"] = "live",
): QualificationRecord {
  return {
    schemaVersion: 1,
    provider: "daytona",
    scenario: "build-oci",
    status,
    mode,
    runCleanup: "confirmed",
    sdkCommit: "a".repeat(40),
    harnessCommit: "b".repeat(40),
    sdkVersion: "0.0.0",
    nativeVersion: "fixture 1",
    runtime: "Bun 1.3.14",
    platform: "fixture",
    timestamp: "2026-09-29T00:00:00Z",
    configuration: { imageClass: "oci", network: "blocked-requested", regionClass: "fixture" },
    evidenceRef: "https://github.com/pandemicsyn/sandbar/pull/25",
  };
}

function render(records: QualificationRecord[]) {
  return renderSupportMatrix([parseReport({ schemaVersion: 1, records })]);
}

for (const status of ["passed", "failed", "blocked", "not-run"] as const) {
  test(`support and ${status} validation remain separate`, () => {
    expect(render([record(status)])).toContain(
      `Conditional · ${status}${status === "passed" ? " at aaaaaaaa" : ""}`,
    );
  });
}

test("missing, fixture and packed observations never manufacture live passes", () => {
  expect(render([record("passed", "fixture"), record("passed", "packed")])).toContain(
    "Conditional · not-run",
  );
  expect(render([])).toContain("Unsupported · not-run");
});

test("later failure and equal-time failure supersede a prior pass for the same configuration", () => {
  const pass = record("passed");
  expect(render([pass, { ...pass, status: "failed" }])).toContain("Conditional · failed");
  expect(
    render([pass, { ...pass, status: "blocked", timestamp: "2026-09-29T01:00:00Z" }]),
  ).toContain("Conditional · blocked");
});

test("incomplete cleanup cannot produce a successful feature cell", () => {
  expect(render([{ ...record("passed"), runCleanup: "incomplete" }])).toContain(
    "Conditional · blocked",
  );
});

test("feature groups do not combine assertions from different source revisions", () => {
  const base = record("passed");

  // SAFETY: These three literals are maintained execution scenario IDs.
  const records: QualificationRecord[] = ["exec-argv", "exec-shell", "exec-nonzero"].map(
    (scenario, index) => ({
      ...base,
      scenario: scenario as QualificationRecord["scenario"],
      sdkCommit: String(index + 1).repeat(40),
    }),
  );

  expect(render(records)).toContain("Supported · not-run");
});

test("external declared metadata renders with the same feature groups and report schema", () => {
  const metadata = { ...builtinSupport[0]!, id: "external.fixture", name: "External fixture" };

  const html = renderSupportMatrix(
    [
      parseReport({
        schemaVersion: 1,
        records: [{ ...record("passed"), provider: "external.fixture" }],
      }),
    ],
    [metadata],
  );

  expect(html).toContain("External fixture");
  expect(
    renderLiveMatrix([
      parseReport({
        schemaVersion: 1,
        records: [{ ...record("passed"), provider: "external.fixture" }],
      }),
    ]),
  ).toContain("## external.fixture");
  expect(html).toContain("Conditional · passed at aaaaaaaa");
});

test("historical unknown custody and later no-effect denial remain distinct evidence", () => {
  const report = parseReport({
    schemaVersion: 1,
    records: [],
    historicalEvidence: [
      {
        provider: "e2b",
        scenario: "volume-crud",
        sourceRevision: "5db0558",
        status: "failed",
        cleanup: "incomplete",
        configuration: "Unacknowledged native create",
        attribution: "No inventory match does not prove no effect",
        evidenceRef: "https://github.com/pandemicsyn/sandbar/pull/25",
      },
      {
        provider: "e2b",
        scenario: "volume-crud",
        sourceRevision: "working-tree-before-dfc34b6",
        status: "blocked",
        cleanup: "not-required",
        configuration: "Native 403",
        attribution: "Separate no-effect rejection",
        evidenceRef: "https://github.com/pandemicsyn/sandbar/pull/25",
      },
    ],
  });

  expect(report.historicalEvidence).toHaveLength(2);
  expect(renderSupportMatrix([report])).toContain(
    "Unsupported · blocked at working-tree-before-dfc34b6",
  );
});

test("paired network results aggregate across their deliberately different requested policies", () => {
  const sample = (phase: "before" | "blocked" | "after") =>
    networkSampleSchema.parse({
      phase,
      attempts: (["hostname", "ipv4"] as const).map((target) =>
        phase === "blocked"
          ? { target, connected: false, error: "timeout" as const }
          : { target, connected: true },
      ),
    });

  const base = record("passed");

  const records: QualificationRecord[] = (["network-internet", "network-blocked"] as const).map(
    (scenario) => ({
      ...base,
      scenario,
      configuration: {
        ...base.configuration,
        imageClass: "prepared",
        network: scenario === "network-internet" ? "internet-requested" : "blocked-requested",
        networkProbe: networkProbeId,
      },
      networkEvidence: {
        probe: networkProbeId,
        samples: [sample("before"), sample("blocked"), sample("after")],
      },
    }),
  );

  expect(render(records)).toContain("Conditional · passed at aaaaaaaa");
  expect(
    render([records[0]!, { ...records[1]!, status: "failed", timestamp: "2026-09-29T01:00:00Z" }]),
  ).toContain("Conditional · failed");
});

for (const [workflow, feature, operations] of [
  [
    "sandbox-lifecycle",
    "lifecycle",
    ["connect", "create-prepared", "inspect", "inventory", "destroy", "confirm-cleanup", "close"],
  ],
  ["execution", "execution", ["exec-argv", "exec-shell", "exec-nonzero"]],
  ["files", "files", ["file-binary", "file-overwrite", "file-no-clobber"]],
  ["network-controls", "network", ["network-internet", "network-blocked"]],
] as const) {
  test(`${workflow} result supersedes legacy feature evidence without relabeling individual operations`, () => {
    const legacy: QualificationRecord[] = operations.map((scenario) => ({
      ...record("passed"),
      scenario,
      runner: { name: "bun:test", format: "junit", testName: scenario },
    }));

    const failed: QualificationRecord = {
      ...record("failed"),
      scenario: workflow,
      timestamp: "2026-09-30T00:00:00Z",
      runner: { name: "bun:test", format: "junit", testName: workflow },
    };

    const report = parseReport({ schemaVersion: 1, records: [...legacy, failed] });
    expect(renderSupportMatrix([report])).toContain(`· failed](#daytona-${feature})`);
    expect(
      report.records
        .filter((item) => item.scenario !== workflow)
        .every((item) => item.status === "passed"),
    ).toBe(true);
    const details = renderLiveMatrix([report]);

    for (const operation of operations) expect(details).toContain(operation);
    expect(details).toContain(`${workflow}`);
    expect(
      render([
        ...legacy,
        failed,
        { ...failed, status: "passed", timestamp: "2026-09-30T01:00:00Z" },
      ]),
    ).toContain(`· passed at aaaaaaaa](#daytona-${feature})`);
    expect(render([{ ...failed, status: "passed", mode: "fixture" }])).toContain(
      `· not-run](#daytona-${feature})`,
    );
    expect(() =>
      parseReport({ schemaVersion: 1, records: [{ ...failed, runner: undefined }] }),
    ).toThrow("Grouped workflow outcomes require a Bun testcase");
  });
}
