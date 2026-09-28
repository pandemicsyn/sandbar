import { z } from "zod";
import { envdSchema, failureDiagnosticSchema } from "./diagnostics";
import {
  networkEvidenceSchema,
  networkProbeId,
  requireBlocked,
  requireInternet,
} from "./network-probe";

export const scenarios = [
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
  provider: z.enum(["daytona", "e2b"]),
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

export const reportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    records: z.array(recordSchema).max(1000),
  })
  .superRefine((report, ctx) => {
    for (const [index, record] of report.records.entries()) {
      if (record.scenario === "snapshot-roundtrip" && record.status === "passed")
        ctx.addIssue({
          code: "custom",
          path: ["records", index, "status"],
          message: "Snapshot capture/restore is unavailable in the current public SDK",
        });

      if (record.status === "passed" && record.scenario.startsWith("network-")) {
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the JSON artifact boundary; reportSchema parses it immediately.
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
    record.scenario.startsWith("file-") ? (record.configuration.fileRoot ?? "not-recorded") : "—",
    record.runtime,
    record.platform,
  ].join("|");
}

function markdownTable(header: string[], rows: string[][]): string[] {
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

export function renderLiveMatrix(reports: readonly QualificationReport[]): string {
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
    "Only explicit network scenario evidence measures egress: the paired probe covers TCP by hostname and direct IPv4 with live positive controls. It does not certify UDP, IPv6, ingress or universal isolation. Snapshot capture/restore is unsupported by the current public SDK; a prepared-image create is not snapshot qualification.",
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
      lines.push(`## ${provider === "e2b" ? "E2B" : "Daytona"}`, "");
    }

    lines.push(
      `### ${config.network} · ${config.regionClass} · ${config.fileRoot ?? "file root not recorded"}`,
      "",
      `- Image / authority: ${config.imageClass}; ${config.templateClass ?? "unspecified"} / ${config.authorityClass ?? "unspecified"}.`,
      `- Runtime: ${record.runtime}, ${record.platform}. Native interface: ${record.nativeVersion ?? "not recorded"}.`,
      `- SDK: ${record.sdkVersion}, commit \`${record.sdkCommit}\`.`,
      `- Harness commit: \`${record.harnessCommit}\`.`,
      `- Evidence: ${record.evidenceRef ? `[reviewed record](${record.evidenceRef})` : "not recorded"}.`,
      "",
      ...markdownTable(
        ["Scenario", "Latest live result", "Date"],
        group.map((item) => [
          item.scenario.startsWith("file-")
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

  if (!ordered.length) lines.push("No live evidence recorded", "");
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
