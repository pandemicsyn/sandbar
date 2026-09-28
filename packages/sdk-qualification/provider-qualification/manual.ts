import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbar, type AdapterRecoveryReference } from "sandbar-sdk";
import { modal } from "sandbar-sdk/modal";
import { LedgerStore } from "./ledger";
import { loadCredentials } from "./credentials";
import {
  publicCleanupAccess,
  reconcile,
  recordReference,
  runPrepared,
  type ConnectionFactory,
} from "./lifecycle";
import { parseReport, scenarios } from "./report";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const action = process.argv[2];

function required(name: string): string {
  const value = process.env[name];

  if (!value) throw new Error(`${name} is required`);

  return value;
}

const selectableScenarios = [
  "inspect",
  "exec-argv",
  "exec-shell",
  "exec-nonzero",
  "file-binary",
  "file-overwrite",
  "file-no-clobber",
  "inventory",
] as const;

type SelectableScenario = (typeof selectableScenarios)[number];

function isSelectable(value: string): value is SelectableScenario {
  return selectableScenarios.some((scenario) => scenario === value);
}

function selectedScenarios(): ReadonlySet<SelectableScenario> {
  const selected = process.env.SANDBAR_QUAL_SCENARIOS
    ? process.env.SANDBAR_QUAL_SCENARIOS.split(",").map((value) => value.trim())
    : [...selectableScenarios];

  if (selected.length === 0 || selected.some((value) => !isSelectable(value)))
    throw new Error(
      `SANDBAR_QUAL_SCENARIOS must be a comma-separated subset of ${selectableScenarios.join(",")}`,
    );
  const set = new Set(selected.filter(isSelectable));

  if ((set.has("file-overwrite") || set.has("file-no-clobber")) && !set.has("file-binary"))
    throw new Error("File overwrite and no-clobber require file-binary in the same run");

  if (set.has("file-no-clobber") && !set.has("file-overwrite"))
    throw new Error("File no-clobber requires file-overwrite in the same run");

  return set;
}

async function preflight(mode: "live-prepared" | "reconcile") {
  if (mode === "live-prepared" && process.env.CI)
    throw new Error(
      "CI live runs require an off-runner checkpoint; this manual command is local-only",
    );

  if (
    mode === "live-prepared" &&
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()
  )
    throw new Error("Live qualification requires a clean exact SDK commit");

  if (mode === "live-prepared" && required("SANDBAR_QUAL_LIVE_AUTHORIZED") !== "yes")
    throw new Error("Explicit live authorization is required");
  const directory = required("SANDBAR_QUAL_LEDGER_DIR");

  if (
    !isAbsolute(directory) ||
    directory.startsWith("/tmp/") ||
    directory.startsWith("/private/tmp/") ||
    directory.startsWith(tmpdir()) ||
    directory.startsWith(root)
  )
    throw new Error(
      "Ledger directory must be a stable private absolute path outside the checkout and temporary directories",
    );
  const provider = mode === "reconcile" ? "modal" : required("SANDBAR_QUAL_PROVIDER");

  if (provider !== "modal")
    throw new Error(
      "Only Modal prepared-image local runs have a native TTL configuration in this prototype",
    );

  const saved =
    mode === "reconcile" ? await new LedgerStore(directory, requiredArg(3)).read() : undefined;

  if (saved && (saved.provider !== "modal" || saved.image.kind !== "borrowed-prepared"))
    throw new Error("Ledger provider or image ownership does not match this cleanup profile");

  const config = {
    tokenId: required("MODAL_TOKEN_ID"),
    tokenSecret: required("MODAL_TOKEN_SECRET"),
    appName: saved?.connection?.appName ?? required("SANDBAR_MODAL_APP"),
    environment: saved?.connection?.environment ?? required("SANDBAR_MODAL_ENVIRONMENT"),
    region: saved?.connection?.region ?? required("SANDBAR_MODAL_REGION"),
    timeoutSeconds: saved?.connection?.timeoutSeconds ?? 300,
  };

  if (mode === "reconcile")
    return { directory, config, evidenceRef: process.env.SANDBAR_QUAL_EVIDENCE_REF };

  const imageId = required("SANDBAR_MODAL_IMAGE_ID");

  if (!/^im-[a-zA-Z0-9_-]+$/.test(imageId))
    throw new Error("A borrowed prepared Modal image ID is required");
  const evidenceRef = required("SANDBAR_QUAL_EVIDENCE_REF");
  // Validate the public field before any provider call. No raw run IDs or native refs appear there.
  parseReport({
    schemaVersion: 1,
    records: [
      {
        schemaVersion: 1,
        provider: "modal",
        scenario: "connect",
        mode: "live",
        status: "passed",
        runCleanup: "confirmed",
        sdkCommit: "0".repeat(40),
        sdkVersion: "0.0.0",
        nativeVersion: "modal 0.10.1",
        runtime: "Bun",
        platform: "macos-arm64",
        timestamp: new Date().toISOString(),
        configuration: { imageClass: "prepared", network: "blocked", regionClass: config.region },
        evidenceRef,
      },
    ],
  });

  return { directory, config, imageId, evidenceRef, selectedScenarios: selectedScenarios() };
}

