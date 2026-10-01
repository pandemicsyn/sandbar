import type { OperationOutcome } from "sandbar-adapter";
import { certifyRecoveryReference } from "./recovery-diagnostics";
import {
  SnapshotRequest,
  MountSpec,
  type Capabilities,
  type DirectCapabilities,
  type DestroyValue,
  type Support,
  type SnapshotPlan,
  type CreatePlan,
} from "sandbar-adapter";
import type {
  AdapterDirectClient,
  AdapterSandbox,
  AdapterRecoveryReference,
} from "./adapter-direct";
import type { RetainedArtifact, Scope } from "sandbar-adapter";
import { z } from "zod";
import {
  CreateSandboxInput,
  ExecCommand,
  ExecRequest,
  FilePath,
  Id,
  InvocationKey,
  type SafeError,
} from "sandbar-adapter/portable";

export type PreparedImage = {
  kind: "prepared";
  value: string;
  provider: string;
  scope: Scope;
  connectionId?: string;
};

export type ImageBuildResult = {
  prepared: PreparedImage;
  retainedResources: RetainedArtifact[];
};

export type OciImage = { kind: "oci"; value: string };

export type ImageInput =
  | {
      kind: "prepared";
      value: string;
      binding?: { provider: string; scope: Scope; connectionId?: string };
    }
  | OciImage;

export const Image = {
  prepared(value: string | PreparedImage): ImageInput {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The public overload intentionally accepts either a raw template ID or a scoped result.
    return typeof value === "string"
      ? { kind: "prepared", value }
      : {
          kind: "prepared",
          value: value.value,
          binding: {
            provider: value.provider,
            scope: structuredClone(value.scope),
            connectionId: value.connectionId,
          },
        };
  },
  oci(value: string): OciImage {
    return { kind: "oci", value };
  },
};

export type CreateInput = {
  environment: ImageInput;
  requirements?: { snapshot: SnapshotRequest };
  mounts?: MountSpec[];
  networkPolicy?: string;
  region?: string;
  labels?: Record<string, string>;
};

export type ExecInput = {
  command: ExecCommand;
  cwd?: string;
  env?: Record<string, string>;
  deadlineSeconds?: number;
  maxOutputBytes?: number;
};

export type ExecOutput = {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
  stdoutText(maxBytes?: number): string;
  stderrText(maxBytes?: number): string;
};

export type RecoveryReference = {
  version: 2;
  mode: "remote";
  kind: "create" | "exec" | "destroy" | "file_write" | "image_build";
  invocationKey: string;
  operationId?: string;
  resourceId?: string;
  file?: { path: string; bytes: number };
  service: { url: string; projectId: string };
};

export interface OperationHandle<T> {
  readonly durability: "process" | "service";
  readonly reference: RecoveryReference | AdapterRecoveryReference;
  observe(): Promise<T | null>;
  wait(options?: { signal?: AbortSignal; pollMs?: number }): Promise<T>;
}

/** Public direct connection surface, including snapshots and retained volumes. */
export type DirectSandbarClient = Pick<
  AdapterDirectClient,
  | "provider"
  | "capabilities"
  | "images"
  | "sandboxes"
  | "snapshots"
  | "volumes"
  | "operations"
  | "recover"
  | "close"
>;

/** Public direct sandbox surface, including capture and provider support checks. */
export type DirectSandboxHandle = Pick<AdapterSandbox, keyof AdapterSandbox>;

/** Compatibility surface shared with the service client. Use DirectSandboxHandle for direct connections. */
export interface SandboxHandle {
  readonly id: string;
  capabilities(): Promise<Capabilities | DirectCapabilities>;
  checkSnapshot(request?: SnapshotRequest): Promise<Support<SnapshotPlan>>;
  inspect(): Promise<{ state: string; observedAt?: string }>;
  exec(
    input: ExecInput | readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<ExecOutput>;
  submitExec(
    input: ExecInput | readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<OperationHandle<ExecOutput>>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    bytes: Uint8Array,
    options?: { overwrite?: boolean; signal?: AbortSignal },
  ): Promise<void>;
  destroy(options?: {
    signal?: AbortSignal;
    storage?: "require-durable" | "allow-unconfirmed";
  }): Promise<void | DestroyValue>;
}

/** Compatibility surface shared with the service client. Use DirectSandbarClient for direct connections. */
export interface SandbarClient {
  capabilities(): Promise<Capabilities | DirectCapabilities>;
  readonly images: {
    build(
      input: { source: { kind: "oci"; value: string } },
      options?: { signal?: AbortSignal },
    ): Promise<ImageBuildResult>;
    submitBuild(
      input: { source: { kind: "oci"; value: string } },
      options?: { signal?: AbortSignal },
    ): Promise<OperationHandle<ImageBuildResult>>;
  };
  readonly sandboxes: {
    checkCreate(input: CreateInput): Promise<Support<CreatePlan>>;
    create(input: CreateInput, options?: { signal?: AbortSignal }): Promise<SandboxHandle>;
    submitCreate(
      input: CreateInput,
      options?: { signal?: AbortSignal },
    ): Promise<OperationHandle<SandboxHandle>>;
  };
  recover(
    reference: RecoveryReference | AdapterRecoveryReference,
  ): Promise<OperationHandle<unknown>>;
  close(): Promise<void>;
}

export class SandbarError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly effect: SafeError["effect"] = "none",
    readonly outcome?: OperationOutcome,
    readonly reference?: RecoveryReference | AdapterRecoveryReference,
  ) {
    super(message);
    this.name = "SandbarError";
  }
}

