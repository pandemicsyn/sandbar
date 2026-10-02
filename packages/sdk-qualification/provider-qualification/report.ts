import { z } from "zod";
import { stateEvidence, assertStateEvidence } from "./state-evidence";
import { envdSchema, failureDiagnosticSchema } from "./diagnostics";
import {
  networkEvidenceSchema,
  networkProbeId,
  requireBlocked,
  requireInternet,
} from "./network-probe";

export const scenarios = [
  "sandbox-lifecycle",
  "lifecycle-reopen",
  "lifecycle-renew",
  "lifecycle-suspend-resume",
  "preview-protected",
  "preview-public",
  "execution",
  "execution-streaming",
  "files",
  "file-directories",
  "network-controls",
  "connect",
  "create-prepared",
  "inspect",
  "exec-argv",
  "exec-shell",
  "exec-nonzero",
  "file-binary",
  "file-overwrite",
  "file-no-clobber",
  "inventory",
  "destroy",
  "confirm-cleanup",
  "close",
  "build-oci",
  "network-internet",
  "network-blocked",
  "snapshot-roundtrip",
  "volume-persistence",
  "volume-crud",
] as const;

const safeLabel = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_.: /-]+$/);

const evidence = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[a-zA-Z0-9_.:/#-]+$/);

export const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runner: z
    .strictObject({
      name: z.literal("bun:test"),
      format: z.literal("junit"),
      testName: z.string().min(1).max(160),
    })
    .optional(),
  provider: z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/),
  scenario: z.enum(scenarios),
  mode: z.enum(["live", "fixture", "packed"]),
  status: z.enum(["passed", "failed", "not-run", "unsupported", "blocked"]),
  runCleanup: z.enum(["confirmed", "incomplete", "not-required"]).optional(),
  sdkCommit: z.string().regex(/^[0-9a-f]{40}$/),
  harnessCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  sdkVersion: safeLabel,
  nativeVersion: safeLabel.optional(),
  envd: envdSchema.optional(),
  diagnostic: failureDiagnosticSchema.optional(),
  networkEvidence: networkEvidenceSchema.optional(),
  stateEvidence: stateEvidence.optional(),
  runtime: safeLabel,
  platform: safeLabel,
  timestamp: z.iso.datetime({ offset: true }),
  configuration: z.strictObject({
    imageClass: z.enum(["prepared", "oci", "none"]),
    fileRoot: z.enum(["/tmp", "/home/user"]).optional(),
    templateClass: z.enum(["public-base", "borrowed-template", "borrowed-snapshot"]).optional(),
    authorityClass: z.enum(["api-key", "verified-team", "verified-organization"]).optional(),
    network: safeLabel,
    networkProbe: z.literal(networkProbeId).optional(),
    restoreExecution: z.enum(["fresh", "resume"]).optional(),
    sourceAfter: z.enum(["running", "stopped"]).optional(),
    stateProbe: z
      .enum(["snapshot-roundtrip-v3", "volume-persistence-v1", "volume-crud-v1"])
      .optional(),
    preserve: z.enum(["filesystem", "filesystem+memory"]).optional(),
    freshProcess: z.boolean().optional(),
    volumeOwnership: z.enum(["created", "borrowed"]).optional(),
    regionClass: safeLabel,
  }),
  evidenceRef: evidence.optional(),
  issue: z
    .enum([
      "missing-credentials",
      "not-authorized",
      "not-selected",
      "dependency-failed",
      "unsupported-capability",
      "assertion-failed",
      "outcome-unknown",
      "cleanup-unconfirmed",
      "interrupted",
    ])
    .optional(),
});

export const historicalEvidenceSchema = z.strictObject({
  provider: z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/),
  scenario: z.enum(["snapshot-roundtrip", "volume-crud", "volume-persistence"]),
  sourceRevision: z
    .string()
    .min(7)
    .max(80)
    .regex(/^[a-zA-Z0-9-]+$/),
  status: z.enum(["passed", "failed", "blocked"]),
  cleanup: z.enum(["confirmed", "incomplete", "not-required"]),
  configuration: z.string().min(1).max(500),
  attribution: z.string().min(1).max(1200),
  evidenceRef: evidence,
});

