import { z } from "zod";

const ErrorName = z.enum([
  "Error",
  "TypeError",
  "AbortError",
  "SandboxError",
  "TimeoutError",
  "InvalidArgumentError",
  "NotEnoughSpaceError",
  "AuthenticationError",
  "FileNotFoundError",
  "SandboxNotFoundError",
  "RateLimitError",
  "ServiceBusyError",
  "UnknownError",
]);

export const WriteFailure = z.strictObject({
  stage: z.enum(["connect", "upload", "link", "unknown"]),
  errorName: ErrorName,
  httpStatus: z.number().int().min(100).max(599).optional(),
});

type Failure = z.infer<typeof WriteFailure>;

/** Contains classification only; native messages, causes and IDs never enter recovery. */
export class E2BWriteFailure extends Error {
  constructor(readonly failure: Failure) {
    super("E2B native file write failed");
    this.name = "E2BWriteFailure";
  }
}

// oxlint-disable anti-slop/no-unknown-parameters -- Native exceptions cross this boundary and only allowlisted classification is retained.
export function classifyWriteFailure(
  error: unknown,
  stage: Failure["stage"],
  status?: number,
): Failure {
  if (error instanceof E2BWriteFailure) return WriteFailure.parse(error.failure);
  const name = ErrorName.safeParse(error instanceof Error ? error.name : undefined);

  const nativeStatus =
    error instanceof Error && "statusCode" in error ? error.statusCode : undefined;

  const httpStatus = z
    .number()
    .int()
    .min(100)
    .max(599)
    .safeParse(status ?? nativeStatus);

  const failure: Failure = { stage, errorName: name.success ? name.data : "UnknownError" };

  if (httpStatus.success) failure.httpStatus = httpStatus.data;

  return failure;
}

export function writeFailureReason(reason: string, failure?: Failure): string {
  if (!failure) return reason;

  return `${reason}; native write failure: stage=${failure.stage}, error=${failure.errorName}, httpStatus=${failure.httpStatus ?? "unavailable"}`;
}
