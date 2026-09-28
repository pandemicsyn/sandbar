import { execFileSync } from "node:child_process";
import { z } from "zod";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { qualificationRevisions, reconciliationRevisions } from "./revisions";
import { loadCredentials } from "./credentials";
import { daytonaConfiguration, daytonaConnection } from "./daytona-profile";
import { e2bConfiguration, e2bConnection, e2bEnvdVersion } from "./e2b-profile";
import { LedgerStore, requirePrivateDirectory, reportedCleanup } from "./ledger";
import { reconcileConnection, runPrepared, type Step } from "./lifecycle";
import { runNetworkPair, type NetworkRun } from "./network-profile";
import { networkProbeId } from "./network-probe";
import { parseReport, publicIssue, scenarios, type Scenario } from "./report";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const action = process.argv[2];

function required(name: string): string {
  const value = process.env[name];

  if (!value) throw new Error(`${name} is required`);

  return value;
}

const selectable = [
  "inspect",
  "exec-argv",
  "exec-shell",
  "exec-nonzero",
  "file-binary",
  "file-overwrite",
  "file-no-clobber",
  "inventory",
] as const;

function selectedScenarios(): ReadonlySet<Scenario> {
  const values = process.env.SANDBAR_QUAL_SCENARIOS?.split(",").map((value) => value.trim()) ?? [
    ...selectable,
  ];

  if (!values.length || values.some((value) => !selectable.some((id) => id === value)))
    throw new Error(`SANDBAR_QUAL_SCENARIOS must select from ${selectable.join(",")}`);
  const selected = new Set<Scenario>(selectable.filter((id) => values.includes(id)));

  if (
    (selected.has("file-overwrite") || selected.has("file-no-clobber")) &&
    !selected.has("file-binary")
  )
    throw new Error("File overwrite/no-clobber require file-binary");

  if (selected.has("file-no-clobber") && !selected.has("file-overwrite"))
    throw new Error("File no-clobber requires file-overwrite");

  return selected;
}

function within(directory: string, parent: string): boolean {
  return directory === parent || directory.startsWith(`${parent}${sep}`);
}

if (action !== "live-prepared" && action !== "live-network" && action !== "reconcile")
  throw new Error("Usage: bun manual.ts live-prepared | live-network | reconcile <run UUID>");

const provider = z.enum(["e2b", "daytona"]).parse(required("SANDBAR_QUAL_PROVIDER"));

if (action === "live-network" && provider !== "e2b")
  throw new Error("The paired network profile requires E2B internet-mode support");

if (action !== "reconcile") {
  if (process.env.CI)
    throw new Error("CI live runs require an off-runner checkpoint; local-only profile");

  if (required("SANDBAR_QUAL_LIVE_AUTHORIZED") !== "yes")
    throw new Error("Explicit authorization for the bounded live run is required");

  if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim())
    throw new Error("Live qualification requires a clean exact SDK commit");
}

const suppliedDirectory = required("SANDBAR_QUAL_LEDGER_DIR");

if (!isAbsolute(suppliedDirectory)) throw new Error("Ledger directory must be absolute");

const directory = await realpath(suppliedDirectory);

await requirePrivateDirectory(directory);

if (
  within(directory, root) ||
  within(directory, "/tmp") ||
  within(directory, "/private/tmp") ||
  within(directory, await realpath(tmpdir()))
)
  throw new Error(
    "Ledger directory must be stable private storage outside the repository and temporary directories",
  );

const runId = action === "reconcile" ? process.argv[3] : crypto.randomUUID();

if (!runId) throw new Error("Run UUID is required");

const ledger = new LedgerStore(directory, runId);

const saved = action === "reconcile" ? await ledger.read() : undefined;

if (saved && (saved.provider !== provider || saved.image.kind !== "borrowed-prepared"))
  throw new Error("Ledger provider/ownership does not match the selected prepared profile");

const e2bConfig =
  provider === "e2b"
    ? e2bConfiguration.parse(
        saved?.connection ?? {
          teamId: process.env.SANDBAR_E2B_TEAM_ID,
          templateId: process.env.SANDBAR_E2B_TEMPLATE_ID,
          timeoutSeconds: 300,
        },
      )
    : undefined;

const daytonaConfig =
  provider === "daytona"
    ? daytonaConfiguration.parse(
        saved?.connection ?? {
          target: required("SANDBAR_DAYTONA_TARGET"),
          snapshotId: required("SANDBAR_DAYTONA_SNAPSHOT_ID"),
          ttlMinutes: 15,
          networkPolicy: process.env.SANDBAR_DAYTONA_NETWORK_POLICY ?? "blocked",
        },
      )
    : undefined;

const config = e2bConfig ?? daytonaConfig!;

const imageId = e2bConfig?.templateId ?? daytonaConfig!.snapshotId;

