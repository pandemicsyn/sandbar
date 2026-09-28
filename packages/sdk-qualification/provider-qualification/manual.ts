import { execFileSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { qualificationRevisions } from "./revisions";
import { loadCredentials } from "./credentials";
import { e2bConfiguration, e2bConnection } from "./e2b-profile";
import { LedgerStore, requirePrivateDirectory } from "./ledger";
import { reconcileConnection, runPrepared, type Step } from "./lifecycle";
import { parseReport, scenarios, type Scenario } from "./report";

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

if (action !== "live-prepared" && action !== "reconcile")
  throw new Error("Usage: bun manual.ts live-prepared | reconcile <run UUID>");

if (required("SANDBAR_QUAL_PROVIDER") !== "e2b")
  throw new Error("Only E2B is wired; Daytona awaits its merged native lifetime/cleanup profile");

if (action === "live-prepared") {
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

if (saved && (saved.provider !== "e2b" || saved.image.kind !== "borrowed-prepared"))
  throw new Error("Ledger provider/ownership does not match the E2B prepared profile");

const config = e2bConfiguration.parse(
  saved?.connection ?? {
    teamId: required("SANDBAR_E2B_TEAM_ID"),
    templateId: required("SANDBAR_E2B_TEMPLATE_ID"),
    timeoutSeconds: 300,
  },
);

const selected = action === "live-prepared" ? selectedScenarios() : undefined;

const evidenceRef =
  action === "live-prepared"
    ? required("SANDBAR_QUAL_EVIDENCE_REF")
    : process.env.SANDBAR_QUAL_EVIDENCE_REF;

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

// SAFETY: The checked-in package manifest is read here; reportSchema validates these values before use.
const sdk = JSON.parse(await readFile(resolve(root, "packages/sdk/package.json"), "utf8")) as {
  version: string;
  dependencies: { e2b: string };
};

const metadata = {
  schemaVersion: 1 as const,
  provider: "e2b" as const,
  mode: "live" as const,
  ...(action === "live-prepared"
    ? qualificationRevisions(root, process.env.SANDBAR_QUAL_SDK_REF ?? "origin/main")
    : { sdkCommit: commit, harnessCommit: commit }),
  sdkVersion: sdk.version,
  nativeVersion: `e2b ${sdk.dependencies.e2b}`,
  runtime: `Bun ${process.versions.bun ?? "unknown"}`,
  platform: `${process.platform}-${process.arch}`,
  configuration: {
    imageClass: "prepared" as const,
    network: "blocked-requested",
    regionClass: "provider-default",
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

const factory = e2bConnection(config, required("E2B_API_KEY"));

if (action === "live-prepared")
  await ledger.initialize("e2b", { kind: "borrowed-prepared", class: "prepared" }, config);

const controller = new AbortController();

const timer = setTimeout(() => controller.abort("qualification exercise time limit"), 240_000);

const interrupt = () => controller.abort("operator interruption");

process.once("SIGINT", interrupt);

process.once("SIGTERM", interrupt);

try {
  let steps: Step[];

  if (action === "live-prepared")
    steps = await runPrepared(factory, ledger, config.templateId, {
      network: "blocked",
      signal: controller.signal,
      cleanupWaitMs: 60_000,
      selectedScenarios: selected,
    });
  else {
    steps = await reconcileConnection(factory, ledger, 60_000);
  }

  const state = await ledger.read();

  if (evidenceRef) {
    const records = steps.map((step) => ({
      ...metadata,
      scenario: step.scenario,
      status: step.status,
      runCleanup:
        state.cleanup === "not-required"
          ? ("not-required" as const)
          : state.cleanup === "confirmed"
            ? ("confirmed" as const)
            : ("incomplete" as const),
      timestamp: new Date().toISOString(),
      issue: publicIssue(step.issue),
    }));

    const originalPath = `${ledger.path}.public.json`;
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
            runCleanup:
              state.cleanup === "not-required"
                ? ("not-required" as const)
                : state.cleanup === "confirmed"
                  ? ("confirmed" as const)
                  : ("incomplete" as const),
          })),
          ...records,
        ]
      : records;

    if (!previous)
      for (const scenario of scenarios)
        if (!combined.some((record) => record.scenario === scenario))
          combined.push({ ...records[0]!, scenario, status: "not-run", issue: "not-selected" });
    const report = parseReport({ schemaVersion: 1, records: combined });

    const publicPath =
      action === "reconcile" ? `${ledger.path}.${Date.now()}.public.json` : originalPath;

    await writeFile(publicPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
    console.log(
      `Run ${runId}: cleanup ${state.cleanup}; private ledger ${ledger.path}; sanitized report ${publicPath}`,
    );
  } else console.log(`Run ${runId}: cleanup ${state.cleanup}; private ledger ${ledger.path}`);

  if (
    (state.cleanup !== "confirmed" && state.cleanup !== "not-required") ||
    steps.some((step) => step.status === "failed" || step.status === "blocked")
  )
    process.exitCode = 1;
} finally {
  clearTimeout(timer);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}

function publicIssue(value: string | undefined) {
  if (!value) return undefined;

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
