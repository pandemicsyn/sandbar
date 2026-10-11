import { z } from "zod";
import {
  SandbarError,
  raceAbort,
  type CreateInput,
  type SandboxHandle,
  type OperationHandle,
  type RecoveryReference,
} from "./resource";
import type { DestroyValue, SandboxReference, OperationKind } from "sandbar-adapter";
import type { AdapterDirectClient } from "./adapter-direct";

/** Work cancellation does not cancel the separate cleanup budget. */
export interface SandboxScopeOptions {
  signal?: AbortSignal;
  /** Milliseconds to submit and observe destruction. Defaults to 30,000; maximum 300,000. */
  cleanupTimeoutMs?: number;
  /** Overrides the connection's storage cleanup policy; never deletes retained storage. */
  storage?: "require-durable" | "allow-unconfirmed";
}

export type SandboxScopeCallbackOutcome<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: unknown };

/** Destruction failed or was not confirmed; neither work nor cleanup is replayed. */
export class SandboxCleanupError<T = unknown> extends SandbarError {
  readonly sandboxId: string;
  readonly sandboxReference: SandboxReference | null;
  constructor(
    readonly sandbox: SandboxHandle<true>,
    readonly callbackOutcome: SandboxScopeCallbackOutcome<T>,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Cleanup can reject with any JavaScript value; retain it exactly for diagnosis.
    readonly cleanupError: unknown,
    readonly cleanupOperation?: OperationHandle<DestroyValue, OperationKind>,
  ) {
    const failure = cleanupError instanceof SandbarError ? cleanupError : undefined;
    super(
      "SANDBOX_CLEANUP_FAILED",
      "Owned sandbox cleanup was not confirmed; inspect the cleanup error and recovery reference",
      failure?.effect ?? "possible",
      failure?.outcome,
      failure?.reference ?? cleanupOperation?.reference,
    );
    this.name = "SandboxCleanupError";
    this.sandboxId = sandbox.id;
    this.sandboxReference = sandbox.reference;
  }
  get cleanupReference(): RecoveryReference | undefined {
    return this.cleanupOperation?.reference ?? this.reference;
  }
}

export async function withSandbox<T>(
  client: AdapterDirectClient,
  input: CreateInput | undefined,
  callback: (sandbox: SandboxHandle<true>) => T | Promise<T>,
  options: SandboxScopeOptions = {},
): Promise<T> {
  const parsed = z
    .strictObject({
      signal: z.instanceof(AbortSignal).optional(),
      cleanupTimeoutMs: z.number().int().min(1).max(300_000).optional(),
      storage: z.enum(["require-durable", "allow-unconfirmed"]).optional(),
    })
    .safeParse(options);

  if (!parsed.success || !z.function().safeParse(callback).success)
    throw new SandbarError("INVALID_ARGUMENT", "Invalid sandbox scope options or callback");
  const timeout = parsed.data.cleanupTimeoutMs ?? 30_000;
  const { signal, storage } = parsed.data;

  // Until create returns a confirmed handle, ownership is uncertain. Preserve its error unchanged.
  const sandbox = await client.sandboxes.create(input, { signal });
  let callbackOutcome: SandboxScopeCallbackOutcome<T>;

  try {
    const work = Promise.resolve().then(() => {
      signal?.throwIfAborted();

      return callback(sandbox);
    });

    const value = await (signal ? raceAbort(work, signal) : work);
    callbackOutcome = { status: "completed", value };
  } catch (error) {
    callbackOutcome = { status: "failed", error };
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () =>
      controller.abort(new SandbarError("TIMEOUT", "Sandbox cleanup budget exceeded", "possible")),
    timeout,
  );

  let operation: OperationHandle<DestroyValue, OperationKind> | undefined;

  try {
    const cleanup = async () => {
      operation = await sandbox.submitDestroy({ signal: controller.signal, storage });
      await operation.wait({ signal: controller.signal });
    };

    await raceAbort(cleanup(), controller.signal);
  } catch (error) {
    throw new SandboxCleanupError(sandbox, callbackOutcome, error, operation);
  } finally {
    clearTimeout(timer);
  }

  if (callbackOutcome.status === "failed") throw callbackOutcome.error;

  return callbackOutcome.value;
}
