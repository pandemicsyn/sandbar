import { z } from "zod";
import type { LedgerStore } from "./ledger";
import type { Scenario } from "./report";

export const diagnosticStages = [
  "connect",
  "create",
  "inspect",
  "exec",
  "write",
  "read",
  "compare",
  "inventory",
  "recover-create",
  "destroy",
  "confirm-cleanup",
  "close",
  "metadata",
  "checkpoint",
] as const;

const text = z.string().max(1024);

export const errorDiagnosticSchema = z.strictObject({
  name: text,
  code: text.optional(),
  message: text,
  truncated: z.boolean(),
});

export const envdSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    version: z
      .string()
      .max(80)
      .regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
  }),
  z.strictObject({ status: z.literal("unavailable"), error: errorDiagnosticSchema.optional() }),
  z.strictObject({ status: z.literal("not-collected") }),
]);

export const failureDiagnosticSchema = z.strictObject({
  stage: z.enum(diagnosticStages),
  timestamp: z.iso.datetime(),
  elapsedMs: z.number().nonnegative(),
  error: errorDiagnosticSchema,
  causes: z.array(errorDiagnosticSchema).max(2).optional(),
  overwrite: z.boolean().optional(),
  writeBytes: z.array(z.number().int().min(0).max(255)).max(32).optional(),
  writeLength: z.number().int().nonnegative().optional(),
  pagesVisited: z.number().int().nonnegative().optional(),
  itemsObserved: z.number().int().nonnegative().optional(),
  ownedResourceFound: z.boolean().optional(),
  expectedBytes: z.array(z.number().int().min(0).max(255)).max(32).optional(),
  expectedLength: z.number().int().nonnegative().optional(),
  actualBytes: z.array(z.number().int().min(0).max(255)).max(32).optional(),
  actualLength: z.number().int().nonnegative().optional(),
  bytesTruncated: z.boolean().optional(),
  expectedStdout: text.optional(),
  actualStdout: text.optional(),
  expectedStderr: text.optional(),
  actualStderr: text.optional(),
  exitCode: z.number().int().nullable().optional(),
  outputTruncated: z.boolean().optional(),
  networkPhase: z.enum(["before", "blocked", "after"]).optional(),
  expectedState: text.optional(),
  actualState: text.optional(),
});

export type FailureDiagnostic = z.infer<typeof failureDiagnosticSchema>;

export type EnvdDiagnostic = z.infer<typeof envdSchema>;

export type DiagnosticStage = (typeof diagnosticStages)[number];

