import { z } from "zod";
import { ExecCommand, ExecRequest, Id, InvocationKey, type SafeError } from "@sandbar/contracts";
import {
  NativeRef as NativeRefSchema,
  NativeScope as NativeScopeSchema,
  type NativeRef,
  type NativeScope,
} from "@sandbar/provider-spi";

export type ImageInput = { kind: "prepared"; value: string } | { kind: "oci"; value: string };

export const Image = {
  prepared(value: string): ImageInput {
    return { kind: "prepared", value };
  },
  oci(value: string): ImageInput {
    return { kind: "oci", value };
  },
};

export type CreateInput = {
  environment: ImageInput;
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
  version: 1;
  mode: "direct" | "remote";
  kind: "create" | "exec" | "destroy" | "file_write";
  invocationKey: string;
  submissionId?: string;
  operationId?: string;
  scope?: NativeScope;
  sandbox?: NativeRef;
  resourceId?: string;
  file?: { path: string; bytes: number };
  maxOutputBytes?: number;
  service?: { url: string; projectId: string };
};

export interface OperationHandle<T> {
  readonly durability: "process" | "service";
  readonly reference: RecoveryReference;
  observe(): Promise<T | null>;
  wait(options?: { signal?: AbortSignal; pollMs?: number }): Promise<T>;
}

export interface SandboxHandle {
  readonly id: string;
  inspect(): Promise<{ state: string; observedAt?: string }>;
  exec(input: ExecInput, options?: { signal?: AbortSignal }): Promise<ExecOutput>;
  submitExec(
    input: ExecInput,
    options?: { signal?: AbortSignal },
  ): Promise<OperationHandle<ExecOutput>>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    bytes: Uint8Array,
    options?: { overwrite?: boolean; signal?: AbortSignal },
  ): Promise<void>;
  destroy(options?: { signal?: AbortSignal }): Promise<void>;
}

export interface SandbarClient {
  readonly sandboxes: {
    create(input: CreateInput, options?: { signal?: AbortSignal }): Promise<SandboxHandle>;
    submitCreate(
      input: CreateInput,
      options?: { signal?: AbortSignal },
    ): Promise<OperationHandle<SandboxHandle>>;
  };
  recover(reference: RecoveryReference): Promise<OperationHandle<unknown>>;
  close(): Promise<void>;
}

export class SandbarError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly effect: SafeError["effect"] = "none",
  ) {
    super(message);
    this.name = "SandbarError";
  }
}

export class OutcomeUnknownError extends SandbarError {
  constructor(
    readonly reference: RecoveryReference,
    message = "Outcome unknown; observe this reference without resubmitting",
  ) {
    super("OUTCOME_UNKNOWN", message, "possible");
    this.name = "OutcomeUnknownError";
  }
}

export class WaitAbortedError extends SandbarError {
  readonly cause: unknown;
  constructor(
    readonly reference: RecoveryReference,
    reason: AbortSignal["reason"],
  ) {
    super(
      "WAIT_ABORTED",
      "Waiting stopped after submission; recover with this reference",
      "possible",
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
  if (
    !path ||
    path.length > 4096 ||
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  )
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
        z.strictObject({ kind: z.literal("prepared"), value: z.string().min(1) }),
        z.strictObject({ kind: z.literal("oci"), value: z.string().min(1) }),
      ]),
      networkPolicy: z.string().min(1).max(128).optional(),
      region: z.string().min(1).max(128).optional(),
      labels: z.record(z.string(), z.string()).optional(),
    })
    .safeParse(input);

  if (!parsed.success || !parsed.data.environment.value.trim())
    throw new SandbarError("INVALID_ARGUMENT", "A prepared or OCI image is required");

  return { ...parsed.data, networkPolicy: parsed.data.networkPolicy ?? "blocked" };
}

