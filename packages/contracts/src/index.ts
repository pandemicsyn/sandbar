import { z } from "zod";

// Inputs are strict so a misspelled security or lifecycle setting cannot be ignored.
// Outputs intentionally strip additive fields when decoded by older clients.
export const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const Rfc3339 = z.iso.datetime({ offset: true });

export const InvocationKey = z.uuidv7();

export const ProjectPath = z.strictObject({ projectId: Id });

export const SandboxPath = ProjectPath.extend({ sandboxId: Id });

export const OperationPath = ProjectPath.extend({ operationId: Id });

export const ImageSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("prepared"), imageId: Id }),
  z.strictObject({ kind: z.literal("oci"), reference: z.string().min(1).max(1024) }),
]);

export const NetworkSelection = z.strictObject({ policy: z.string().min(1).max(128) });

const ImageSourceResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepared"), imageId: Id }),
  z.object({ kind: z.literal("oci"), reference: z.string().min(1).max(1024) }),
]);

const NetworkSelectionResponse = z.object({ policy: z.string().min(1).max(128) });

export const CreateSandboxRequest = z.strictObject({
  environment: ImageSource,
  connectionId: Id.optional(),
  region: z.string().min(1).max(128).optional(),
  network: NetworkSelection.optional(),
  labels: z.record(z.string().min(1).max(64), z.string().max(256)).optional(),
});

export const ExecCommand = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("argv"), argv: z.array(z.string().max(8192)).min(1).max(128) }),
  z.strictObject({ kind: z.literal("shell"), script: z.string().min(1).max(65536) }),
]);

export const ExecRequest = z.strictObject({
  command: ExecCommand,
  cwd: z.string().min(1).max(4096).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192)).optional(),
  deadlineSeconds: z.number().int().min(1).max(3600).optional(),
  output: z
    .strictObject({
      capture: z.enum(["bounded", "none"]),
      maxBytes: z.number().int().min(0).max(1048576).optional(),
    })
    .optional(),
});

export const Effect = z.enum(["none", "applied", "partial", "possible", "unknown"]);

export const ErrorCode = z.enum([
  "INVALID_ARGUMENT",
  "UNSUPPORTED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "CAPACITY",
  "RATE_LIMIT",
  "INVOCATION_EXPIRED",
  "UNAVAILABLE",
  "TIMEOUT",
  "OUTPUT_CAPACITY",
  "OUTCOME_UNKNOWN",
  "INTERNAL",
]);

export const SafeError = z.object({
  code: ErrorCode,
  message: z.string().max(1024),
  effect: Effect,
  retry: z.enum(["never", "same_invocation", "observe_only", "new_invocation_with_risk"]),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});

export const ErrorResponse = z.object({ error: SafeError });

export const OperationStatus = z.enum(["queued", "running", "succeeded", "failed", "unknown"]);

export const FileReceipt = z.object({
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  complete: z.boolean(),
  effect: Effect,
});

const CreateOperationResult = z.object({ kind: z.literal("create"), sandboxId: Id });

const ExecOperationResult = z.object({ kind: z.literal("exec"), executionId: Id });

const DestroyOperationResult = z.object({
  kind: z.literal("destroy"),
  computeStopped: z.boolean(),
  retainedResources: z.array(z.string()),
});

const FileWriteOperationResult = z.object({ kind: z.literal("file_write"), receipt: FileReceipt });

export const OperationResult = z.discriminatedUnion("kind", [
  CreateOperationResult,
  ExecOperationResult,
  DestroyOperationResult,
  FileWriteOperationResult,
]);

const OperationBase = z.object({
  id: Id,
  projectId: Id,
  sandboxId: Id.optional(),
  executionId: Id.optional(),
  status: OperationStatus,
  phase: z.string().max(128),
  createdAt: Rfc3339,
  updatedAt: Rfc3339,
  effect: Effect,
  error: SafeError.optional(),
  recovery: z.array(z.enum(["check_again", "inspect_candidates", "acknowledge", "run_again"])),
});

const CreateOperation = OperationBase.extend({
  kind: z.literal("create"),
  result: CreateOperationResult.optional(),
});

const ExecOperation = OperationBase.extend({
  kind: z.literal("exec"),
  result: ExecOperationResult.optional(),
});

