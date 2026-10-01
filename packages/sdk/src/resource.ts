import type { OperationOutcome } from "sandbar-adapter";
import { SnapshotRequest, MountSpec } from "sandbar-adapter";
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
  type SafeError,
} from "sandbar-adapter/portable";

export type PreparedImage = {
  kind: "prepared";
  value: string;
  provider: string;
  scope: Scope;
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
      binding?: { provider: string; scope: Scope };
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

export type OutputPreview = { text: string; shortened: boolean };

export type ExecOutput = {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
  stdoutText(maxBytes?: number): string;
  stdoutText(options: { full: true }): string;
  stderrText(maxBytes?: number): string;
  stderrText(options: { full: true }): string;
  stdoutPreview(options?: { maxBytes?: number }): OutputPreview;
  stderrPreview(options?: { maxBytes?: number }): OutputPreview;
};

export type RecoveryReference = AdapterRecoveryReference;

export interface OperationHandle<T> {
  readonly durability: "process";
  readonly reference: RecoveryReference;
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

/** Public sandbox handle. */
export type SandboxHandle = DirectSandboxHandle;

/** Public SDK connection. */
export type SandbarClient = DirectSandbarClient;

export class SandbarError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly effect: SafeError["effect"] = "none",
    readonly outcome?: OperationOutcome,
    readonly reference?: RecoveryReference,
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
  R extends RecoveryReference = RecoveryReference,
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
  R extends RecoveryReference = RecoveryReference,
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

function displayLimit(maxBytes = 16_384): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1_048_576)
    throw new RangeError("maxBytes must be between 0 and 1048576");

  return maxBytes;
}

type OutputOptions = { full: true } | { maxBytes?: number };

function optionObject(value: OutputOptions, key: string): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JavaScript callers can supply malformed options to this public API.
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);

  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((field) => field === key)
  );
}

function decodeOutput(bytes: Uint8Array, options?: number | { full: true }): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve the numeric overload while validating JavaScript option objects.
  if (options === undefined || typeof options === "number") {
    const maxBytes = displayLimit(options);

    return (
      new TextDecoder().decode(bytes.subarray(0, maxBytes)) + (bytes.length > maxBytes ? "…" : "")
    );
  }

  if (!optionObject(options, "full") || !Object.hasOwn(options, "full") || options.full !== true)
    throw new RangeError("Text options must contain only full: true");

  return new TextDecoder().decode(bytes);
}

export function outputText(bytes: Uint8Array, maxBytes?: number): string;
export function outputText(bytes: Uint8Array, options: { full: true }): string;
export function outputText(bytes: Uint8Array, options?: number | { full: true }): string {
  return decodeOutput(bytes, options);
}

function previewOutput(bytes: Uint8Array, options?: { maxBytes?: number }): OutputPreview {
  if (options !== undefined && !optionObject(options, "maxBytes"))
    throw new RangeError("Preview options allow only maxBytes");
  const maxBytes = displayLimit(options?.maxBytes);

  return { text: decodeOutput(bytes, maxBytes), shortened: bytes.length > maxBytes };
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
    stdoutText: (options) => decodeOutput(stdout, options),
    stderrText: (options) => decodeOutput(stderr, options),
    stdoutPreview: (options) => previewOutput(stdout, options),
    stderrPreview: (options) => previewOutput(stderr, options),
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

/** Options for local read-only sandbox observation. */
export type ReadOptions = { signal?: AbortSignal };
