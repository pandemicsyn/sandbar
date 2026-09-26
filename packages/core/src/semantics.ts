import { CreateSandboxRequest, ExecRequest } from "@sandbar/contracts";
import { validateDriverResult, type DriverResult, type NativeRef, type NativeScope } from "@sandbar/provider-spi";

/** Values passed to a provider after the public request has passed strict validation. */
export interface CreatePlan {
  image: { kind: "prepared" | "oci"; value: string };
  networkPolicy: string;
  region?: string;
  labels?: Record<string, string>;
}
export interface ExecPlan {
  command: ExecRequest["command"];
  cwd?: string;
  env?: Record<string, string>;
  deadlineSeconds: number;
  maxOutputBytes: number;
}

export function normalizeCreate(input: unknown): CreatePlan {
  const request = CreateSandboxRequest.parse(input);
  return {
    image: request.environment.kind === "prepared"
      ? { kind: "prepared", value: request.environment.imageId }
      : { kind: "oci", value: request.environment.reference },
    networkPolicy: request.network?.policy ?? "blocked",
    region: request.region,
    labels: request.labels,
  };
}

export function normalizeExec(input: unknown): ExecPlan {
  const request = ExecRequest.parse(input);
  return {
    command: request.command,
    cwd: request.cwd,
    env: request.env,
    deadlineSeconds: request.deadlineSeconds ?? 300,
    maxOutputBytes: outputLimit(request.output),
  };
}

export function outputLimit(selection: ExecRequest["output"]): number {
  if (selection === undefined) return 1_048_576;
  const output = ExecRequest.shape.output.unwrap().parse(selection);
  return output.capture === "none" ? 0 : output.maxBytes ?? 1_048_576;
}

export function sameNativeScope(actual: NativeScope, expected: NativeScope): boolean {
  return actual.provider === expected.provider && actual.connectionId === expected.connectionId && actual.accountId === expected.accountId && actual.region === expected.region;
}
export function sameNativeRef(actual: NativeRef, expected: NativeRef): boolean {
  return actual.kind === expected.kind && actual.nativeId === expected.nativeId && sameNativeScope(actual.scope, expected.scope);
}

export interface CorrelationContext {
  submissionId: string;
  kind: "create" | "exec" | "destroy" | "file_write";
  scope: NativeScope;
  sandbox?: NativeRef;
  file?: { path: string; bytes: number };
  /** The service permits an initial completed response without an ID; observation never does. */
  requireSubmissionId?: boolean;
}

/** A mismatch is an unknown effect, never evidence that an invocation can be submitted again. */
export function correlateDriverResult(input: DriverResult, context: CorrelationContext): DriverResult {
  const result = validateDriverResult(input);
  if (result.status === "rejected") return result;
  const required = result.status !== "completed" || context.requireSubmissionId !== false;
  if ((required || result.submissionId !== undefined) && result.submissionId !== context.submissionId)
    throw new Error("Provider result submission mismatch");
  if (result.status !== "completed") return result;
  const value = result.value;
  const expectedKind = context.kind === "create" ? "sandbox" : context.kind === "exec" ? "execution" : context.kind;
  if (value.kind !== expectedKind) throw new Error("Provider result kind mismatch");
  if (value.kind === "sandbox") {
    if (value.observation.ref.kind !== "sandbox" || !sameNativeScope(value.observation.ref.scope, context.scope)) throw new Error("Provider result scope mismatch");
  } else if (value.kind === "execution") {
    if (!context.sandbox || !sameNativeRef(value.observation.sandbox, context.sandbox) || value.observation.ref.kind !== "execution" || !sameNativeScope(value.observation.ref.scope, context.scope)) throw new Error("Execution identity mismatch");
  } else if (value.kind === "destroy") {
    if (!context.sandbox || !sameNativeRef(value.observation.sandbox, context.sandbox)) throw new Error("Destroy target mismatch");
  } else {
    if (!context.sandbox || !context.file || !sameNativeRef(value.observation.sandbox, context.sandbox) || value.observation.path !== context.file.path || value.observation.bytesWritten > context.file.bytes) throw new Error("File write receipt mismatch");
  }
  return result;
}

/** Ambiguous outcomes may be observed but cannot authorize a replay or provider fallback. */
export function resultDisposition(result: DriverResult): "completed" | "definitive_rejection" | "observe_only" {
  return result.status === "completed" ? "completed" : result.status === "rejected" ? "definitive_rejection" : "observe_only";
}

export interface CapturedOutput { payload: { stdoutBase64: string; stderrBase64: string }; bytes: number; truncated: boolean }
export function captureBoundedOutput(stdoutBase64: string | undefined, stderrBase64: string | undefined, maxBytes: number): CapturedOutput {
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 1_048_576) throw new RangeError("Invalid output bound");
  const stdout = stdoutBase64 ? Buffer.from(stdoutBase64, "base64") : Buffer.alloc(0);
  const stderr = stderrBase64 ? Buffer.from(stderrBase64, "base64") : Buffer.alloc(0);
  const out = stdout.subarray(0, maxBytes);
  const err = stderr.subarray(0, Math.max(0, maxBytes - out.length));
  return { payload: { stdoutBase64: out.toString("base64"), stderrBase64: err.toString("base64") }, bytes: out.length + err.length, truncated: stdout.length + stderr.length > maxBytes };
}