export function validateExec(
  input: ExecInput,
): Required<Pick<ExecInput, "command" | "deadlineSeconds" | "maxOutputBytes">> & ExecInput {
  const parsed = ExecRequest.parse({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
    deadlineSeconds: input.deadlineSeconds,
    output: { capture: "bounded", maxBytes: input.maxOutputBytes ?? 1_048_576 },
  });

  return {
    ...input,
    command: parsed.command,
    deadlineSeconds: parsed.deadlineSeconds ?? 300,
    maxOutputBytes: parsed.output?.maxBytes ?? 1_048_576,
  };
}

export function validateReference(value: RecoveryReference): RecoveryReference {
  const schema = z.strictObject({
    version: z.literal(1),
    mode: z.enum(["direct", "remote"]),
    kind: z.enum(["create", "exec", "destroy", "file_write"]),
    invocationKey: InvocationKey,
    submissionId: Id.optional(),
    operationId: Id.optional(),
    scope: NativeScopeSchema.optional(),
    sandbox: NativeRefSchema.optional(),
    resourceId: Id.optional(),
    file: z
      .strictObject({
        path: z.string().startsWith("/").max(4096),
        bytes: z.number().int().nonnegative().max(1_048_576),
      })
      .optional(),
    maxOutputBytes: z.number().int().nonnegative().max(1_048_576).optional(),
    service: z.strictObject({ url: z.url(), projectId: Id }).optional(),
  });

  const parsed = schema.safeParse(value);

  if (!parsed.success) throw new SandbarError("INVALID_ARGUMENT", "Invalid recovery reference");
  const ref = parsed.data;

  if (ref.file) validateFilePath(ref.file.path);

  if (
    (ref.kind === "file_write") !== !!ref.file ||
    (ref.kind !== "exec" && ref.maxOutputBytes !== undefined)
  )
    throw new SandbarError("INVALID_ARGUMENT", "Recovery fields do not match operation kind");

  if (ref.mode === "direct") {
    if (!ref.scope || !ref.submissionId || !ref.operationId || ref.service || ref.resourceId)
      throw new SandbarError("INVALID_ARGUMENT", "Incomplete direct recovery reference");

    if (ref.sandbox && (ref.sandbox.kind !== "sandbox" || !sameScope(ref.sandbox.scope, ref.scope)))
      throw new SandbarError("INVALID_ARGUMENT", "Recovery sandbox scope mismatch");

    if (ref.kind === "create" && ref.sandbox)
      throw new SandbarError(
        "INVALID_ARGUMENT",
        "Create recovery reference cannot contain a sandbox",
      );

    if (ref.kind === "file_write" && !ref.sandbox)
      throw new SandbarError("INVALID_ARGUMENT", "Incomplete file recovery reference");

    if ((ref.kind === "exec" || ref.kind === "destroy") && !ref.sandbox)
      throw new SandbarError("INVALID_ARGUMENT", "Recovery sandbox missing");
  } else if (
    !ref.service ||
    ref.scope ||
    ref.sandbox ||
    ref.submissionId ||
    ref.maxOutputBytes ||
    (ref.kind === "create" ? !!ref.resourceId : !ref.resourceId)
  ) {
    throw new SandbarError("INVALID_ARGUMENT", "Incomplete remote recovery reference");
  }

  return structuredClone(ref);
}

export function sealedReference(value: RecoveryReference): RecoveryReference {
  const ref = validateReference(value);

  if (ref.scope) Object.freeze(ref.scope);

  if (ref.sandbox) {
    Object.freeze(ref.sandbox.scope);
    Object.freeze(ref.sandbox);
  }

  if (ref.file) Object.freeze(ref.file);

  if (ref.service) Object.freeze(ref.service);

  return Object.freeze(ref);
}

export function sameScope(a: NativeScope, b: NativeScope): boolean {
  return (
    a.provider === b.provider &&
    a.connectionId === b.connectionId &&
    a.accountId === b.accountId &&
    a.region === b.region
  );
}

export function sameRef(a: NativeRef, b: NativeRef): boolean {
  return a.kind === b.kind && a.nativeId === b.nativeId && sameScope(a.scope, b.scope);
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
