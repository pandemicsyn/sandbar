import { z } from "zod";

// Inputs are strict so a misspelled security or lifecycle setting cannot be ignored.
// Outputs intentionally strip additive fields when decoded by older clients.
import { Id, ImageSource, CreateSandboxInput, Effect, SafeError } from "sandbar-adapter/portable";

export {
  Id,
  InvocationKey,
  ImageSource,
  NetworkSelection,
  ExecCommand,
  ExecRequest,
  Effect,
  ErrorCode,
  SafeError,
  canonicalJson,
  intentSha256,
} from "sandbar-adapter/portable";

export type { CanonicalJsonValue } from "sandbar-adapter/portable";

export const Rfc3339 = z.iso.datetime({ offset: true });

export const ProjectPath = z.strictObject({ projectId: Id });

export const SandboxPath = ProjectPath.extend({ sandboxId: Id });

export const OperationPath = ProjectPath.extend({ operationId: Id });

export const BuildScope = z.strictObject({
  authority: z.strictObject({ kind: z.string().min(1).max(64), id: z.string().min(1).max(512) }),
  partition: z.record(z.string().min(1).max(64), z.string().max(2048)),
});

export const PreparedBinding = z.strictObject({
  provider: z.string().min(1).max(128),
  scope: BuildScope,
  connectionId: Id.optional(),
});

export const CreateSandboxRequest = CreateSandboxInput.extend({
  connectionId: Id.optional(),
  preparedBinding: PreparedBinding.optional(),
});

export const ImageBuildRequest = z.strictObject({
  source: z.strictObject({ kind: z.literal("oci"), value: z.string().min(1).max(1024) }),
  connectionId: Id.optional(),
});

export const RetainedArtifact = z.strictObject({
  kind: z.string().min(1).max(128),
  id: z.string().min(1).max(512),
  ownership: z.enum(["verified", "unknown"]),
  cleanup: z.enum(["manual", "provider_expiry", "none_known"]),
});

export const PreparedImage = z.strictObject({
  kind: z.literal("prepared"),
  value: ImageSource.options[0].shape.imageId,
  provider: z.string().min(1).max(128),
  scope: BuildScope,
  connectionId: Id,
});

const ImageSourceResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepared"), imageId: ImageSource.options[0].shape.imageId }),
  z.object({ kind: z.literal("oci"), reference: z.string().min(1).max(1024) }),
]);

const NetworkSelectionResponse = z.object({ policy: z.string().min(1).max(128) });

export const ErrorResponse = z.object({ error: SafeError });

export const OperationStatus = z.enum(["queued", "running", "succeeded", "failed", "unknown"]);

export const FileReceipt = z.object({
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  complete: z.boolean(),
  effect: Effect,
});

export const FileWriteQuery = z.strictObject({
  path: z.string(),
  overwrite: z.enum(["true", "false"]).optional(),
});

const CreateOperationResult = z.object({ kind: z.literal("create"), sandboxId: Id });

const ExecOperationResult = z.object({ kind: z.literal("exec"), executionId: Id });

const DestroyOperationResult = z.object({
  kind: z.literal("destroy"),
  computeStopped: z.boolean(),
  retainedResources: z.array(z.string()),
});

const FileWriteOperationResult = z.object({ kind: z.literal("file_write"), receipt: FileReceipt });

const ImageBuildOperationResult = z.object({
  kind: z.literal("image_build"),
  prepared: PreparedImage,
  retainedResources: z.array(RetainedArtifact).max(128),
});

export const OperationResult = z.discriminatedUnion("kind", [
  CreateOperationResult,
  ExecOperationResult,
  DestroyOperationResult,
  FileWriteOperationResult,
  ImageBuildOperationResult,
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

const ImageBuildOperation = OperationBase.extend({
  kind: z.literal("image_build"),
  result: ImageBuildOperationResult.optional(),
});

export const Operation = z
  .discriminatedUnion("kind", [
    CreateOperation,
    ExecOperation,
    DestroyOperation,
    FileWriteOperation,
    ImageBuildOperation,
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

    if (operation.error && operation.effect !== operation.error.effect) {
      context.addIssue({
        code: "custom",
        path: ["error", "effect"],
        message: "Error effect must match the operation effect",
      });
    }

    if (
      operation.kind === "file_write" &&
      operation.result &&
      operation.effect !== operation.result.receipt.effect
    ) {
      context.addIssue({
        code: "custom",
        path: ["result", "receipt", "effect"],
        message: "File receipt effect must match the operation effect",
      });
    }

    if (
      operation.kind === "create" &&
      operation.result &&
      operation.sandboxId !== undefined &&
      operation.result.sandboxId !== operation.sandboxId
    ) {
      context.addIssue({
        code: "custom",
        path: ["result", "sandboxId"],
        message: "Create result sandbox ID must match the operation",
      });
    }

    if (
      operation.kind === "exec" &&
      operation.result &&
      operation.executionId !== undefined &&
      operation.result.executionId !== operation.executionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["result", "executionId"],
        message: "Exec result execution ID must match the operation",
      });
    }
  })
  .describe(
    "A succeeded operation has a same-kind result and no error. A failed operation has an error and no result. Queued, running, and unknown operations may omit both payloads. When present, an error effect or file-write receipt effect matches the operation effect; a create result sandboxId or exec result executionId matches the corresponding operation ID field.",
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
    "The operation must have kind exec and satisfy terminal status payload rules; operation.id equals execution.operationId, operation.executionId and any result.executionId equal execution.id, and their projectId and sandboxId values match.",
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

export const ProviderName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);

export const CreateProviderConnectionRequest = z.strictObject({
  provider: ProviderName,
  name: z.string().min(1).max(120),
  credentials: z.json().optional(),
  configuration: z.json().optional(),
});

export const ProviderConnection = z.object({
  id: Id,
  projectId: Id,
  provider: ProviderName,
  name: z.string(),
  status: z.enum(["unverified", "verified", "draining"]),
  nativeScope: z
    .object({
      accountId: z.string().optional(),
      resourceScope: z.object({ kind: z.literal("app"), id: z.string() }).optional(),
      region: z.string().optional(),
      endpoint: z.url().optional(),
      adapterScope: z
        .object({
          authority: z.object({ kind: z.string(), id: z.string() }),
          partition: z.record(z.string(), z.string()),
        })
        .optional(),
    })
    .optional(),
  capabilities: z
    .object({ create: z.boolean(), exec: z.boolean(), files: z.boolean(), destroy: z.boolean() })
    .optional(),
});

export const ProviderConnectionPage = z.object({ items: z.array(ProviderConnection) });

export const ProviderCatalog = z.object({
  items: z.array(
    z.object({
      name: ProviderName,
      displayName: z.string().min(1).max(120),
      configurationSchema: z.json(),
      credentialsSchema: z.json(),
    }),
  ),
});

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

export type Operation = z.infer<typeof Operation>;

export type Sandbox = z.infer<typeof Sandbox>;

export type Execution = z.infer<typeof Execution>;

export type Project = z.infer<typeof Project>;

export type ProviderConnection = z.infer<typeof ProviderConnection>;

export { Capabilities, SnapshotCheck, CreateCheck, SnapshotRequest } from "sandbar-adapter";