const DestroyOperation = OperationBase.extend({
  kind: z.literal("destroy"),
  result: DestroyOperationResult.optional(),
});

const FileWriteOperation = OperationBase.extend({
  kind: z.literal("file_write"),
  result: FileWriteOperationResult.optional(),
});

export const Operation = z
  .discriminatedUnion("kind", [
    CreateOperation,
    ExecOperation,
    DestroyOperation,
    FileWriteOperation,
  ])
  .superRefine((operation, context) => {
    if (operation.status === "succeeded" && (!operation.result || operation.error)) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "Succeeded operations require a result and cannot carry an error",
      });
    }

    if (operation.status === "failed" && (!operation.error || operation.result)) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed operations require an error and cannot carry a result",
      });
    }
  })
  .describe(
    "A succeeded operation has a same-kind result and no error. A failed operation has an error and no result. Queued, running, and unknown operations may omit both payloads.",
  );

export const AcceptedOperation = z.object({ operation: Operation });

export const Sandbox = z.object({
  id: Id,
  projectId: Id,
  connectionId: Id,
  desiredState: z.enum(["running", "destroyed"]),
  observedState: z.enum([
    "resolving",
    "provisioning",
    "running",
    "destroying",
    "destroyed",
    "unknown",
  ]),
  observedAt: Rfc3339.optional(),
  revision: z.number().int().nonnegative(),
  currentOperationId: Id.optional(),
  environment: ImageSourceResponse,
  network: NetworkSelectionResponse,
  labels: z.record(z.string(), z.string()),
});

export const SandboxPage = z.object({
  items: z.array(Sandbox),
  nextCursor: z.string().optional(),
  asOf: Rfc3339,
});

export const OutputAvailability = z.enum([
  "captured",
  "truncated",
  "not_captured",
  "expired",
  "evicted",
]);

const MAX_CAPTURED_BYTES = 1024 * 1024;

const MAX_BASE64_CAPTURE_LENGTH = 4 * Math.ceil(MAX_CAPTURED_BYTES / 3);

const decodedBase64Length = (value: string) =>
  (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);

export const Execution = z
  .object({
    id: Id,
    projectId: Id,
    sandboxId: Id,
    operationId: Id,
    status: z.enum(["queued", "running", "completed", "unknown"]),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().optional(),
    outputAvailability: OutputAvailability,
    capturedBytes: z.number().int().min(0).max(MAX_CAPTURED_BYTES),
    stdoutBase64: z.base64().max(MAX_BASE64_CAPTURE_LENGTH).optional(),
    stderrBase64: z.base64().max(MAX_BASE64_CAPTURE_LENGTH).optional(),
  })
  .superRefine((execution, context) => {
    const outputBytes =
      decodedBase64Length(execution.stdoutBase64 ?? "") +
      decodedBase64Length(execution.stderrBase64 ?? "");

    if (outputBytes > MAX_CAPTURED_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["capturedBytes"],
        message: "Output exceeds 1 MiB",
      });
    }

    if (
      execution.outputAvailability === "captured" ||
      execution.outputAvailability === "truncated"
    ) {
      if (execution.capturedBytes !== outputBytes) {
        context.addIssue({
          code: "custom",
          path: ["capturedBytes"],
          message: "Captured byte count must equal the decoded output length",
        });
      }
    } else if (
      outputBytes !== 0 ||
      (execution.outputAvailability === "not_captured" && execution.capturedBytes !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outputAvailability"],
        message: "Unavailable output cannot contain captured bytes",
      });
    }
  })
  .describe(
    "Captured stdoutBase64 and stderrBase64 decode to at most 1 MiB combined. For captured or truncated output, capturedBytes equals their decoded total. Not-captured, expired, and evicted output has no byte fields; not-captured output has capturedBytes 0.",
  );

export const AcceptedExecution = z
  .object({ operation: ExecOperation, execution: Execution })
  .refine(
    ({ operation, execution }) =>
      Operation.safeParse(operation).success &&
      operation.id === execution.operationId &&
      operation.executionId === execution.id &&
      operation.projectId === execution.projectId &&
      operation.sandboxId === execution.sandboxId,
    {
      message: "Accepted execution must belong to its operation, project, and sandbox",
    },
  )
  .describe(
    "The operation must have kind exec and satisfy terminal status payload rules; operation.id equals execution.operationId, operation.executionId equals execution.id, and their projectId and sandboxId values match.",
  );