function factory(config: Awaited<ReturnType<typeof preflight>>["config"]): ConnectionFactory {
  return (onReference: (reference: AdapterRecoveryReference) => Promise<void>) =>
    Sandbar.connect({
      adapter: modal(config),
      config: {},
      credentials: {},
      onReference,
    });
}

if (action !== "live-prepared" && action !== "reconcile")
  throw new Error("Usage: bun manual.ts live-prepared | reconcile <run UUID>");

await loadCredentials();

const settings = await preflight(action);

const runId = action === "reconcile" ? requiredArg(3) : crypto.randomUUID();

const ledger = new LedgerStore(settings.directory, runId);

if (action === "live-prepared")
  await ledger.initialize(
    "modal",
    { kind: "borrowed-prepared", class: "prepared" },
    {
      appName: settings.config.appName,
      environment: settings.config.environment,
      region: settings.config.region,
      timeoutSeconds: settings.config.timeoutSeconds,
    },
  );
else {
  const state = await ledger.read();

  if (state.provider !== "modal" || state.image.kind !== "borrowed-prepared")
    throw new Error("Ledger provider or image ownership does not match this cleanup profile");
}

const controller = new AbortController();

const timer = setTimeout(() => controller.abort("qualification time limit"), 240_000);

const interrupt = () => controller.abort("operator interrupt");

process.once("SIGINT", interrupt);

process.once("SIGTERM", interrupt);

try {
  const steps =
    action === "live-prepared"
      ? await runPrepared(
          factory(settings.config),
          ledger,
          settings.imageId ?? required("SANDBAR_MODAL_IMAGE_ID"),
          {
            network: "blocked",
            region: settings.config.region,
            cleanupWaitMs: 60_000,
            signal: controller.signal,
            selectedScenarios: settings.selectedScenarios,
          },
        )
      : await (async () => {
          const client = await factory(settings.config)((reference) =>
            recordReference(ledger, reference),
          );

          try {
            return await reconcile(publicCleanupAccess(client), ledger);
          } finally {
            await client.close();
          }
        })();

  const state = await ledger.read();

  if (settings.evidenceRef) {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    // SAFETY: This reads the checked-in SDK package manifest; the version is validated again by reportSchema.
    const sdk = JSON.parse(await readFile(resolve(root, "packages/sdk/package.json"), "utf8")) as {
      version: string;
      dependencies: { modal: string };
    };

    const records = steps.map((step) => ({
      schemaVersion: 1 as const,
      provider: "modal" as const,
      scenario: step.scenario,
      mode: "live" as const,
      status: step.status,
      runCleanup: state.cleanup === "confirmed" ? ("confirmed" as const) : ("incomplete" as const),
      sdkCommit: commit,
      sdkVersion: sdk.version,
      nativeVersion: `modal ${sdk.dependencies.modal}`,
      runtime: `Bun ${process.versions.bun ?? "unknown"}`,
      platform: `${process.platform}-${process.arch}`,
      timestamp: new Date().toISOString(),
      configuration: {
        imageClass: "prepared" as const,
        network: "blocked",
        regionClass: settings.config.region,
      },
      evidenceRef: settings.evidenceRef,
      issue: issue(step.issue),
    }));

    const originalReportPath = `${ledger.path}.public.json`;

    const prior =
      action === "reconcile" && existsSync(originalReportPath)
        ? parseReport(JSON.parse(await readFile(originalReportPath, "utf8")))
        : undefined;

    // A later successful cleanup can complete the original run without erasing dated scenario evidence.
    const combined = prior
      ? [
          ...prior.records.map((record) => ({
            ...record,
            runCleanup:
              state.cleanup === "confirmed" ? ("confirmed" as const) : ("incomplete" as const),
          })),
          ...records,
        ]
      : records;

    if (!prior)
      for (const scenario of scenarios)
        if (!combined.some((record) => record.scenario === scenario))
          combined.push({ ...records[0]!, scenario, status: "not-run", issue: "not-selected" });

    const report = parseReport({ schemaVersion: 1, records: combined });

    const publicPath =
      action === "reconcile" ? `${ledger.path}.${Date.now()}.public.json` : originalReportPath;

    await writeFile(publicPath, JSON.stringify(report, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      `Run ${runId}: cleanup ${state.cleanup}; private ledger ${ledger.path}; sanitized report ${publicPath}`,
    );
  } else {
    console.log(
      `Run ${runId}: cleanup ${state.cleanup}; private ledger ${ledger.path}; no public report without an evidence reference`,
    );
  }

  if (
    state.cleanup !== "confirmed" ||
    steps.some((step) => step.status === "failed" || step.status === "blocked")
  )
    process.exitCode = 1;
} finally {
  clearTimeout(timer);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}

function requiredArg(index: number): string {
  const value = process.argv[index];

  if (!value) throw new Error("Run UUID is required");

  return value;
}

function issue(value: string | undefined) {
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

  return "assertion-failed";
}