export class UnsupportedFeatureError extends SandbarError {
  constructor(
    readonly feature: string,
    readonly unmetRequirements: readonly string[],
  ) {
    super("UNSUPPORTED", `${feature} is unsupported: ${unmetRequirements.join("; ")}`, "none");
    this.name = "UnsupportedFeatureError";
  }
}

export class OutcomeUnknownError<
  R extends RecoveryReference | AdapterRecoveryReference = RecoveryReference,
> extends SandbarError {
  constructor(
    readonly reference: R,
    message = "Outcome unknown; investigate without blindly resubmitting",
    outcome?: OperationOutcome,
  ) {
    super("OUTCOME_UNKNOWN", message, "possible", outcome);
    this.name = "OutcomeUnknownError";
  }
}

export class WaitAbortedError<
  R extends RecoveryReference | AdapterRecoveryReference = RecoveryReference,
> extends SandbarError {
  readonly cause: unknown;
  constructor(
    readonly reference: R,
    reason: AbortSignal["reason"],
    outcome?: OperationOutcome,
  ) {
    super(
      "WAIT_ABORTED",
      "Waiting stopped after submission; recover with this reference",
      "possible",
      outcome,
    );
    this.name = "AbortError";
    this.cause = reason;
  }
}

export class NonzeroExitError extends SandbarError {
  constructor(readonly result: ExecOutput) {
    super("NONZERO_EXIT", `Command exited with code ${result.exitCode}`, "applied");
    this.name = "NonzeroExitError";
  }
}

export class NoExitCodeError extends SandbarError {
  constructor(readonly result: ExecOutput) {
    super("EXIT_STATUS_UNKNOWN", "Execution completed without an exit code", "applied");
    this.name = "NoExitCodeError";
  }
}

export function newInvocationKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const millis = Date.now();

  for (let i = 0; i < 6; i++) bytes[5 - i] = Math.floor(millis / 2 ** (i * 8)) & 255;
  bytes[6] = (bytes[6]! & 15) | 0x70;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function outputText(bytes: Uint8Array, maxBytes = 16_384): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1_048_576)
    throw new RangeError("maxBytes must be between 0 and 1048576");
  const slice = bytes.subarray(0, maxBytes);

  return new TextDecoder().decode(slice) + (bytes.length > slice.length ? "…" : "");
}

export function validateFilePath(path: string): string {
  if (!FilePath.safeParse(path).success)
    throw new SandbarError("INVALID_ARGUMENT", "Invalid absolute file path");

  return path;
}

export function execOutput(
  exitCode: number | null,
  stdout: Uint8Array,
  stderr: Uint8Array,
  truncated: boolean,
): ExecOutput {
  return {
    exitCode,
    stdout,
    stderr,
    truncated,
    stdoutText: (max) => outputText(stdout, max),
    stderrText: (max) => outputText(stderr, max),
  };
}

export function checkExec(result: ExecOutput): ExecOutput {
  if (result.exitCode === null) throw new NoExitCodeError(result);

  if (result.exitCode !== 0) throw new NonzeroExitError(result);

  return result;
}

export function validateCreate(input: CreateInput): CreateInput {
  const parsed = z
    .strictObject({
      environment: z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("prepared"),
          value: z.string().min(1),
          binding: z
            .strictObject({
              provider: z.string().min(1).max(128),
              connectionId: z.string().min(1).max(128).optional(),
              scope: z.strictObject({
                authority: z.strictObject({
                  kind: z.string().min(1).max(64),
                  id: z.string().min(1).max(512),
                }),
                partition: z.record(z.string().min(1).max(64), z.string().max(2048)),
              }),
            })
            .optional(),
        }),
        z.strictObject({ kind: z.literal("oci"), value: z.string().min(1) }),
      ]),
      requirements: z.strictObject({ snapshot: SnapshotRequest }).optional(),
      mounts: z.array(MountSpec).max(32).optional(),
      networkPolicy: z.string().min(1).max(128).optional(),
      region: z.string().min(1).max(128).optional(),
      labels: z.record(z.string(), z.string()).optional(),
    })
    .safeParse(input);

  if (!parsed.success || !parsed.data.environment.value.trim())
    throw new SandbarError("INVALID_ARGUMENT", "A prepared or OCI image is required");

  const contract = CreateSandboxInput.safeParse({
    environment:
      parsed.data.environment.kind === "prepared"
        ? { kind: "prepared", imageId: parsed.data.environment.value }
        : { kind: "oci", reference: parsed.data.environment.value },
    network: { policy: parsed.data.networkPolicy ?? "blocked" },
    requirements: parsed.data.requirements,
    region: parsed.data.region,
    labels: parsed.data.labels,
  });

  if (!contract.success) throw new SandbarError("INVALID_ARGUMENT", "Invalid create request");

  return { ...parsed.data, networkPolicy: parsed.data.networkPolicy ?? "blocked" };
}