export type HistoricalEvidence = z.infer<typeof historicalEvidenceSchema>;

export const reportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    records: z.array(recordSchema).max(1000),
    historicalEvidence: z.array(historicalEvidenceSchema).max(100).optional(),
  })
  .superRefine((report, ctx) => {
    for (const [index, record] of report.records.entries()) {
      if (
        [
          "sandbox-lifecycle",
          "execution",
          "execution-streaming",
          "files",
          "file-directories",
          "network-controls",
        ].includes(record.scenario) &&
        !record.runner
      )
        ctx.addIssue({
          code: "custom",
          path: ["records", index, "runner"],
          message: "Grouped workflow outcomes require a Bun testcase",
        });

      if (
        ["snapshot-roundtrip", "volume-persistence", "volume-crud"].includes(record.scenario) &&
        record.status === "passed" &&
        !record.runner
      ) {
        try {
          if (!record.stateEvidence)
            throw new Error("State passes require explicit workflow observations");
          assertStateEvidence(record.scenario, record.stateEvidence);

          if (record.configuration.stateProbe !== record.stateEvidence.probe)
            throw new Error("State evidence must match its intended probe");

          if (
            record.stateEvidence.probe === "snapshot-roundtrip-v3" &&
            (record.configuration.preserve !== record.stateEvidence.preserve ||
              record.configuration.restoreExecution !== record.stateEvidence.restoreExecution ||
              record.configuration.sourceAfter !== record.stateEvidence.sourceState)
          )
            throw new Error("Snapshot evidence preservation differs from requested configuration");

          if (
            record.stateEvidence.probe === "volume-persistence-v1" &&
            record.configuration.volumeOwnership !== record.stateEvidence.ownership
          )
            throw new Error("Volume evidence ownership differs from requested configuration");

          if (
            record.configuration.freshProcess &&
            (record.stateEvidence.probe !== "snapshot-roundtrip-v3" ||
              !record.stateEvidence.freshProcessReopened)
          )
            throw new Error(
              "Fresh-process qualification requires an independent reopen observation",
            );

          if (record.runCleanup !== "confirmed")
            throw new Error("State passes require independent confirmed resource teardown");
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            path: ["records", index, "stateEvidence"],
            message: error instanceof Error ? error.message : "Invalid state evidence",
          });
        }
      }

      if (record.runner && record.status === "passed" && record.runCleanup !== "confirmed")
        ctx.addIssue({
          code: "custom",
          path: ["records", index, "runCleanup"],
          message: "Bun passes require confirmed test-owned cleanup",
        });

      if (record.status === "passed" && record.scenario.startsWith("network-") && !record.runner) {
        try {
          const samples = record.networkEvidence?.samples;

          if (
            !samples ||
            samples.map((sample) => sample.phase).join(",") !== "before,blocked,after"
          )
            throw new Error("Network passes require the paired before/blocked/after observations");
          requireInternet(samples[0]!);
          requireInternet(samples[2]!);

          if (
            record.configuration.networkProbe &&
            record.configuration.networkProbe !== record.networkEvidence?.probe
          )
            throw new Error("Network evidence does not match the intended probe");

          if (record.scenario === "network-blocked") requireBlocked(samples[1]!);

          const expected =
            record.scenario === "network-blocked" ? "blocked-requested" : "internet-requested";

          if (record.configuration.network !== expected)
            throw new Error("Network scenario policy mismatch");
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            path: ["records", index, "networkEvidence"],
            message: error instanceof Error ? error.message : "Invalid network evidence",
          });
        }
      }

      if (
        record.mode === "live" &&
        record.provider === "e2b" &&
        (!record.configuration.templateClass || !record.configuration.authorityClass)
      )
        ctx.addIssue({
          code: "custom",
          path: ["records", index, "configuration"],
          message: "E2B live records require template and authority classes",
        });

      if (record.mode === "live" && !record.evidenceRef)
        ctx.addIssue({
          code: "custom",
          path: ["records", index, "evidenceRef"],
          message: "Live records require evidence",
        });

      if (record.mode === "live" && !record.harnessCommit)
        ctx.addIssue({
          code: "custom",
          path: ["records", index, "harnessCommit"],
          message: "Live records require the exact harness commit",
        });

      if (record.mode === "live" && !record.nativeVersion)
        ctx.addIssue({
          code: "custom",
          path: ["records", index, "nativeVersion"],
          message: "Live records require the pinned native version",
        });

      if (record.mode === "live" && !record.runCleanup)
        ctx.addIssue({
          code: "custom",
          path: ["records", index, "runCleanup"],
          message: "Live records require cleanup state",
        });
    }
  });