/** No stacks, response bodies or recovery tokens. Redact known custody values before bounding text. */
export function redactDiagnostic(value: string, sensitive: readonly string[]): string {
  let result = value;

  for (const item of [...new Set(sensitive)].filter(Boolean).sort((a, b) => b.length - a.length))
    result = result.split(item).join("[REDACTED]");

  return (
    result
      .replace(/https?:\/\/[^\s<>"']+/gi, "[REDACTED_URL]")
      .replace(/(?:Bearer|Basic)\s+[^\s,;]+/gi, "[REDACTED_AUTH]")
      .replace(
        /["']?\b(?:api[_-]?key|authorization|token|sandbox(?:[_-]?id)?|template[_-]?id|team[_-]?id|resource[_-]?id|operation[_-]?id|submission[_-]?id|id)["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
        "[REDACTED_FIELD]",
      )

      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[REDACTED_ID]")
      .replace(/\b(?:e2b_|sb_|team_|template_|op_)[A-Za-z0-9_-]+\b/g, "[REDACTED_ID]")
      .replace(/\b(?=[A-Za-z0-9_-]{10,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g, "[REDACTED_ID]")
      .replace(/\b[a-z]{16,}\b/g, "[REDACTED_ID]")
      // oxlint-disable-next-line eslint/no-control-regex -- Strip terminal control bytes from external error messages.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
      .slice(0, 1024)
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the caught-error boundary; only explicit error fields are extracted, never serialized wholesale.
export function errorDiagnostic(error: unknown, sensitive: readonly string[]) {
  const source = error instanceof Error ? error : new Error("Non-Error thrown value (omitted)");

  const parsedCode = z
    .union([z.string(), z.number()])
    .safeParse("code" in source ? source.code : undefined);

  const code = parsedCode.success ? String(parsedCode.data) : undefined;

  return errorDiagnosticSchema.parse({
    name: redactDiagnostic(source.name, sensitive),
    code: code === undefined ? undefined : redactDiagnostic(code, sensitive),
    message: redactDiagnostic(source.message, sensitive),
    truncated: source.message.length > 1024,
  });
}

export async function sensitiveValues(ledger: LedgerStore, secrets: readonly string[]) {
  const state = await ledger.read();

  const tokenStrings = (value: import("zod").core.util.JSONType): string[] => {
    const scalar = z.string().safeParse(value);

    if (scalar.success) return [scalar.data];

    const collection = z
      .union([z.array(z.json()), z.record(z.string(), z.json())])
      .safeParse(value);

    return collection.success ? Object.values(collection.data).flatMap(tokenStrings) : [];
  };

  const refs = [
    state.createReference,
    state.destroyReference,
    ...(state.operationReferences ?? []),
  ];

  return [
    ...secrets,
    state.runId,
    state.sandboxId ?? "",
    ...(state.connection && "teamId" in state.connection
      ? [state.connection.teamId ?? "", state.connection.templateId]
      : []),
    ...refs.flatMap((ref) =>
      ref
        ? [
            ref.scope.authority.id,
            ...Object.values(ref.scope.partition),
            ref.operationId,
            ref.submissionId,
            ref.invocationKey,
            ref.sandboxId ?? "",
            ref.file?.path ?? "",
            ...tokenStrings(ref.token ?? null),
          ]
        : [],
    ),
  ];
}

export class FailureCapture {
  private readonly started = performance.now();
  private details: Partial<FailureDiagnostic> = {};
  constructor(
    private readonly ledger: LedgerStore,
    readonly scenario: Scenario,
    private stage: DiagnosticStage,
    private readonly secrets: readonly string[] = [],
  ) {}
  at(stage: DiagnosticStage) {
    this.stage = stage;
  }
  networkPhase(phase: "before" | "blocked" | "after") {
    this.details.networkPhase = phase;
  }
  file(expected: Uint8Array, overwrite: boolean) {
    this.at("write");
    this.details = {
      overwrite,
      writeBytes: Array.from(expected.slice(0, 32)),
      writeLength: expected.length,
      expectedBytes: Array.from(expected.slice(0, 32)),
      expectedLength: expected.length,
    };
  }
  observeBytes(actual: Uint8Array, expected: Uint8Array) {
    this.at("compare");
    Object.assign(this.details, {
      expectedBytes: Array.from(expected.slice(0, 32)),
      expectedLength: expected.length,
      actualBytes: Array.from(actual.slice(0, 32)),
      actualLength: actual.length,
      bytesTruncated: actual.length > 32 || expected.length > 32,
    });
  }
  compareBytes(actual: Uint8Array, expected: Uint8Array) {
    this.observeBytes(actual, expected);

    if (
      actual.length !== expected.length ||
      !actual.every((value, index) => value === expected[index])
    )
      throw new Error("File byte comparison failed");
  }
  output(
    actual: {
      stdoutText(): string;
      stderrText(): string;
      exitCode: number | null;
      truncated: boolean;
    },
    stdout: string,
    stderr: string,
  ) {
    this.at("compare");
    Object.assign(this.details, {
      expectedStdout: stdout,
      expectedStderr: stderr,
      actualStdout: actual.stdoutText(),
      actualStderr: actual.stderrText(),
      exitCode: actual.exitCode,
      outputTruncated:
        actual.truncated || actual.stdoutText().length > 1024 || actual.stderrText().length > 1024,
    });
  }
  inventory(page: number, count: number, found: boolean) {
    Object.assign(this.details, {
      pagesVisited: page,
      itemsObserved: (this.details.itemsObserved ?? 0) + count,
      ownedResourceFound: found,
    });
  }
  state(actual: string, expected: string) {
    this.at("compare");
    Object.assign(this.details, { actualState: actual, expectedState: expected });
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Every scenario catch passes its error through the field-only redactor before persistence or logging.
  async failure(error: unknown): Promise<FailureDiagnostic> {
    let sensitive;

    try {
      sensitive = await sensitiveValues(this.ledger, this.secrets);
    } catch {
      sensitive = [...this.secrets, this.ledger.runId];
    }

    const details = { ...this.details };

    for (const field of [
      "expectedStdout",
      "actualStdout",
      "expectedStderr",
      "actualStderr",
      "expectedState",
      "actualState",
    ] as const)
      if (details[field] !== undefined)
        details[field] = redactDiagnostic(details[field], sensitive);
    const causes = [];
    let current = error;

    for (let i = 0; i < 2 && current instanceof Error && current.cause !== undefined; i++) {
      current = current.cause;
      causes.push(errorDiagnostic(current, sensitive));
    }

    const diagnostic = failureDiagnosticSchema.parse({
      ...details,
      stage: this.stage,
      timestamp: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - this.started),
      error: errorDiagnostic(error, sensitive),
      causes: causes.length ? causes : undefined,
    });

    let persisted = true;

    try {
      await this.ledger.update((value) => ({
        ...value,
        diagnostics: [...(value.diagnostics ?? []), { scenario: this.scenario, ...diagnostic }],
      }));
    } catch {
      persisted = false;
    }

    console.error(
      JSON.stringify({
        type: "qualification-failure",
        scenario: this.scenario,
        persisted,
        ...diagnostic,
      }),
    );

    return diagnostic;
  }
}
