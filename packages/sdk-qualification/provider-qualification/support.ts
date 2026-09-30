import { z } from "zod";
import {
  markdownTable,
  parseReport,
  type QualificationReport,
  type QualificationRecord,
  type Scenario,
} from "./report";

export const features = {
  lifecycle: {
    label: "Sandbox lifecycle",
    scenarios: [
      "connect",
      "create-prepared",
      "inspect",
      "inventory",
      "destroy",
      "confirm-cleanup",
      "close",
    ],
  },
  execution: {
    label: "Execution and captured output",
    scenarios: ["exec-argv", "exec-shell", "exec-nonzero"],
  },
  files: {
    label: "Binary files and overwrite",
    scenarios: ["file-binary", "file-overwrite", "file-no-clobber"],
  },
  oci: { label: "OCI image builds", scenarios: ["build-oci"] },
  network: {
    label: "Measured network controls",
    scenarios: ["network-internet", "network-blocked"],
  },
  snapshots: { label: "Snapshot roundtrip", scenarios: ["snapshot-roundtrip"] },
  volumes: { label: "Volume CRUD", scenarios: ["volume-crud"] },
  persistence: { label: "Mounted persistence", scenarios: ["volume-persistence"] },
} satisfies Record<string, { label: string; scenarios: Scenario[] }>;

// SAFETY: features is a fixed nonempty literal; its own keys form this enum.
const featureKeys = Object.keys(features) as [keyof typeof features, ...(keyof typeof features)[]];

export const supportMetadataSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/),
  name: z.string().min(1).max(80),
  features: z.record(
    z.enum(featureKeys),
    z.strictObject({
      support: z.enum(["supported", "unsupported", "conditional"]),
      note: z.string().min(1).max(1200),
    }),
  ),
});

export type SupportMetadata = z.infer<typeof supportMetadataSchema>;

export const builtinSupport: SupportMetadata[] = [
  {
    id: "daytona",
    name: "Daytona",
    features: {
      lifecycle: {
        support: "supported",
        note: "Prepared baseline passed at 3be54464 in us with daytona-small and daytona-default. Other images/regions are unverified.",
      },
      execution: {
        support: "supported",
        note: "Argv/shell, cwd/env, binary output and nonzero exit use the prepared baseline configuration.",
      },
      files: {
        support: "conditional",
        note: "Baseline passed in /tmp with required GNU shell utilities. Custom image filesystem behavior is unverified.",
      },
      oci: {
        support: "conditional",
        note: "Implemented; retained image ownership/cleanup and a separately authorized build budget are prerequisites. No live build acceptance.",
      },
      network: {
        support: "conditional",
        note: "daytona-default permits essential services and is not strict blocked egress. Tier-dependent strict blocking has no maintained positive-control qualification profile.",
      },
      snapshots: {
        support: "conditional",
        note: "Eligible containers only: stop/cold filesystem capture/restart, fresh restored execution; no RAM. Historical 5db0558 roundtrip passed; merged guards/recovery changed later, without a current-head live rerun. Fresh-process reopen is newly maintained and unrun live.",
      },
      volumes: {
        support: "supported",
        note: "Independent native create/inspect/delete is implemented. The historical mounted workflow included create/inspect/delete; the new separate CRUD scenario has not run live.",
      },
      persistence: {
        support: "conditional",
        note: "Writable create-time mounts/subpaths; read-only unsupported. Historical 5db0558 producer/destroy/remount/readback and deletion passed. Later custody/recovery guards have offline coverage, not a current-head live rerun.",
      },
    },
  },
  {
    id: "e2b",
    name: "E2B",
    features: {
      lifecycle: {
        support: "supported",
        note: "Prepared base baseline passed at 3be54464 with API-key authority in the default region, requested blocked internet and five-minute native lifetime.",
      },
      execution: {
        support: "supported",
        note: "Argv/shell, cwd/env, binary output and nonzero exit use the prepared baseline configuration.",
      },
      files: {
        support: "conditional",
        note: "Passed in /home/user. An earlier sticky /tmp overwrite failed and dependent no-clobber was blocked; the home-workspace pass does not qualify arbitrary paths.",
      },
      oci: {
        support: "conditional",
        note: "Implemented; retained templates require separate ownership/cleanup and budget approval. No live build acceptance.",
      },
      network: {
        support: "supported",
        note: "Maps internet/blocked to native allowInternetAccess. The maintained paired IPv4 TCP probe has not run live; merely requesting blocked does not measure enforcement.",
      },
      snapshots: {
        support: "conditional",
        note: "Compatible envd/templates only: filesystem + RAM, native pause/resume, pinned-build restore; mounts excluded. Historical 5db0558 roundtrip passed; later identity/rejection/cancellation guards are fixture-tested, without a current-head live rerun. Fresh-process reopen is unrun live.",
      },
      volumes: {
        support: "conditional",
        note: "CRUD is implemented independently of mounts. Successful inventory does not prove create eligibility: discovery is unknown until this connection has successful create evidence, unavailable after native auth denial. This account's focused create returned 403; no working live CRUD workflow. The earlier uncertain creator remains unresolved.",
      },
      persistence: {
        support: "unsupported",
        note: "Native mounts select reusable names without immutable volume-ID binding; the adapter rejects mounts before allocation. Volume artifact CRUD is a separate capability.",
      },
    },
  },
];