export const FileReadHeaders = z.object({
  contentType: z.literal("application/octet-stream"),
  contentLength: z.number().int().nonnegative(),
});

export const SetupRequest = z.strictObject({ setupToken: z.string().min(1).max(512) });

export const SessionRequest = z.strictObject({ token: z.string().min(1).max(512) });

export const SessionResponse = z.object({
  operatorId: Id,
  csrfToken: z.string().min(1),
  token: z.string().optional(),
});

export const CreateProjectRequest = z.strictObject({ name: z.string().min(1).max(120) });

export const Project = z.object({ id: Id, name: z.string(), createdAt: Rfc3339 });

export const ProjectPage = z.object({ items: z.array(Project) });

export const CreateProviderConnectionRequest = z.strictObject({
  provider: z.literal("fake"),
  name: z.string().min(1).max(120),
  // A fake connection has no vendor secret. URL/token are service configuration, not public API fields.
});

export const ProviderConnection = z.object({
  id: Id,
  projectId: Id,
  provider: z.literal("fake"),
  name: z.string(),
  status: z.enum(["unverified", "verified", "draining"]),
  nativeScope: z.object({ accountId: z.string(), region: z.string().optional() }).optional(),
  capabilities: z
    .object({ create: z.boolean(), exec: z.boolean(), files: z.boolean(), destroy: z.boolean() })
    .optional(),
});

export const ProviderConnectionPage = z.object({ items: z.array(ProviderConnection) });

export const SandboxListQuery = z.strictObject({
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  connectionId: Id.optional(),
  state: z
    .enum(["resolving", "provisioning", "running", "destroying", "destroyed", "unknown"])
    .optional(),
  q: z.string().max(64).optional(),
});

export const StreamFrame = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stdout"),
    executionId: Id,
    sequence: z.number().int().nonnegative(),
    bytesBase64: z.base64(),
  }),
  z.object({
    kind: z.literal("stderr"),
    executionId: Id,
    sequence: z.number().int().nonnegative(),
    bytesBase64: z.base64(),
  }),
  z
    .object({
      kind: z.literal("gap"),
      executionId: Id,
      fromSequence: z.number().int().nonnegative(),
      toSequence: z.number().int().nonnegative(),
    })
    .refine((frame) => frame.fromSequence <= frame.toSequence, {
      path: ["toSequence"],
      message: "Gap end must not precede start",
    })
    .describe(
      "Missing inclusive sequence range; fromSequence must be less than or equal to toSequence.",
    ),
  z.object({
    kind: z.literal("exit"),
    executionId: Id,
    exitCode: z.number().int().nullable(),
    signal: z.string().optional(),
  }),
]);

export type CreateSandboxRequest = z.infer<typeof CreateSandboxRequest>;

export type ExecRequest = z.infer<typeof ExecRequest>;

export type Operation = z.infer<typeof Operation>;

export type Sandbox = z.infer<typeof Sandbox>;

export type Execution = z.infer<typeof Execution>;

export type SafeError = z.infer<typeof SafeError>;

export type ExecCommand = z.infer<typeof ExecCommand>;

export type Project = z.infer<typeof Project>;

export type ProviderConnection = z.infer<typeof ProviderConnection>;

// Internal JS/Bun intent serialization. The server computes this hash from validated parsed input;
// clients only repeat the same request and Idempotency-Key. This is not a cross-language wire format.
export type CanonicalJsonValue =
  | null
  | string
  | boolean
  | number
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue | undefined };

export function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null) return "null";

  const stringValue = z.string().safeParse(value);

  if (stringValue.success) return JSON.stringify(stringValue.data);

  const booleanValue = z.boolean().safeParse(value);

  if (booleanValue.success) return JSON.stringify(booleanValue.data);

  const numberValue = z.number().safeParse(value);

  if (numberValue.success && Number.isFinite(numberValue.data))
    return JSON.stringify(numberValue.data);

  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  if (!z.record(z.string(), z.any()).safeParse(value).success)
    throw new TypeError("Intent must be JSON-compatible");

  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

export async function intentSha256(input: CanonicalJsonValue): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(input)),
  );

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