export type QualificationRecord = z.infer<typeof recordSchema>;

export type QualificationReport = z.infer<typeof reportSchema>;

export type Scenario = QualificationRecord["scenario"];

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON artifact boundary parsed immediately by reportSchema.
export function parseReport(value: unknown): QualificationReport {
  return reportSchema.parse(value);
}

function key(record: QualificationRecord): string {
  return [
    record.provider,
    record.scenario,
    record.configuration.imageClass,
    record.configuration.templateClass ?? "unspecified",
    record.configuration.authorityClass ?? "unspecified",
    record.configuration.network,
    record.configuration.regionClass,
    record.scenario.startsWith("network-")
      ? (record.configuration.networkProbe ?? record.networkEvidence?.probe ?? "not-recorded")
      : "—",
    record.scenario === "files" || record.scenario.startsWith("file-")
      ? (record.configuration.fileRoot ?? "not-recorded")
      : "—",
    record.configuration.stateProbe ?? "—",
    record.configuration.restoreExecution ?? "—",
    record.configuration.sourceAfter ?? "—",
    record.configuration.preserve ?? "—",
    record.configuration.volumeOwnership ?? "—",
    record.configuration.freshProcess === undefined
      ? "not-recorded"
      : String(record.configuration.freshProcess),
    record.runtime,
    record.platform,
  ].join("|");
}

export function markdownTable(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, index) =>
    Math.max(3, cell.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );

  const line = (row: string[]) =>
    `| ${row.map((cell, index) => cell.padEnd(widths[index]!)).join(" | ")} |`;

  return [
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...rows.map(line),
  ];
}