function validation(
  reports: readonly QualificationReport[],
  provider: string,
  ids: readonly Scenario[],
) {
  const candidates = reports
    .flatMap((report) => parseReport(report).records)
    .filter(
      (record) =>
        record.provider === provider &&
        record.mode === "live" &&
        ids.includes(record.scenario) &&
        record.status !== "unsupported" &&
        !(record.status === "not-run" && record.issue === "not-selected"),
    );

  const newest = [...candidates].sort(
    (a, b) =>
      Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
      Number(a.status === "passed") - Number(b.status === "passed"),
  )[0];

  if (!newest) return "not-run";

  const configurationKey = (configuration: QualificationRecord["configuration"]) => {
    // Paired controls deliberately request different policies; all other configuration stays bound.
    const values = Object.entries(configuration).filter(
      ([field]) => !ids.every((id) => id.startsWith("network-")) || field !== "network",
    );

    return JSON.stringify(values.sort(([a], [b]) => a.localeCompare(b)));
  };

  const sameRun = candidates.filter(
    (item) =>
      item.sdkCommit === newest.sdkCommit &&
      item.harnessCommit === newest.harnessCommit &&
      item.runtime === newest.runtime &&
      item.platform === newest.platform &&
      item.nativeVersion === newest.nativeVersion &&
      configurationKey(item.configuration) === configurationKey(newest.configuration),
  );

  const selected = ids.map(
    (id) =>
      sameRun
        .filter((item) => item.scenario === id)
        .sort(
          (a, b) =>
            Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
            Number(a.status === "passed") - Number(b.status === "passed"),
        )[0],
  );

  if (selected.some((record) => record?.status === "failed")) return "failed";

  if (
    selected.some(
      (record) =>
        record?.status === "blocked" ||
        (record?.status === "passed" && record.runCleanup !== "confirmed"),
    )
  )
    return "blocked";

  if (selected.some((record) => !record || record.status !== "passed")) return "not-run";

  return `passed at ${newest.sdkCommit.slice(0, 8)}`;
}

export function renderSupportMatrix(
  reports: readonly QualificationReport[],
  metadata: readonly SupportMetadata[] = builtinSupport,
) {
  const profiles = metadata.map((profile) => supportMetadataSchema.parse(profile));
  const historical = reports.flatMap((report) => parseReport(report).historicalEvidence ?? []);

  // SAFETY: Object.entries reads only the fixed feature keys and their declared scenario lists.
  const entries = Object.entries(features) as [
    keyof typeof features,
    { label: string; scenarios: readonly Scenario[] },
  ][];

  const rows = entries.map(([id, feature]) => {
    const cells = profiles.map((profile) => {
      const declared = profile.features[id];

      if (!declared) throw new Error(`Missing feature declaration: ${profile.id}/${id}`);
      const state = validation(reports, profile.id, feature.scenarios);

      const history = historical.filter(
        (item) => item.provider === profile.id && feature.scenarios.includes(item.scenario),
      );

      const latest = history.at(-1);

      const result =
        state === "not-run" && latest
          ? `${latest.cleanup === "incomplete" ? "blocked" : latest.status} at ${latest.sourceRevision} (historical${latest.cleanup === "incomplete" ? "; cleanup incomplete" : ""})`
          : state;

      return `[${declared.support[0]!.toUpperCase() + declared.support.slice(1)} · ${declared.support === "unsupported" ? "not-run" : result}](#${profile.id}-${id})`;
    });

    return [feature.label, ...cells];
  });

  const lines = [
    "---",
    "title: Tested provider support",
    "description: Declared adapter support and dated live acceptance, with provider caveats.",
    "---",
    "",
    "<!-- Generated by provider-qualification/render.ts; do not edit by hand. -->",
    "",
    "Adapter support and live validation are separate facts. **Supported** means implemented; **conditional** requires the configuration in the linked note; **unsupported** means the adapter does not expose the workflow. Live results are **passed**, **failed**, **blocked**, or **not-run**. Each pass applies to its recorded source/configuration, not the current head or every provider account. Fixture and packed tests never produce live passes.",
    "",
    ...markdownTable(["Feature", ...profiles.map((profile) => profile.name)], rows),
    "",
    "The [live evidence detail](/docs/providers/live-qualification/) retains exact available provenance, earlier configurations and historical state acceptance. Later production changes are described below; no paid rerun or current-head certification was performed for this refactor.",
    "",
  ];

  for (const profile of profiles) {
    lines.push(`## ${profile.name} caveats`, "");

    for (const [id, feature] of entries)
      lines.push(
        `<a id="${profile.id}-${id}"></a>`,
        "",
        `### ${feature.label}`,
        "",
        profile.features[id]!.note,
        "",
      );
  }

  lines.push(
    "## Other integrations",
    "",
    "Modal is an external experimental adapter with offline native-boundary and packed consumer coverage, without live acceptance. Custom adapters supply a profile to the same maintained runner; installed code does not register itself in a service. Fake is a deterministic fixture without isolation guarantees.",
    "",
    "## Updating support",
    "",
    "Reviewed summaries live in results/<provider>.json. Capability declarations and caveats live in provider-qualification/support.ts (external authors supply equivalent metadata). Generate both pages offline with `bun packages/sdk-qualification/provider-qualification/render.ts`; use `--check` for drift. Live runs require separate explicit resource authorization and durable owned cleanup.",
    "",
  );

  return lines.join("\n");
}