if (action === "live-network" && imageId !== "base")
  throw new Error("The bounded network profile requires the public base template");

const paired = action === "live-network" || Boolean(saved?.companionRunId);

if (paired && provider !== "e2b") throw new Error("Companion runs require E2B");

const companion = paired
  ? new LedgerStore(directory, saved?.companionRunId ?? crypto.randomUUID())
  : undefined;

if (saved && companion) {
  const other = await companion.read();

  if (
    other.companionRunId !== ledger.runId ||
    other.provider !== saved.provider ||
    JSON.stringify(other.connection) !== JSON.stringify(saved.connection) ||
    !saved.networkPolicy ||
    !other.networkPolicy ||
    !["internet", "blocked"].includes(saved.networkPolicy) ||
    !["internet", "blocked"].includes(other.networkPolicy) ||
    saved.networkPolicy === other.networkPolicy
  )
    throw new Error("Companion ledger routing mismatch");
}

const fileRoot = z
  .enum(["/tmp", "/home/user"])
  .parse(
    action === "reconcile"
      ? (saved?.fileRoot ?? "/tmp")
      : (process.env.SANDBAR_QUAL_FILE_ROOT ?? (provider === "e2b" ? "/home/user" : "/tmp")),
  );

const selected = action === "live-prepared" ? selectedScenarios() : undefined;

const requestedEvidenceRef =
  action !== "reconcile"
    ? required("SANDBAR_QUAL_EVIDENCE_REF")
    : process.env.SANDBAR_QUAL_EVIDENCE_REF;

const revisions =
  action !== "reconcile"
    ? qualificationRevisions(root, process.env.SANDBAR_QUAL_SDK_REF ?? "origin/main")
    : requestedEvidenceRef
      ? reconciliationRevisions(root, process.env.SANDBAR_QUAL_SDK_REF ?? "origin/main")
      : undefined;

const evidenceRef = revisions ? requestedEvidenceRef : undefined;

if (requestedEvidenceRef && !evidenceRef)
  console.warn(
    "Cleanup continues privately; public evidence suppressed because checkout provenance is unverified",
  );

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

// SAFETY: The checked-in package manifest is read here; reportSchema validates these values before use.
const sdk = JSON.parse(await readFile(resolve(root, "packages/sdk/package.json"), "utf8")) as {
  version: string;
  dependencies: { e2b: string };
};

const metadata = {
  schemaVersion: 1 as const,
  provider,
  mode: "live" as const,
  ...(revisions ?? { sdkCommit: commit, harnessCommit: commit }),
  sdkVersion: sdk.version,
  nativeVersion: provider === "e2b" ? `e2b ${sdk.dependencies.e2b}` : "Daytona REST 0.218",
  runtime: `Bun ${process.versions.bun ?? "unknown"}`,
  platform: `${process.platform}-${process.arch}`,
  configuration: {
    imageClass: "prepared" as const,
    fileRoot,
    templateClass: e2bConfig
      ? e2bConfig.templateId === "base"
        ? ("public-base" as const)
        : ("borrowed-template" as const)
      : ("borrowed-snapshot" as const),
    authorityClass: e2bConfig
      ? e2bConfig.teamId
        ? ("verified-team" as const)
        : ("api-key" as const)
      : ("verified-organization" as const),
    network: `${daytonaConfig?.networkPolicy ?? "blocked"}-requested`,
    networkProbe: paired ? (saved?.networkProbe ?? networkProbeId) : undefined,
    regionClass: daytonaConfig?.target ?? "provider-default",
  },
  evidenceRef,
};

if (evidenceRef)
  parseReport({
    schemaVersion: 1,
    records: [
      {
        ...metadata,
        scenario: "connect",
        status: "not-run",
        runCleanup: "incomplete",
        timestamp: new Date().toISOString(),
      },
    ],
  });

// All routing/run gates precede secret loading, connection and native mutation.
await loadCredentials();

const apiKey = required(provider === "e2b" ? "E2B_API_KEY" : "SANDBAR_DAYTONA_API_KEY");

const redactions = [
  apiKey,
  process.env.SANDBAR_DAYTONA_API_KEY ?? "",
  process.env.E2B_API_KEY ?? "",
  daytonaConfig?.snapshotId ?? "",
];

const factory = e2bConfig
  ? e2bConnection(e2bConfig, apiKey)
  : daytonaConnection(daytonaConfig!, apiKey);

const controller = new AbortController();

const timer = setTimeout(() => controller.abort("qualification exercise time limit"), 240_000);

const interrupt = () => controller.abort("operator interruption");

process.once("SIGINT", interrupt);

process.once("SIGTERM", interrupt);

