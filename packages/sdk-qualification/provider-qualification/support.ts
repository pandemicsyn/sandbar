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
    workflow: "sandbox-lifecycle",
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
  suspension: { label: "Native sandbox suspend/resume", scenarios: ["lifecycle-suspend-resume"] },
  previewProtected: { label: "Protected HTTP preview", scenarios: ["preview-protected"] },
  previewPublic: { label: "Public HTTP preview", scenarios: ["preview-public"] },
  renewal: { label: "Configured lifetime renewal", scenarios: ["lifecycle-renew"] },
  reopening: { label: "Scoped sandbox reopening", scenarios: ["lifecycle-reopen"] },
  execution: {
    label: "Execution and captured output",
    workflow: "execution",
    scenarios: ["exec-argv", "exec-shell", "exec-nonzero"],
  },
  files: {
    label: "Binary files and overwrite",
    workflow: "files",
    scenarios: ["file-binary", "file-overwrite", "file-no-clobber"],
  },
  directories: { label: "Directory primitives", scenarios: ["file-directories"] },
  oci: { label: "OCI image builds", scenarios: ["build-oci"] },
  network: {
    label: "Measured network controls",
    workflow: "network-controls",
    scenarios: ["network-internet", "network-blocked"],
  },
  snapshots: { label: "Snapshot roundtrip", scenarios: ["snapshot-roundtrip"] },
  volumes: { label: "Volume CRUD", scenarios: ["volume-crud"] },
  persistence: { label: "Mounted persistence", scenarios: ["volume-persistence"] },
} satisfies Record<string, { label: string; scenarios: Scenario[]; workflow?: Scenario }>;

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
      suspension: {
        support: "conditional",
        note: "Known unmounted Daytona containers retain files and end processes with auto-delete disabled; start from stopped/archived preserves UUID and reports fresh execution. Hard TTL keeps ticking. Bun lifecycle-suspend-resume passed at 6796b30 with confirmed owned cleanup.",
      },
      previewProtected: {
        support: "conditional",
        note: "Daytona protected header access only; standard token grants sandbox-wide command/file authority. Public setup unsupported. Native lookup can activate a route; no server start/resume or readiness claim. New live preview case not run.",
      },
      previewPublic: {
        support: "unsupported",
        note: "Daytona sandbox-wide publication requires a separate product decision; preview never changes visibility.",
      },
      directories: {
        support: "unsupported",
        note: "listFiles, makeDirectory, fileExists and removeFile reject before mutation. Inspected native listing/details lose link identity or entries; mkdir always recurses; delete does not cover dangling links or empty-directory semantics. No shell emulation.",
      },
      renewal: {
        support: "conditional",
        note: "Running scoped compute; configured lifetime defaults, bounded native reset, ACK-preserving metadata and read-only no-replay recovery. Deterministic native/packed coverage; lifecycle-renew live workflow not run.",
      },
      reopening: {
        support: "conditional",
        note: "Scoped Sandbar-created compute only; fresh connection/process reopen, state/deadlines and running guest exec/files. Deterministic native/packed coverage; new live workflow not run.",
      },
      lifecycle: {
        support: "supported",
        note: "The immediate-inventory assertion failed at 1505ee0. A diagnostic reproduced native list-index lag. The Bun lifecycle test passed at 8449def in us with daytona-default after allowing a 30-second read-only convergence window; owned teardown and client close were confirmed. Other images/regions are unverified.",
      },
      execution: {
        support: "supported",
        note: "Argv/shell, cwd/env, binary output and nonzero exit use the prepared baseline configuration.",
      },
      files: {
        support: "conditional",
        note: "Baseline passed in /tmp with required GNU shell utilities. Custom image filesystem behavior is unverified. UTF-8 readTextFile/writeTextFile wrap these byte operations; local encoding has deterministic/packed coverage and needs no separate live qualification.",
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
        note: "Eligible containers only: stop/cold filesystem capture/restart, fresh restored execution; no RAM. The Bun roundtrip passed at 1505ee0 in us with daytona-default, including two-way filesystem isolation, separate-process reference reopen, source deletion, second restore and confirmed owned cleanup.",
      },
      volumes: {
        support: "supported",
        note: "The Bun native create/readiness/inspect/delete test passed at 1505ee0 in us with daytona-default. CRUD is independent of mounts; owned deletion was confirmed.",
      },
      persistence: {
        support: "conditional",
        note: "Writable create-time mounts/subpaths; read-only unsupported. The Bun producer write/flush/readback, producer destruction, independent consumer remount/readback and owned deletion passed at 1505ee0 in us with daytona-default.",
      },
    },
  },
  {
    id: "e2b",
    name: "E2B",
    features: {
      suspension: {
        support: "conditional",
        note: "Known unmounted E2B memory pause retains processes under the same ID; explicit resume uses configured initial session lifetime and reports execution unknown. Paused retention is indefinite and requires explicit owned cleanup. Live case failed before pause at cb39884 because native mount facts were unavailable; owned cleanup confirmed. Initial guest-routing failure at 6796b30 is retained; no E2B lifecycle pass.",
      },
      previewPublic: {
        support: "conditional",
        note: "E2B explicit public access only, with observed native visibility and auto-resume off. Default/protected create and restore disable public traffic; fresh protected token lookup unsupported. New live preview and changed inbound-default behavior not qualified.",
      },
      previewProtected: {
        support: "unsupported",
        note: "Fresh traffic-token retrieval is absent from the pinned read-only detail API. Native connect may resume compute; protected preview rejects without calling it. Newly created/restored compute is private by default.",
      },
      directories: {
        support: "conditional",
        note: "fileExists uses native lstat-backed Stat, including dangling links. makeDirectory and removeFile require recursive: true; omitted/false rejects before mutation. listFiles is unsupported because e2b 2.51.0 filters unknown entry types. Intermediate parent links are followed; recursive removal does not walk link entries. Native/packed fixtures only; file-directories live case not run.",
      },
      renewal: {
        support: "conditional",
        note: "Running scoped compute; configured lifetime defaults, bounded native reset, ACK-preserving metadata and read-only no-replay recovery. Deterministic native/packed coverage; lifecycle-renew live workflow not run.",
      },
      reopening: {
        support: "conditional",
        note: "Scoped Sandbar-created compute only; fresh connection/process reopen, state/deadlines and running guest exec/files. Deterministic native/packed coverage; new live workflow not run.",
      },
      lifecycle: {
        support: "supported",
        note: "The ordinary Bun base baseline passed at 8449def with API-key authority in the default region, requested blocked internet and five-minute native lifetime; compute cleanup and client close were confirmed.",
      },
      execution: {
        support: "supported",
        note: "Argv/shell, cwd/env, binary output and nonzero exit use the prepared baseline configuration. Finite bounded text streaming is implemented with local-only handles; deterministic pinned-client/packed coverage, live streaming scenario not run.",
      },
      files: {
        support: "conditional",
        note: "Passed in /home/user. An earlier sticky /tmp overwrite failed and dependent no-clobber was blocked; the home-workspace pass does not qualify arbitrary paths. UTF-8 readTextFile/writeTextFile wrap these byte operations; local encoding has deterministic/packed coverage and needs no separate live qualification.",
      },
      oci: {
        support: "conditional",
        note: "Implemented; retained templates require separate ownership/cleanup and budget approval. No live build acceptance.",
      },
      network: {
        support: "supported",
        note: "Maps internet/blocked to native allowInternetAccess, forwarding false for blocked. The paired Bun probe failed at 431cdaa: both internet positive controls passed, but the blocked sandbox connected to 1.1.1.1:443 and hostname resolution failed. The prior 8449def probe had no recoverable blocked-command result; bounded DNS now exposes concrete outcomes. Both runs have confirmed compute cleanup. No passing outbound isolation claim.",
      },
      snapshots: {
        support: "conditional",
        note: "Compatible envd/templates only: filesystem + RAM, native pause/resume, pinned-build restore; mounts excluded. The Bun roundtrip passed at 8449def with borrowed base in the native default region, including RAM continuity, two-way filesystem isolation, separate-process reference reopening, source deletion, second restore and confirmed owned compute/snapshot cleanup.",
      },
      volumes: {
        support: "unsupported",
        note: "Volume workflows are not supported for E2B qualification; volume CRUD and persistence tests skip before provider setup. Experimental native CRUD is not eligible for live acceptance. The original uncertain volume creator remains preserved and unresolved; identified volume-only custody does not block separately bounded tests that allocate no volumes.",
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
  workflow?: Scenario,
) {
  const candidates = reports
    .flatMap((report) => parseReport(report).records)
    .filter(
      (record) =>
        record.provider === provider &&
        record.mode === "live" &&
        (ids.includes(record.scenario) || record.scenario === workflow) &&
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

  // A grouped case reports only its workflow outcome; legacy records retain their own operations.
  const selectedIds = newest.scenario === workflow ? [workflow] : ids;

  const selected = selectedIds.map(
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
    { label: string; scenarios: readonly Scenario[]; workflow?: Scenario },
  ][];

  const rows = entries.map(([id, feature]) => {
    const cells = profiles.map((profile) => {
      const declared = profile.features[id];

      if (!declared) throw new Error(`Missing feature declaration: ${profile.id}/${id}`);
      const state = validation(reports, profile.id, feature.scenarios, feature.workflow);

      const history = historical.filter(
        (item) => item.provider === profile.id && feature.scenarios.includes(item.scenario),
      );

      const latest = history.at(-1);

      const result =
        state === "not-run" && latest
          ? `${latest.cleanup === "incomplete" ? "blocked" : latest.status} at ${latest.sourceRevision} (historical${latest.cleanup === "incomplete" ? "; cleanup incomplete" : ""})`
          : state;

      return `[${declared.support[0]!.toUpperCase() + declared.support.slice(1)} · ${result}](#${profile.id}-${id})`;
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
    "The [live evidence detail](/docs/providers/live-qualification/) retains exact available provenance, earlier configurations and historical state acceptance. Daytona baseline passed at 8449def after allowing bounded inventory convergence; the original 1505ee0 failure remains recorded. Snapshot roundtrip, volume CRUD and mounted persistence retain their 1505ee0 passes. E2B baseline and RAM snapshot roundtrip passed at 8449def; its measured network probe failed at 431cdaa. All newly owned compute and retained artifacts have confirmed cleanup, while the original E2B volume uncertainty remains unresolved. Other operation/configuration claims retain their own recorded revisions and limitations below.",
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
    "Modal is an external experimental adapter with offline native-boundary and packed consumer coverage, without live acceptance. Custom adapters supply a profile to the same ordinary Bun SDK suites. Fake is a deterministic fixture without isolation guarantees.",
    "",
    "## Runtimes",
    "",
    "The SDK targets server-side Node.js and Bun. Packed consumer checks exercise emitted JavaScript and strict TypeScript declarations; live records retain the tested runtime/platform. Package and fixture checks do not establish live provider behavior on other runtimes.",
    "",
    "## Updating support",
    "",
    "Reviewed summaries live in results/<provider>.json; new integration runs use standard Bun JUnit plus a small offline provenance/cleanup mapping. The bounded Daytona Bun run at 1505ee0 is recorded, including its lifecycle failure. E2B volume tests skip; identified volume-only custody does not block bounded zero-volume suites. Capability declarations and caveats live in provider-qualification/support.ts (external authors supply equivalent metadata). Generate both pages offline with `bun packages/sdk-qualification/provider-qualification/render.ts`; use `--check` for drift. Live runs require separate explicit resource authorization and durable owned cleanup.",
    "",
  );

  return lines.join("\n");
}