export function renderLiveMatrix(
  reports: readonly QualificationReport[],
  providerNames: Readonly<Record<string, string>> = { e2b: "E2B", daytona: "Daytona" },
): string {
  const latest = new Map<string, QualificationRecord>();

  for (const report of reports)
    for (const record of parseReport(report).records) {
      if (record.mode !== "live") continue;
      const id = key(record);
      const previous = latest.get(id);

      if (
        !previous ||
        Date.parse(record.timestamp) > Date.parse(previous.timestamp) ||
        (Date.parse(record.timestamp) === Date.parse(previous.timestamp) &&
          ((previous.status === "passed" && record.status !== "passed") ||
            (previous.status === record.status &&
              previous.runCleanup === "incomplete" &&
              record.runCleanup === "confirmed")))
      )
        latest.set(id, record);
    }

  const rows = [...latest.values()].sort((a, b) => key(a).localeCompare(key(b)));

  const lines = [
    "---",
    "title: Live test evidence",
    "description: Dated evidence for tested provider operations and configurations.",
    "---",
    "",
    "<!-- Generated by provider-qualification/render.ts; do not edit by hand. -->",
    "",
    "For the concise overview, see [Tested provider support](/docs/providers/support/). These records report measured operations and their exact configurations; distribution status is not a live pass.",
    "",
    "These results cover only the stated image, requested network policy and region classes. A blocked-requested policy is a create setting, not a measured egress-isolation result. Fixture and packed tests do not establish live provider behavior. A later failure supersedes an earlier pass for the same configuration.",
    "",
    "Grouped Bun cases report one workflow outcome. They do not assign failures to individual operations; separately observed operation results retain their original dates and provenance.",
    "",
    "Only explicit network scenario evidence measures egress: the paired probe covers TCP by hostname and direct IPv4 with live positive controls. It does not certify UDP, IPv6, ingress or universal isolation. Snapshot and volume workflows have separate explicit observations and retained-storage teardown. Prepared-image creation does not qualify either feature. New workflows remain not-run until reviewed revision-specific evidence is published.",
    "",
  ];

  // Keep each run configuration together so the article fits a readable width
  // without dropping provenance or mixing evidence from different SDK revisions.
  const groups = new Map<string, QualificationRecord[]>();

  for (const record of rows) {
    const groupKey = JSON.stringify([
      record.provider,
      record.configuration,
      record.sdkCommit,
      record.harnessCommit,
      record.sdkVersion,
      record.nativeVersion,
      record.runtime,
      record.platform,
      record.evidenceRef,
    ]);

    const group = groups.get(groupKey) ?? [];
    group.push(record);
    groups.set(groupKey, group);
  }

  const ordered = [...groups.values()].sort(
    (a, b) =>
      a[0]!.provider.localeCompare(b[0]!.provider) ||
      Date.parse(b[0]!.timestamp) - Date.parse(a[0]!.timestamp),
  );

  let provider: string | undefined;

  for (const group of ordered) {
    const record = group[0]!;
    const config = record.configuration;

    if (provider !== record.provider) {
      provider = record.provider;
      lines.push(`## ${providerNames[provider] ?? provider}`, "");
    }

    lines.push(
      `### ${config.network} · ${config.regionClass} · ${config.fileRoot ?? "file root not recorded"}`,
      "",
      `- Image / authority: ${config.imageClass}; ${config.templateClass ?? "unspecified"} / ${config.authorityClass ?? "unspecified"}.`,
      `- Runtime: ${record.runtime}, ${record.platform}. Native interface: ${record.nativeVersion ?? "not recorded"}.`,
      `- SDK: ${record.sdkVersion}, commit \`${record.sdkCommit}\`.`,
      `- Fresh-process reopen: ${config.freshProcess === undefined ? "not recorded" : config.freshProcess ? "required" : "not selected"}.`,
      `- Harness commit: \`${record.harnessCommit}\`.`,
      `- Evidence: ${record.evidenceRef ? `[reviewed record](${record.evidenceRef})` : "not recorded"}.`,
      "",
      ...markdownTable(
        ["Scenario", "Latest live result", "Date"],
        group.map((item) => [
          item.scenario === "files" || item.scenario.startsWith("file-")
            ? `${item.scenario} (${item.configuration.fileRoot ?? "file root not recorded"})`
            : item.scenario.startsWith("network-")
              ? `${item.scenario} (${item.configuration.network} / ${item.configuration.networkProbe ?? item.networkEvidence?.probe ?? "probe not recorded"})`
              : item.scenario,
          item.runCleanup === "incomplete" && item.status === "passed"
            ? "incomplete (scenario passed)"
            : item.status,
          new Date(item.timestamp).toISOString().slice(0, 10),
        ]),
      ),
      "",
    );
  }

  const historical = reports.flatMap((report) => parseReport(report).historicalEvidence ?? []);

  if (historical.length) {
    lines.push(
      "## Historical state acceptance",
      "",
      "These reviewed summaries retain their original source/configuration attribution. Missing dates and runtime fields were not reconstructed. They are not current-head runs. Fresh connection is distinct from a fresh OS process.",
      "",
    );

    for (const item of historical)
      lines.push(
        `### ${item.provider} · ${item.scenario} · ${item.sourceRevision}`,
        "",
        `Result: **${item.status}**; cleanup: **${item.cleanup}**.`,
        "",
        `Configuration: ${item.configuration}`,
        "",
        item.attribution,
        "",
        `Evidence: [reviewed PR record](${item.evidenceRef}).`,
        "",
      );
  }

  if (!ordered.length && !historical.length) lines.push("No live evidence recorded", "");
  lines.push(
    "A missing row means no validated live result is recorded. Unsupported and blocked operations are not passes.",
    "",
  );

  return lines.join("\n");
}

export function publicIssue(value: string | undefined) {
  if (!value) return undefined;

  if (value === "OUTCOME_UNKNOWN") return "outcome-unknown";

  if (value === "UNSUPPORTED") return "unsupported-capability";

  if (
    value === "outcome-unknown" ||
    value === "cleanup-unconfirmed" ||
    value === "interrupted" ||
    value === "dependency-failed" ||
    value === "not-selected"
  )
    return value;

  if (value === "WAIT_ABORTED" || value === "TIMEOUT") return "interrupted";

  return "assertion-failed";
}
