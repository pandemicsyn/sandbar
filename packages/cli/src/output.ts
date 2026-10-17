import { OutcomeUnknownError, SandbarError, type SandboxReference } from "sandbar-sdk";

/** A failure the CLI detected itself, before or around provider calls. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly known?: Known,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function usage(message: string, hint?: string): CliError {
  return new CliError("USAGE", message, hint);
}

export type Known = { sandbox?: string; reference?: SandboxReference | null };

export type Outcome = "rejected" | "unknown" | "partial";

export type ErrorReport = {
  code: string;
  message: string;
  retryable: boolean;
  outcome: Outcome;
  hint?: string;
  known?: Known;
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
      outcome: cause.code === "OUTCOME_UNKNOWN" ? "unknown" : "rejected",
      hint: cause.hint,
      known: cause.known,
    };

  if (cause instanceof SandbarError) {
    const partial = cause.outcome?.status === "partial";

    const known: Known | undefined =
      cause.outcome && "sandbox" in cause.outcome && cause.outcome.sandbox
        ? { reference: cause.outcome.sandbox }
        : undefined;

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

  return {
    code: "INTERNAL",
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: false,
    outcome: "unknown",
  };
}

const managementExitCodes = new Map([
  ["USAGE", 2],
  ["INVALID_ARGUMENT", 2],
  ["NOT_FOUND", 3],
  ["UNSUPPORTED", 4],
  ["ADAPTER_NOT_INSTALLED", 4],
  ["LIMIT_REACHED", 4],
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

/** exec and run pass the remote exit code through, so CLI failures use the 124-127 range. */
export function commandExitCode(report: ErrorReport): number {
  return report.code === "TIMEOUT" ? 124 : 125;
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
  }

  /** Diagnostics never go to stdout, so stdout stays parseable. */
  note(text: string): void {
    this.streams.stderr(`${text}\n`);
  }
}