function isArgumentArray(input: ExecInput | readonly string[]): input is readonly string[] {
  return Array.isArray(input);
}

export function validateExec(
  input: ExecInput | readonly string[],
): Required<Pick<ExecInput, "command" | "deadlineSeconds" | "maxOutputBytes">> & ExecInput {
  const request = isArgumentArray(input)
    ? { command: { kind: "argv" as const, argv: [...input] } }
    : input;

  const parsed = ExecRequest.safeParse({
    command: request?.command,
    cwd: request?.cwd,
    env: request?.env,
    deadlineSeconds: request?.deadlineSeconds,
    output: { capture: "bounded", maxBytes: request?.maxOutputBytes ?? 1_048_576 },
  });

  if (!parsed.success) throw new SandbarError("INVALID_ARGUMENT", "Invalid execution request");

  return {
    command: parsed.data.command,
    cwd: parsed.data.cwd,
    env: parsed.data.env,
    deadlineSeconds: parsed.data.deadlineSeconds ?? 300,
    maxOutputBytes: parsed.data.output?.maxBytes ?? 1_048_576,
  };
}

export function validateReference(value: RecoveryReference): RecoveryReference {
  const schema = z.strictObject({
    version: z.literal(2),
    mode: z.literal("remote"),
    kind: z.enum(["create", "exec", "destroy", "file_write", "image_build"]),
    invocationKey: InvocationKey,
    operationId: Id.optional(),
    resourceId: Id.optional(),
    file: z
      .strictObject({
        path: z.string().startsWith("/").max(4096),
        bytes: z.number().int().nonnegative().max(1_048_576),
      })
      .optional(),
    service: z.strictObject({ url: z.url(), projectId: Id }),
  });

  const parsed = schema.safeParse(value);

  if (!parsed.success) throw new SandbarError("INVALID_ARGUMENT", "Invalid recovery reference");
  const ref = parsed.data;

  if (ref.file) validateFilePath(ref.file.path);

  if (
    (ref.kind === "file_write") !== !!ref.file ||
    (ref.kind === "create" || ref.kind === "image_build" ? !!ref.resourceId : !ref.resourceId)
  )
    throw new SandbarError("INVALID_ARGUMENT", "Recovery fields do not match operation kind");

  return structuredClone(ref);
}

export function sealedReference(value: RecoveryReference): RecoveryReference {
  const ref = validateReference(value);

  if (ref.file) Object.freeze(ref.file);
  Object.freeze(ref.service);

  return certifyRecoveryReference(Object.freeze(ref));
}

export function waitDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);

    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);

    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };

    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function rethrowCloseWithReference(
  error: Error,
  reference: RecoveryReference,
  signal?: AbortSignal,
): never {
  if (error instanceof SandbarError && error.code === "CLIENT_CLOSED")
    throw new OutcomeUnknownError(
      reference,
      "Client closed after submission; recover with this reference",
    );

  if (signal?.aborted) throw new WaitAbortedError(reference, signal.reason);
  throw error;
}

export async function awaitSubmission<T>(
  work: Promise<T>,
  closedSignal: AbortSignal,
  signal: AbortSignal | undefined,
  reference: () => RecoveryReference | undefined,
): Promise<T> {
  const combined = signal ? AbortSignal.any([signal, closedSignal]) : closedSignal;

  try {
    return await raceAbort(work, combined);
  } catch (error) {
    const known = reference();

    if (known && closedSignal.aborted)
      throw new OutcomeUnknownError(
        known,
        "Client closed after submission; recover with this reference",
      );

    if (known && signal?.aborted) throw new WaitAbortedError(known, signal.reason);
    throw error;
  }
}

/** Validate caller input only; native response validation must remain separate. */
export function validateResourceInput<S extends z.ZodType>(
  schema: S,
  value: z.input<S>,
  message: string,
): z.output<S> {
  const parsed = schema.safeParse(value);

  if (!parsed.success) throw new SandbarError("INVALID_ARGUMENT", message);

  return parsed.data;
}
