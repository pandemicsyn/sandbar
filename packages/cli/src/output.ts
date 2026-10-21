import {
  OutcomeUnknownError,
  SandbarError,
  type RecoveryReference,
  type SandboxReference,
} from "sandbar-sdk";

/** A failure the CLI detected itself, before or around provider calls. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly known?: Known,
    /** Whether an effect may already have happened; defaults to rejected (no effect). */
    readonly outcome: Outcome = code === "OUTCOME_UNKNOWN" ? "unknown" : "rejected",
    /** Per-item results for batch commands that stopped partway. */
    readonly details?: BatchDetails,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export type ExecSummary = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export type BatchItem = { name: string; result: string; reason?: string };

export type BatchDetails = {
  removed: BatchItem[];
  skipped: BatchItem[];
  failed: (BatchItem & { code: string })[];
};

export function usage(message: string, hint?: string): CliError {
  return new CliError("USAGE", message, hint);
}

export type Known = {
  sandbox?: string;
  /** The image record an uncertain `sandbar image build` keeps. */
  image?: string;
  reference?: SandboxReference | null;
  /** The SDK's operation reference for an uncertain create; `sandbar rm` uses it to recover. */
  recovery?: RecoveryReference;
  /** The command's captured result when a later step (cleanup, exit status) failed. */
  exec?: ExecSummary;
};

export type Outcome = "rejected" | "unknown" | "partial";

export type ErrorReport = {
  code: string;
  message: string;
  retryable: boolean;
  outcome: Outcome;
  hint?: string;
  known?: Known;
  details?: BatchDetails;
};

const retryableCodes = new Set(["RATE_LIMIT", "CAPACITY", "UNAVAILABLE"]);

/** Codes whose effect may already have happened, so blind retry is unsafe. */
const uncertainEffects = new Set(["possible", "unknown", "partial", "applied"]);

export function describeError(cause: unknown): ErrorReport {
  if (cause instanceof CliError)
    return {
      code: cause.code,
      message: cause.message,
      retryable: false,
      outcome: cause.outcome,
      hint: cause.hint,
      known: cause.known,
      details: cause.details,
    };

  if (cause instanceof SandbarError) {
    const partial = cause.outcome?.status === "partial";

    let known: Known | undefined;

    if (cause.outcome && "sandbox" in cause.outcome && cause.outcome.sandbox)
      known = { reference: cause.outcome.sandbox };

    if (cause.reference) known = { ...known, recovery: cause.reference };

    const outcome: Outcome = partial
      ? "partial"
      : cause instanceof OutcomeUnknownError || uncertainEffects.has(cause.effect)
        ? "unknown"
        : "rejected";

    return {
      code: partial ? "PARTIAL" : cause.code,
      message: cause.message,
      retryable: outcome === "rejected" && retryableCodes.has(cause.code),
      outcome,
      known,
    };
  }

  // Local file errors (a missing --stdin-file, an unreadable cp source) happen before any effect.
  const local = cause instanceof Error && "syscall" in cause && "code" in cause;

  if (local)
    return {
      code: "LOCAL_IO",
      message: cause.message,
      retryable: false,
      outcome: "rejected",
    };

  return {
    code: "INTERNAL",
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: false,
    outcome: "unknown",
  };
}

const managementExitCodes = new Map([
  ["USAGE", 2],
  ["LOCAL_IO", 2],
  ["INVALID_ARGUMENT", 2],
  ["NOT_FOUND", 3],
  ["UNSUPPORTED", 4],
  ["ADAPTER_NOT_INSTALLED", 4],
  ["ADAPTER_LOAD_FAILED", 4],
  ["ADAPTER_INSTALLER_MISSING", 4],
  ["LIMIT_REACHED", 4],
  ["SECRET_TOOL_MISSING", 4],
  ["SECRET_UNAVAILABLE", 5],
  ["UNAUTHENTICATED", 5],
  ["FORBIDDEN", 5],
]);

/** Exit codes for commands other than exec and run. */
export function managementExitCode(report: ErrorReport): number {
  if (report.outcome === "partial") return 8;

  if (report.outcome === "unknown") return report.code === "INTERNAL" ? 1 : 6;

  if (report.retryable) return 7;

  return managementExitCodes.get(report.code) ?? 1;
}

/**
 * exec, sh and run pass the remote exit code through, so every CLI-side failure is 125.
 * Native deadlines give no portable "the command was stopped" evidence, so there is no 124.
 */
export function commandExitCode(): 125 {
  return 125;
}

export type Streams = {
  stdout: (text: string | Uint8Array) => void;
  stderr: (text: string | Uint8Array) => void;
};

export class Output {
  constructor(
    readonly json: boolean,
    readonly streams: Streams,
  ) {}

  /** Print the command's single result: a JSON envelope or the human text. */
  success<T>(data: T, human: string): void {
    if (this.json) this.streams.stdout(`${JSON.stringify({ ok: true, data })}\n`);
    else if (human) this.streams.stdout(human.endsWith("\n") ? human : `${human}\n`);
  }

  failure(report: ErrorReport): void {
    if (this.json) {
      this.streams.stdout(`${JSON.stringify({ ok: false, error: report })}\n`);

      return;
    }

    this.streams.stderr(`sandbar: ${report.message}\n`);

    if (report.hint) this.streams.stderr(`hint: ${report.hint}\n`);

    if (report.outcome === "unknown" && report.code !== "INTERNAL")
      this.streams.stderr(
        "The operation may have taken effect; inspect before retrying (sandbar ls, sandbar inspect).\n",
      );

    if (report.known?.reference)
      this.streams.stderr(`known sandbox reference: ${JSON.stringify(report.known.reference)}\n`);
    else if (report.known?.recovery)
      this.streams.stderr(
        `operation recovery reference: ${JSON.stringify(report.known.recovery)}\n`,
      );

    for (const item of report.details?.removed ?? []) this.streams.stdout(`${item.name}\n`);

    for (const item of report.details?.skipped ?? [])
      this.streams.stderr(`skipped ${item.name}: ${item.reason ?? item.result}\n`);

    for (const item of report.details?.failed ?? [])
      this.streams.stderr(`failed ${item.name}: ${item.code} ${item.reason ?? ""}\n`);
  }

  /** Diagnostics never go to stdout, so stdout stays parseable. */
  note(text: string): void {
    this.streams.stderr(`${text}\n`);
  }
}