const exercise = async () => {
  if (action !== "reconcile") {
    await ledger.initialize(provider, { kind: "borrowed-prepared", class: "prepared" }, config);
    await ledger.update((value) => ({
      ...value,
      fileRoot,
      companionRunId: companion?.runId,
      networkPolicy: companion ? "internet" : (daytonaConfig?.networkPolicy ?? "blocked"),
      networkProbe: companion ? networkProbeId : undefined,
    }));

    if (companion) {
      await companion.initialize("e2b", { kind: "borrowed-prepared", class: "prepared" }, config);
      await companion.update((value) => ({
        ...value,
        companionRunId: ledger.runId,
        networkPolicy: "blocked",
        networkProbe: networkProbeId,
      }));
    }
  }

  let steps: Step[];
  let networkRuns: NetworkRun[] | undefined;

  if (action === "live-network") {
    networkRuns = await runNetworkPair(factory, ledger, companion!, imageId, {
      signal: controller.signal,
      cleanupWaitMs: 60_000,
      redactions,
      envdVersion: provider === "e2b" ? e2bEnvdVersion(apiKey) : undefined,
    });
    steps = networkRuns.flatMap((run) => run.steps);
  } else if (action === "live-prepared")
    steps = await runPrepared(factory, ledger, imageId, {
      network: daytonaConfig?.networkPolicy ?? "blocked",
      fileRoot,
      signal: controller.signal,
      cleanupWaitMs: 60_000,
      selectedScenarios: selected,
      redactions,
      envdVersion: provider === "e2b" ? e2bEnvdVersion(apiKey) : undefined,
    });
  else {
    steps = await reconcileConnection(factory, ledger, 60_000, redactions);

    if (companion) {
      const companionSteps = await reconcileConnection(factory, companion, 60_000, redactions);
      networkRuns = [
        { policy: z.enum(["internet", "blocked"]).parse(saved!.networkPolicy), ledger, steps },
        {
          policy: saved!.networkPolicy === "internet" ? "blocked" : "internet",
          ledger: companion,
          steps: companionSteps,
        },
      ];
      steps = [...steps, ...companionSteps];
    }
  }

  const state = await ledger.read();
  const companionState = companion ? await companion.read() : undefined;

  const cleanup = reportedCleanup(companionState ? [state, companionState] : [state]);
  const cleanupComplete = cleanup !== "incomplete";

  if (evidenceRef) {
    const sourcedSteps = networkRuns
      ? networkRuns.flatMap((run) =>
          run.steps.map((step) => ({
            step,
            policy: run.policy,
            envd: run.policy === state.networkPolicy ? state.envd : companionState?.envd,
          })),
        )
      : steps.map((step) => ({
          step,
          policy: state.networkPolicy ?? daytonaConfig?.networkPolicy ?? "blocked",
          envd: state.envd,
        }));

    const records = sourcedSteps.map(({ step, policy, envd }) => ({
      ...metadata,
      configuration: { ...metadata.configuration, network: `${policy}-requested` },
      scenario: step.scenario,
      status: step.status,
      runCleanup: cleanup,
      timestamp: new Date().toISOString(),
      issue: publicIssue(step.issue),
      diagnostic: step.diagnostic,
      networkEvidence: step.networkEvidence,
      envd: envd ?? { status: "not-collected" as const },
    }));

    const originalPath = `${saved?.networkPolicy === "blocked" && companion ? companion.path : ledger.path}.public.json`;
    let previous;

    if (action === "reconcile") {
      try {
        previous = parseReport(JSON.parse(await readFile(originalPath, "utf8")));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }

    const combined = previous
      ? [
          ...previous.records.map((record) => ({
            ...record,
            runCleanup: cleanup,
          })),
          ...records,
        ]
      : records;

    if (!previous)
      for (const scenario of scenarios)
        if (!combined.some((record) => record.scenario === scenario))
          combined.push({
            ...records[0]!,
            scenario,
            status: scenario === "snapshot-roundtrip" ? "unsupported" : "not-run",
            issue: scenario === "snapshot-roundtrip" ? "unsupported-capability" : "not-selected",
            networkEvidence: undefined,
          });
    const report = parseReport({ schemaVersion: 1, records: combined });

    const publicPath =
      action === "reconcile" ? `${ledger.path}.${Date.now()}.public.json` : originalPath;

    await writeFile(publicPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
    console.log(
      `Run ${runId}: cleanup ${state.cleanup}; private ledger ${ledger.path}; sanitized report ${publicPath}`,
    );
  } else console.log(`Run ${runId}: cleanup ${state.cleanup}; private ledger ${ledger.path}`);

  if (
    !cleanupComplete ||
    steps.some((step) => step.status === "failed" || step.status === "blocked")
  )
    process.exitCode = 1;
};

try {
  await ledger.withAdmissionLock(exercise, companion);
} finally {
  clearTimeout(timer);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
