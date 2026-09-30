import { z } from "zod";

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
  readbackError: errorDiagnosticSchema.optional(),
  networkPhase: z.enum(["before", "blocked", "after"]).optional(),
  expectedState: text.optional(),
  actualState: text.optional(),
});

export type FailureDiagnostic = z.infer<typeof failureDiagnosticSchema>;

export type EnvdDiagnostic = z.infer<typeof envdSchema>;

export type DiagnosticStage = (typeof diagnosticStages)[number];
