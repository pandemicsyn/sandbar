import { z } from "zod";

export const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const InvocationKey = z.uuidv7();

export const ImageSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("prepared"), imageId: z.string().min(1).max(512) }),
  z.strictObject({ kind: z.literal("oci"), reference: z.string().min(1).max(1024) }),
]);

export const NetworkSelection = z.strictObject({ policy: z.string().min(1).max(128) });

export const CreateSandboxInput = z.strictObject({
  environment: ImageSource,
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

export const FilePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      path.startsWith("/") &&
      !path.includes("\0") &&
      !path.split("/").some((segment) => segment === "." || segment === ".."),
  );

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

export type CreateSandboxInput = z.infer<typeof CreateSandboxInput>;

export type ExecRequest = z.infer<typeof ExecRequest>;

export type ExecCommand = z.infer<typeof ExecCommand>;

export type SafeError = z.infer<typeof SafeError>;

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
