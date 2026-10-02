import { readFileBytes } from "./file-read";
import { freezeReference } from "./freeze-reference";
import { startProcess, type StartProcessInput, type ProcessHandle } from "./processes";
import { certifyRecoveryReference, certifyOperationReference } from "./recovery-diagnostics";
import {
  ReferenceSchema,
  CaptureExpectation,
  type AdapterRecoveryReference,
} from "./adapter-reference";
import {
  Telemetry,
  instrument,
  internalMethod,
  waitFor,
  noteOperation,
  noteRetainedResources,
  activeTraceParent,
  type ObservabilityOptions,
} from "./observability";
import {
  SandboxInfoSchema,
  RenewRequest,
  RenewResult,
  ResolvedRenewInput,
  unknownSandboxFacts,
  validateResourceReference,
  assertSandboxReference,
  type SandboxReference,
  type SandboxInfo,
  stateCapabilities,
  resolveSnapshot,
  checkCreate,
  type Support,
  SnapshotRequest,
  type SnapshotPlan,
  type CreatePlan,
  type DirectCapabilities,
} from "sandbar-adapter";
import { z } from "zod";
import {
  AdapterVolume,
  resourceManagers,
  decodeCapture,
  type SnapshotResult,
  type WaitOptions,
} from "./resources";
import {
  ResourceReference,
  MountSpec as importMountSpec,
  assertResourceScope,
  assertResourceIdentity,
  type ArtifactDeletionResult,
  type DestroyValue,
  type OperationInput,
} from "sandbar-adapter";
import {
  AdapterError,
  AdapterCheckpointError,
  OperationOutcome,
  connectAdapter,
  observeOperation,
  prepareOperation,
  submitOperation,
  continueOperation,
  type AdapterConnection,
  type AdapterDefinition,
  type RuntimeSession,
  type CreateInput as AdapterCreateInput,
  type ImageBuildInput,
  type Json,
  type OperationKind,
  type PreparedOperation,
  type RuntimeResult,
  type Scope,
  type Sandbox,
} from "sandbar-adapter";
import {
  NonzeroExitError,
  NoExitCodeError,
  OutcomeUnknownError,
  WaitAbortedError,
  SandbarError,
  UnsupportedFeatureError,
  checkExec,
  execOutput,
  newInvocationKey,
  raceAbort,
  validateCreate,
  validateExec,
  validateFilePath,
  type ReadOptions,
  validateResourceInput,
  waitDelay,
  type CreateInput,
  type ExecInput,
  type ExecOutput,
  type ImageBuildResult,
} from "./resource";
import type { BoundAdapter } from "./bound";

export { Image, outputText } from "./resource";

export type { AdapterRecoveryReference } from "./adapter-reference";

function canonicalScope(scope: Scope): string {
  return JSON.stringify({
    authority: scope.authority,
    partition: Object.fromEntries(
      Object.entries(scope.partition).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  });
}

function sealedReference(value: AdapterRecoveryReference): AdapterRecoveryReference {
  const parsed = ReferenceSchema.parse(value);

  if (new TextEncoder().encode(JSON.stringify(parsed)).length > 16_384)
    throw new SandbarError("INVALID_ARGUMENT", "Recovery reference exceeds 16384 bytes");
  const copy = structuredClone(parsed);

  freezeReference(copy);

  const createsResource = ["create", "image_build", "volume_create", "snapshot_restore"].includes(
    copy.kind,
  );

  const artifactOperation = ["snapshot_delete", "volume_delete"].includes(copy.kind);

  const boundSandbox =
    (createsResource || artifactOperation ? !copy.sandboxId : !!copy.sandboxId) &&
    (!copy.sandboxReference ||
      (copy.sandboxReference.nativeId === copy.sandboxId &&
        copy.sandboxReference.provider === copy.provider &&
        canonicalScope(copy.sandboxReference.scope) === canonicalScope(copy.scope)));

  const boundResource = ["snapshot_restore", "snapshot_delete"].includes(copy.kind)
    ? copy.resource?.kind === "snapshot"
    : copy.kind === "volume_delete"
      ? copy.resource?.kind === "volume"
      : !copy.resource;

  const boundRenewal =
    (copy.kind === "sandbox_renew") === !!copy.renewal &&
    (copy.kind !== "sandbox_renew" || !!copy.sandboxReference);

  const boundCapture = (copy.kind === "snapshot_capture") === !!copy.capture;

  return boundSandbox &&
    boundResource &&
    boundCapture &&
    boundRenewal &&
    (copy.kind === "file_write") === !!copy.file
    ? certifyRecoveryReference(copy)
    : copy;
}

function assertRecoveryResourceKind(kind: string, resource?: ResourceReference): void {
  const expected = ["snapshot_restore", "snapshot_delete"].includes(kind)
    ? "snapshot"
    : kind === "volume_delete"
      ? "volume"
      : null;

  if (expected && resource?.kind !== expected)
    throw new SandbarError("INVALID_ARGUMENT", "Recovery resource kind differs from operation");
}

function identity() {
  const id = () => `sdk_${crypto.randomUUID().replaceAll("-", "")}`;

  return { operationId: id(), submissionId: id(), invocationKey: newInvocationKey() };
}

function asUnknown(
  ref: AdapterRecoveryReference,
  reason?: string,
  outcome?: import("sandbar-adapter").OperationOutcome,
): OutcomeUnknownError<AdapterRecoveryReference> {
  return new OutcomeUnknownError(ref, reason, outcome);
}

function unsupported(feature: string): never {
  throw new SandbarError("UNSUPPORTED", `${feature} is unsupported`);
}

function fileReadLimit(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new SandbarError("INVALID_ARGUMENT", "Adapter file limit is invalid", "none");

  return Math.min(maxBytes, 1_048_576);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- AbortSignal.reason may be any JavaScript value and is preserved in WaitAbortedError.
function abortWaiting(
  ref: AdapterRecoveryReference,
  reason: AbortSignal["reason"],
  outcome?: import("sandbar-adapter").OperationOutcome,
): never {
  throw new WaitAbortedError(ref, reason, outcome);
}

async function waitForSubmission<T>(
  work: Promise<T>,
  signal: AbortSignal,
  closed: AbortSignal,
  finalizeDeletion: boolean,
): Promise<T> {
  if (!finalizeDeletion) return raceAbort(work, signal);
  const finalization = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abort = () => {
    signal.removeEventListener("abort", abort);

    if (timer !== undefined) return;
    timer = setTimeout(() => finalization.abort(signal.reason), 1000);
  };

  signal.addEventListener("abort", abort, { once: true });

  if (signal.aborted) abort();

  try {
    return await raceAbort(work, AbortSignal.any([closed, finalization.signal]));
  } finally {
    signal.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
}

function assertSignal(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new SandbarError("WAIT_ABORTED", "Waiting stopped before submission", "none");
}

async function readWhileOpen<T>(client: AdapterDirectClient, work: Promise<T>): Promise<T> {
  try {
    const value = await raceAbort(work, client.signal);
    client.ensureOpen();

    return value;
  } catch (error) {
    client.ensureOpen();
    throw error;
  }
}

export type AdapterCapabilities = DirectCapabilities;

export type RecoveredOperation =
  | AdapterOperation<AdapterSandbox, "create" | "snapshot_restore">
  | AdapterOperation<RenewResult, "sandbox_renew">
  | AdapterOperation<SnapshotResult, "snapshot_capture">
  | AdapterOperation<AdapterVolume, "volume_create">
  | AdapterOperation<ArtifactDeletionResult, "snapshot_delete" | "volume_delete">
  | AdapterOperation<ImageBuildResult, "image_build">
  | AdapterOperation<ExecOutput, "exec">
  | AdapterOperation<DestroyValue, "destroy">
  | AdapterOperation<void, "file_write">;

function decodeRenew(result: RuntimeResult, ref: AdapterRecoveryReference): RenewResult {
  if (
    result.kind !== "completed" ||
    !("acknowledged" in result.value) ||
    !ref.sandboxReference ||
    !ref.renewal
  )
    throw asUnknown(ref);
  const value = RenewResult.parse(result.value);
  assertSandboxReference(value.reference, ref.sandboxReference);

  if (value.requested.forSeconds !== ref.renewal.forSeconds)
    throw asUnknown(ref, "Resolved renewal window differs");

  if (value.observation?.reference)
    assertSandboxReference(value.observation.reference, ref.sandboxReference);

  return value;
}

function sandboxInput(id: string, reference?: SandboxReference | null) {
  return reference ? { id, reference } : { id };
}

export class AdapterOperation<T, K extends OperationKind = OperationKind> {
  readonly durability = "process" as const;
  private first: RuntimeResult | undefined;
  #reference: AdapterRecoveryReference;
  get reference(): AdapterRecoveryReference {
    return this.#reference;
  }
  private continuing = false;
  private revision = 0;
  private persistence: Promise<void> = Promise.resolve();
  private persistedReference?: AdapterRecoveryReference;
  private terminal?: { value: T } | { error: Error };
  private pendingAt: number | null = null;
  private nextPollAt = 0;
  constructor(
    private readonly client: AdapterDirectClient,
    reference: AdapterRecoveryReference,
    private readonly decode: (value: RuntimeResult, ref: AdapterRecoveryReference) => T,
    first?: RuntimeResult,
    // SAFETY: default K is OperationKind; internal narrowed constructors pass a validated kind.
    readonly kind: K = reference.kind as K,
  ) {
    this.#reference = reference;
    certifyOperationReference(this, () => this.#reference);
    this.first = first;

    if (first?.kind === "pending")
      this.#reference = sealedReference({
        ...reference,
        token: first.token,
        tokenVersion: first.version,
      });

    // Submitted pending references were saved before constructing the handle; recovered
    // references are the caller's saved input. Later local revisions must be saved here.
    this.persistedReference = this.reference;

    if (first)
      noteOperation(
        this,
        first.kind,
        first.kind === "completed" ? "applied" : first.kind === "rejected" ? "none" : "possible",
      );
    instrument(this, "observe", client.telemetry, "sandbar.operation.observe", {
      identity: this,
      origin: first ? activeTraceParent() : undefined,
    });
    instrument(this, "wait", client.telemetry, "sandbar.operation.wait", {
      identity: this,
      effect: "applied",
      origin: first ? activeTraceParent() : undefined,
    });
  }
  /** Advance proven unsubmitted stages. Applications serialize continuation across processes. */
  async continue(options: { signal?: AbortSignal } = {}): Promise<this> {
    this.client.ensureOpen();

    if (this.continuing)
      throw new SandbarError("CONFLICT", "Operation continuation is already active");
    assertSignal(options.signal);

    const signal = options.signal
      ? AbortSignal.any([this.client.signal, options.signal])
      : this.client.signal;

    this.continuing = true;
    this.revision++;
    this.first = undefined;
    this.terminal = undefined;
    this.pendingAt = null;
    this.nextPollAt = 0;

    try {
      await this.persistence;

      if (this.persistedReference !== this.reference) await this.persistReference();
      this.#reference = (await this.client.recover(this.reference)).reference;
      this.first = await continueOperation(
        this.client.session,
        this.reference.kind,
        {
          operationId: this.reference.operationId,
          submissionId: this.reference.submissionId,
          sandbox: this.reference.sandboxId
            ? sandboxInput(this.reference.sandboxId, this.reference.sandboxReference)
            : undefined,
          resource: this.reference.resource,
          mounts: this.reference.mounts,
          capture: this.reference.capture,
          token: this.reference.token,
          version: this.reference.tokenVersion,
        },
        this.reference,
        signal,
        async (token, tokenVersion) => {
          this.#reference = sealedReference({ ...this.reference, token, tokenVersion });
          await this.persistReference();
        },
      );

      if (this.first.kind === "pending") {
        this.#reference = sealedReference({
          ...this.reference,
          token: this.first.token,
          tokenVersion: this.first.version,
        });
        await this.persistReference();
      }

      return this;
    } catch (error) {
      if (error instanceof AdapterCheckpointError && error.outcome)
        throw new SandbarError(
          "REFERENCE_SAVE_FAILED",
          error.message,
          "possible",
          this.client.checkedOutcome(this.reference, error.outcome),
          this.reference,
        );

      if (error instanceof AdapterError && error.code === "UNSUPPORTED")
        throw new UnsupportedFeatureError("operation continuation", [error.message]);
      throw asUnknown(
        this.reference,
        "Continuation could not finish; persist the latest operation reference",
      );
    } finally {
      this.continuing = false;
    }
  }

  private persistReference(): Promise<void> {
    const reference = this.reference;
    const saved = this.persistence.then(() => this.client.persistReference(reference));
    this.persistence = saved.then(
      () => {
        this.persistedReference = reference;
      },
      () => undefined,
    );

    return saved;
  }
  async observe(): Promise<T | null> {
    return this.observeWithSignal(this.client.signal);
  }
  private async observeWithSignal(signal: AbortSignal): Promise<T | null> {
    if (this.continuing)
      throw new SandbarError("CONFLICT", "Operation continuation is already active");

    if (signal.aborted)
      abortWaiting(
        this.reference,
        signal.reason,
        this.first?.kind === "unknown"
          ? this.client.checkedOutcome(this.reference, this.first.outcome)
          : undefined,
      );
    const revision = this.revision;

    if (this.terminal) {
      if ("error" in this.terminal) throw this.terminal.error;

      return this.terminal.value;
    }

    let result = this.first;
    const wasFirst = result !== undefined;
    this.first = undefined;

    if (result?.kind === "pending") {
      if (revision !== this.revision) return null;
      this.pendingAt = Date.now();
      this.nextPollAt = this.pendingAt + result.pollAfterMs;
      this.revision++;
      this.#reference = sealedReference({
        ...this.reference,
        token: result.token,
        tokenVersion: result.version,
      });
      await this.persistReference();

      return null;
    }

    if (!result) {
      let locallyValidated = false;

      const observed = await raceAbort(
        observeOperation(
          this.client.session,
          this.reference.kind,
          {
            operationId: this.reference.operationId,
            submissionId: this.reference.submissionId,
            sandbox: this.reference.sandboxId
              ? sandboxInput(this.reference.sandboxId, this.reference.sandboxReference)
              : undefined,
            resource: this.reference.resource,
            mounts: this.reference.mounts,
            renewal: this.reference.renewal,
            capture: this.reference.capture,
            token: this.reference.token,
            version: this.reference.tokenVersion,
          },
          signal,
          this.reference.maxOutputBytes,
          () => {
            locallyValidated = true;
          },
        ),
        signal,
      ).catch((error) => {
        if (signal.aborted) abortWaiting(this.reference, signal.reason);

        if (
          !locallyValidated &&
          error instanceof AdapterError &&
          (error.code === "CONFLICT" || error.code === "INVALID_ARGUMENT")
        )
          throw new SandbarError(error.code, error.message);

        return null;
      });

      if (revision !== this.revision) return null;

      if (!observed)
        throw asUnknown(this.reference, "No correlated provider observation is available");
      result = observed;
    }

    if (signal.aborted)
      abortWaiting(
        this.reference,
        signal.reason,
        result.kind === "unknown"
          ? this.client.checkedOutcome(this.reference, result.outcome)
          : undefined,
      );

    if (revision !== this.revision) return null;

    if (result.kind === "pending") {
      this.pendingAt = Date.now();
      this.nextPollAt = this.pendingAt + result.pollAfterMs;
      this.revision++;
      this.#reference = sealedReference({
        ...this.reference,
        token: result.token,
        tokenVersion: result.version,
      });
      await this.persistReference();

      return null;
    }

    if (result.kind === "unknown") {
      const outcome = this.client.checkedOutcome(this.reference, result.outcome);

      if (outcome?.kind === "snapshot_capture" && outcome.restart?.status === "failed")
        throw new SandbarError("SOURCE_RESTART_FAILED", result.reason, "partial", outcome);
      throw asUnknown(this.reference, result.reason, outcome);
    }

    this.pendingAt = null;
    this.nextPollAt = 0;

    if (result.kind === "rejected") {
      // Only a submission response may certify no effect.
      if (!wasFirst) throw asUnknown(this.reference, "Observation cannot certify rejection");

      const error =
        result.code === "UNSUPPORTED"
          ? new UnsupportedFeatureError(this.reference.kind, [result.message])
          : new SandbarError(result.code, result.message, "none");

      this.terminal = { error };
      throw error;
    }

    if ("retainedResources" in result.value) {
      noteRetainedResources(this, result.value.retainedResources.length);
      this.client.telemetry.correlate(this);
    }

    try {
      const value = this.decode(result, this.reference);
      this.terminal = { value };

      return value;
    } catch (error) {
      if (error instanceof OutcomeUnknownError) throw error;

      if (error instanceof NonzeroExitError || error instanceof NoExitCodeError) {
        this.terminal = { error };
        throw error;
      }

      throw asUnknown(this.reference, "Provider completion failed validation");
    }
  }
  async wait(options: { signal?: AbortSignal; pollMs?: number } = {}): Promise<T> {
    const pollMs = options.pollMs ?? 500;

    const signal = options.signal
      ? AbortSignal.any([this.client.signal, options.signal])
      : this.client.signal;

    if (!Number.isSafeInteger(pollMs) || pollMs < 50 || pollMs > 60_000)
      throw new SandbarError("INVALID_ARGUMENT", "Invalid polling interval");

    while (true) {
      if (this.client.isClosed())
        abortWaiting(
          this.reference,
          this.client.signal.reason,
          this.first?.kind === "unknown"
            ? this.client.checkedOutcome(this.reference, this.first.outcome)
            : undefined,
        );

      const confirmedRejection =
        this.first?.kind === "rejected" ||
        (this.terminal &&
          "error" in this.terminal &&
          this.terminal.error instanceof SandbarError &&
          this.terminal.error.effect === "none");

      if (options.signal?.aborted && !confirmedRejection)
        abortWaiting(
          this.reference,
          options.signal.reason,
          this.first?.kind === "unknown"
            ? this.client.checkedOutcome(this.reference, this.first.outcome)
            : undefined,
        );

      if (this.pendingAt !== null) {
        const eligibleAt = Math.max(this.nextPollAt, this.pendingAt + pollMs);
        const delay = Math.max(0, eligibleAt - Date.now());

        if (delay > 0)
          await waitDelay(delay, signal).catch((error) => abortWaiting(this.reference, error));
      }

      const value = await this.observeWithSignal(
        confirmedRejection ? this.client.signal : signal,
      ).catch((error) => {
        this.client.telemetry.poll(
          error instanceof SandbarError && error.effect === "applied"
            ? "completed"
            : this.terminal &&
                "error" in this.terminal &&
                error instanceof SandbarError &&
                error.effect === "none"
              ? "rejected"
              : "unknown",
        );

        throw error;
      });

      this.client.telemetry.poll(value === null ? "pending" : "completed");

      if (value !== null) return value;
    }
  }
}

export class AdapterSandbox {
  #reference: SandboxReference | null;
  get reference(): SandboxReference | null {
    return this.#reference;
  }
  constructor(
    private readonly client: AdapterDirectClient,
    readonly id: string,
    reference: SandboxReference | null = null,
  ) {
    if (reference) {
      reference = validateResourceReference(reference);
      assertResourceScope(reference, { provider: client.provider, scope: client.scope });

      if (reference.kind !== "sandbox" || reference.nativeId !== id)
        throw new SandbarError("INVALID_RESPONSE", "Sandbox identity differs");
    }

    this.#reference = reference ? freezeReference(reference) : null;
    instrument(this, "capabilities", client.telemetry, "sandbar.capabilities");
    instrument(this, "checkSnapshot", client.telemetry, "sandbar.snapshot.check");
    instrument(this, "inspect", client.telemetry, "sandbar.sandbox.inspect");
    instrument(this, "submitExec", client.telemetry, "sandbar.exec.submit", { effect: "possible" });
    instrument(this, "exec", client.telemetry, "sandbar.exec", { effect: "applied" });
    instrument(this, "readFile", client.telemetry, "sandbar.file.read");
    instrument(this, "writeFile", client.telemetry, "sandbar.file.write", { effect: "applied" });
    instrument(this, "destroy", client.telemetry, "sandbar.sandbox.destroy", { effect: "applied" });
    instrument(this.processes, "start", client.telemetry, "sandbar.process.start", {
      effect: "possible",
    });
  }
  readonly processes = {
    start: (input: StartProcessInput, options: WaitOptions = {}): Promise<ProcessHandle> => {
      this.client.ensureOpen();

      return startProcess(this.client, sandboxInput(this.id, this.reference), input, options);
    },
  };
  async submitRenew(
    input?: RenewRequest,
    options: WaitOptions = {},
  ): Promise<AdapterOperation<RenewResult, "sandbox_renew">> {
    this.client.ensureOpen();
    assertSignal(options.signal);

    const request =
      input === undefined
        ? undefined
        : validateResourceInput(RenewRequest, input, "Invalid renewal window");

    if (!this.reference) unsupported("Lifetime renewal without a verified sandbox reference");

    return this.client.submit(
      "sandbox_renew",
      { sandbox: { id: this.id, reference: this.reference }, ...request },
      decodeRenew,
      { ...options, sandboxId: this.id, sandboxReference: this.reference },
    );
  }
  async renew(input?: RenewRequest, options: WaitOptions = {}): Promise<RenewResult> {
    return (await this.submitRenew(input, options)).wait(options);
  }
  async submitSnapshot(
    request: SnapshotRequest = {},
    options: WaitOptions = {},
  ): Promise<AdapterOperation<SnapshotResult>> {
    this.client.ensureOpen();
    assertSignal(options.signal);
    request = validateResourceInput(SnapshotRequest, request, "Invalid snapshot request");

    const signal = AbortSignal.any([
      this.client.signal,
      ...(options.signal ? [options.signal] : []),
    ]);

    const plan = await this.checkSnapshotWithSignal(request, signal);

    if (plan.status === "unsupported") throw new UnsupportedFeatureError("snapshot", [plan.reason]);

    if (plan.status !== "supported") throw new SandbarError("UNAVAILABLE", plan.reason, "none");

    return this.client.submit(
      "snapshot_capture",
      {
        sandbox: sandboxInput(this.id, this.reference),
        request,
        expectation: { profile: plan.value.profile, sourceState: plan.value.sourceState },
      },
      (result, ref) => {
        if (result.kind !== "completed" || !("snapshot" in result.value)) throw asUnknown(ref);

        return decodeCapture(this.client, result.value, ref);
      },
      {
        ...options,
        sandboxId: this.id,
        sandboxReference: this.reference ?? undefined,
        capture: { profile: plan.value.profile, sourceState: plan.value.sourceState },
      },
    );
  }
  async snapshot(
    request: SnapshotRequest = {},
    options: WaitOptions = {},
  ): Promise<SnapshotResult> {
    return (await this.submitSnapshot(request, options)).wait(options);
  }
  capabilities(): Promise<AdapterCapabilities> {
    return internalMethod(this.client.capabilities)({
      sandbox: sandboxInput(this.id, this.reference),
    });
  }
  async checkSnapshot(request: SnapshotRequest = {}): Promise<Support<SnapshotPlan>> {
    return this.checkSnapshotWithSignal(request, this.client.signal);
  }
  private async checkSnapshotWithSignal(
    request: SnapshotRequest,
    signal: AbortSignal,
  ): Promise<Support<SnapshotPlan>> {
    assertSignal(signal);
    request = validateResourceInput(SnapshotRequest, request, "Invalid snapshot request");

    const caps = await internalMethod(this.client.capabilities)(
      { sandbox: sandboxInput(this.id, this.reference) },
      { signal },
    );

    if (caps.snapshots.capture.status !== "supported")
      return resolveSnapshot(caps.snapshots.capture, request, "unknown");

    const state = this.client.session.inspect
      ? (await internalMethod(this.inspect)({ signal })).state
      : "unknown";

    return resolveSnapshot(caps.snapshots.capture, request, state);
  }
  supports(feature: "inspect" | "exec" | "readFile" | "writeFile" | "destroy"): boolean {
    if (feature === "inspect") return !!this.client.session.inspect;

    if (feature === "exec")
      return !!this.client.session.exec && !!this.client.session.supports.exec;

    if (feature === "readFile") return !!this.client.session.files?.read;

    if (feature === "writeFile") return !!this.client.session.files?.write;

    return true;
  }
  async inspect(options: WaitOptions = {}): Promise<SandboxInfo> {
    this.client.ensureOpen();

    if (!this.client.session.inspect) unsupported("inspect");

    assertSignal(options.signal);

    const timeout = AbortSignal.timeout(30000);

    const signal = AbortSignal.any([
      this.client.signal,
      ...(options.signal ? [options.signal] : []),
      timeout,
    ]);

    try {
      const result = await readWhileOpen(
        this.client,
        raceAbort(
          this.client.session.inspect(sandboxInput(this.id, this.reference), {
            signal,
            deadline: Date.now() + 30000,
          }),
          signal,
        ),
      );

      if (!result) throw new SandbarError("NOT_FOUND", "Sandbox is missing, expired, or deleted");

      if (result.id !== this.id)
        throw new SandbarError("INVALID_RESPONSE", "Provider returned another sandbox", "unknown");

      const { id: _id, ...facts } = result;

      const parsed = SandboxInfoSchema.safeParse({
        ...unknownSandboxFacts(),
        reference: this.reference,
        nativeState: null,
        ...facts,
        observedAt: new Date().toISOString(),
      });

      if (!parsed.success) throw new SandbarError("INVALID_RESPONSE", "Invalid sandbox inspection");
      const info = parsed.data;

      if (info.reference) {
        if (info.reference.nativeId !== this.id)
          throw new SandbarError("INVALID_RESPONSE", "Provider sandbox identity differs");
        assertResourceScope(info.reference, {
          provider: this.client.provider,
          scope: this.client.scope,
        });

        if (this.reference) assertSandboxReference(info.reference, this.reference);
      }

      return info;
    } catch (error) {
      assertSignal(options.signal);

      if (timeout.aborted) throw new SandbarError("TIMEOUT", "Sandbox inspection timed out");

      if (error instanceof AdapterError) throw new SandbarError(error.code, error.message);
      throw error;
    }
  }
  async submitExec(
    input: ExecInput | readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<AdapterOperation<ExecOutput>> {
    if (!this.supports("exec")) unsupported("exec");
    const request = validateExec(input);
    const max = this.client.session.supports.exec!.maxOutputBytes;

    if (request.maxOutputBytes > max) unsupported("requested output limit");

    return this.client.submit(
      "exec",
      {
        sandbox: sandboxInput(this.id, this.reference),
        command: request.command,
        cwd: request.cwd,
        env: request.env,
        deadlineSeconds: request.deadlineSeconds,
        maxOutputBytes: request.maxOutputBytes,
      },
      (result, ref) => {
        if (result.kind !== "completed" || !("stdout" in result.value)) throw asUnknown(ref);
        const output = result.value;

        if (!(output.stdout instanceof Uint8Array) || !(output.stderr instanceof Uint8Array))
          throw asUnknown(ref);

        return checkExec(
          execOutput(output.exitCode, output.stdout, output.stderr, output.truncated),
        );
      },
      {
        ...options,
        sandboxId: this.id,
        sandboxReference: this.reference ?? undefined,
        maxOutputBytes: request.maxOutputBytes,
      },
    );
  }
  async exec(
    input: ExecInput | readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<ExecOutput> {
    return waitFor(
      this.client.telemetry,
      await internalMethod(this.submitExec)(input, options),
      options,
    );
  }
  async readFile(path: string, options: ReadOptions = {}): Promise<Uint8Array> {
    this.client.ensureOpen();

    if (!this.client.session.files?.read) unsupported("readFile");
    validateFilePath(path);
    const maxBytes = fileReadLimit(this.client.session.files.maxBytes);

    const read = this.client.session.files.read.bind(this.client.session.files);

    return readFileBytes(
      (context) => read({ sandbox: sandboxInput(this.id, this.reference), path }, context),
      maxBytes,
      this.client.signal,
      options,
    );
  }
  async writeFile(
    path: string,
    bytes: Uint8Array,
    options: { overwrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!this.supports("writeFile")) unsupported("writeFile");
    validateFilePath(path);

    if (!(bytes instanceof Uint8Array))
      throw new SandbarError("INVALID_ARGUMENT", "Expected byte buffer");
    const payload = Uint8Array.from(bytes);

    const op = await this.client.submit(
      "file_write",
      {
        sandbox: sandboxInput(this.id, this.reference),
        path,
        bytes: payload,
        overwrite: options.overwrite ?? false,
      },
      (result, ref) => {
        if (
          result.kind !== "completed" ||
          !("bytesWritten" in result.value) ||
          result.value.bytesWritten !== payload.length
        )
          throw asUnknown(ref);
      },
      {
        ...options,
        sandboxId: this.id,
        sandboxReference: this.reference ?? undefined,
        file: { path, bytes: payload.length },
      },
    );

    await waitFor(this.client.telemetry, op, options);
  }
  async submitDestroy(
    options: { signal?: AbortSignal; storage?: "require-durable" | "allow-unconfirmed" } = {},
  ): Promise<AdapterOperation<import("sandbar-adapter").DestroyValue>> {
    const op = await this.client.submit<import("sandbar-adapter").DestroyValue>(
      "destroy",
      {
        ...sandboxInput(this.id, this.reference),
        storage: options.storage === undefined ? this.client.cleanupStorage : options.storage,
      },
      (result, ref) => {
        if (
          result.kind !== "completed" ||
          !("computeStopped" in result.value) ||
          !result.value.computeStopped
        )
          throw asUnknown(ref, "Compute termination was not confirmed");

        return result.value;
      },
      { ...options, sandboxId: this.id, sandboxReference: this.reference ?? undefined },
    );

    return op;
  }
  async destroy(
    options: { signal?: AbortSignal; storage?: "require-durable" | "allow-unconfirmed" } = {},
  ): Promise<import("sandbar-adapter").DestroyValue> {
    return waitFor(this.client.telemetry, await this.submitDestroy(options), options);
  }
}

/** Optional lifecycle API for applications with their own durable operation ledger. */
export const ADAPTER_CONTRACT_VERSION = 1 as const;

export type AdvancedOperationResult = RuntimeResult;

export type AdvancedOperationKind = OperationKind;

export type AdvancedIdentity = { operationId: string; submissionId: string; invocationKey: string };

export type AdvancedObservation = {
  renewal?: RenewRequest;
  capture?: AdapterRecoveryReference["capture"];
  scope: Scope;
  kind: OperationKind;
  operationId: string;
  submissionId: string;
  sandboxId?: string;
  sandboxReference?: SandboxReference;
  resource?: ResourceReference;
  mounts?: import("sandbar-adapter").MountSpec[];
  token?: Json;
  tokenVersion?: number;
};

const AdvancedIdentitySchema = z.strictObject({
  operationId: z.string().min(1).max(128),
  submissionId: z.string().min(1).max(128),
  invocationKey: z.string().min(1).max(128),
});

class BeforeSubmitError extends Error {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The reference callback may reject with any JavaScript value; preserve its cause.
  constructor(readonly original: unknown) {
    super("Submission barrier failed");
  }
}

const preparedRenewals = new WeakMap<PreparedAdapterAttempt, RenewRequest>();

const dispatchedRenewals = new WeakSet<PreparedAdapterAttempt>();

export class PreparedAdapterAttempt {
  private used = false;
  constructor(
    private readonly client: AdapterDirectClient,
    private readonly prepared: PreparedOperation,
    private readonly kind: OperationKind,
    private readonly maxOutputBytes?: number,
  ) {
    if (kind === "sandbox_renew")
      preparedRenewals.set(this, {
        forSeconds: ResolvedRenewInput.parse(prepared.input).forSeconds,
      });
  }
  /** Resolved renewal intent to persist in beforeSubmit and supply to operations.observe. */
  get renewal(): Readonly<RenewRequest> | undefined {
    const renewal = preparedRenewals.get(this);

    return renewal ? { ...renewal } : undefined;
  }
  /** The callback must durably record the submission marker; false cancels dispatch. */
  async submit(
    identity: AdvancedIdentity,
    options: {
      beforeSubmit: () => Promise<boolean>;
      signal?: AbortSignal;
      onCheckpoint?: (token: Json, version: number) => Promise<void>;
    },
  ): Promise<AdvancedOperationResult | null> {
    if (this.used) throw new SandbarError("CONFLICT", "Prepared attempt was already used");
    this.used = true;
    this.client.ensureOpen();
    assertSignal(options.signal);
    const checked = AdvancedIdentitySchema.parse(identity);

    const signal = options.signal
      ? AbortSignal.any([this.client.signal, options.signal])
      : this.client.signal;

    let permitted: boolean;

    if (this.prepared.revalidate) {
      let rejected: RuntimeResult | null;

      try {
        rejected = await raceAbort(this.prepared.revalidate(signal), signal);
      } catch (error) {
        this.client.ensureOpen();
        assertSignal(options.signal);

        if (error instanceof AdapterError && error.code === "TIMEOUT")
          throw new SandbarError(error.code, error.message);
        throw error;
      }

      if (rejected) return rejected;
    }

    try {
      permitted = await raceAbort(options.beforeSubmit(), signal);
    } catch (error) {
      this.client.ensureOpen();
      assertSignal(options.signal);
      throw new BeforeSubmitError(error);
    }

    this.client.ensureOpen();
    assertSignal(options.signal);

    if (!permitted) return null;

    if (this.kind === "sandbox_renew") dispatchedRenewals.add(this);
    this.client.telemetry.submitted();

    const submissionWaitSignal =
      this.kind === "snapshot_capture"
        ? AbortSignal.any([this.client.signal, AbortSignal.timeout(85000)])
        : signal;

    try {
      return await waitForSubmission(
        // Requirements were checked before the durable marker; no read hook may run after it.
        this.client.telemetry.run(
          "sandbar.submit",
          () =>
            waitForSubmission(
              submitOperation(
                { ...this.prepared, revalidate: undefined },
                checked,
                signal,
                this.kind === "exec" ? this.maxOutputBytes : undefined,
                async (token, version) => {
                  if (!options.onCheckpoint)
                    throw new SandbarError(
                      "INVALID_ARGUMENT",
                      "Checkpointing submissions require onCheckpoint persistence",
                    );

                  await options.onCheckpoint(token, version);
                },
              ),
              submissionWaitSignal,
              this.client.signal,
              this.kind === "snapshot_delete" || this.kind === "volume_delete",
            ),
          {
            phase: true,
            operationType: this.kind,
            effect: "possible",
            identity: { reference: { mode: "direct", ...checked } },
            signal,
          },
        ),
        submissionWaitSignal,
        this.client.signal,
        this.kind === "snapshot_delete" || this.kind === "volume_delete",
      );
    } catch (error) {
      if (error instanceof AdapterCheckpointError && error.outcome) throw error;

      if (signal.aborted)
        return {
          kind: "unknown",
          reason: "Provider submission outcome is unknown after cancellation",
        };

      return {
        kind: "unknown",
        reason: "Provider submission outcome is unknown after failure",
      };
    }
  }
}

export class AdapterDirectClient {
  private closed = false;
  private closePromise?: Promise<void>;
  readonly telemetry: Telemetry;
  readonly session: RuntimeSession;
  readonly scope: Scope;
  readonly operations: {
    inventory: (input: { cursor?: string; limit: number }) => Promise<{
      items: { id: string; state: "running" | "destroyed" | "unknown" }[];
      nextCursor?: string;
    }>;
    prepare: (
      kind: OperationKind,
      input: OperationInput,
      options?: { signal?: AbortSignal; maxOutputBytes?: number },
    ) => Promise<PreparedAdapterAttempt>;
    observe: (
      input: AdvancedObservation,
      options?: { signal?: AbortSignal },
    ) => Promise<AdvancedOperationResult | null>;
  };
  readonly signal: AbortSignal;
  readonly sandboxes: {
    get: (reference: SandboxReference, options?: WaitOptions) => Promise<AdapterSandbox>;
    checkCreate: (input?: CreateInput) => Promise<Support<CreatePlan>>;
    create: (input?: CreateInput, options?: { signal?: AbortSignal }) => Promise<AdapterSandbox>;
    submitCreate: (
      input?: CreateInput,
      options?: { signal?: AbortSignal },
    ) => Promise<AdapterOperation<AdapterSandbox>>;
  };
  readonly snapshots: ReturnType<typeof resourceManagers>["snapshots"];
  readonly volumes: ReturnType<typeof resourceManagers>["volumes"];
  readonly images: {
    build: (
      input: ImageBuildInput,
      options?: { signal?: AbortSignal },
    ) => Promise<ImageBuildResult>;
    submitBuild: (
      input: ImageBuildInput,
      options?: { signal?: AbortSignal },
    ) => Promise<AdapterOperation<ImageBuildResult>>;
  };
  constructor(
    readonly provider: string,
    private readonly connection: AdapterConnection<RuntimeSession>,
    private readonly onReference?: (reference: AdapterRecoveryReference) => void | Promise<void>,
    observability: ObservabilityOptions = {},
    readonly cleanupStorage: "require-durable" | "allow-unconfirmed" = "require-durable",
  ) {
    this.telemetry = new Telemetry(observability, "direct", provider);
    const managers = resourceManagers(this);
    this.snapshots = managers.snapshots;
    this.volumes = managers.volumes;
    this.session = connection.session;
    this.scope = connection.scope;
    this.signal = connection.signal;
    this.operations = {
      inventory: async (input) => {
        this.ensureOpen();

        if (!this.session.inventory) unsupported("inventory");

        const checked = z
          .strictObject({
            cursor: z.string().max(4096).optional(),
            limit: z.number().int().min(1).max(100),
          })
          .parse(input);

        const result = await readWhileOpen(
          this,
          this.session.inventory(checked, {
            signal: this.signal,
            deadline: Date.now() + 30_000,
          }),
        );

        return z
          .strictObject({
            items: z
              .array(
                z.strictObject({
                  id: z.string().min(1).max(512),
                  state: z.enum(["running", "destroyed", "unknown"]),
                }),
              )
              .max(100),
            nextCursor: z.string().max(4096).optional(),
          })
          .parse(result);
      },
      prepare: async (kind, input, options = {}) => {
        this.ensureOpen();
        assertSignal(options.signal);

        const signal = options.signal
          ? AbortSignal.any([this.signal, options.signal])
          : this.signal;

        if (kind === "sandbox_renew") {
          const parsed = ResolvedRenewInput.partial({ forSeconds: true }).safeParse(input);

          if (!parsed.success)
            throw new SandbarError("INVALID_ARGUMENT", "Invalid renewal request");
          const renewal = parsed.data;
          assertResourceScope(renewal.sandbox.reference, {
            provider: this.provider,
            scope: this.scope,
          });
        }

        if ("snapshot" in input)
          assertResourceScope(ResourceReference.parse(input.snapshot), {
            provider: this.provider,
            scope: this.scope,
          });

        if ("kind" in input && ["snapshot", "volume"].includes(input.kind))
          assertResourceScope(ResourceReference.parse(input), {
            provider: this.provider,
            scope: this.scope,
          });

        if ("mounts" in input)
          for (const mount of input.mounts ?? [])
            assertResourceScope(mount.volume, { provider: this.provider, scope: this.scope });
        let prepared: PreparedOperation;

        try {
          prepared = await raceAbort(prepareOperation(this.session, kind, input, signal), signal);
        } catch (error) {
          this.ensureOpen();
          assertSignal(options.signal);

          if (error instanceof AdapterError && error.code === "UNSUPPORTED")
            throw new UnsupportedFeatureError(kind, [error.message]);

          if (error instanceof AdapterError) throw new SandbarError(error.code, error.message);
          throw error;
        }

        this.ensureOpen();
        assertSignal(options.signal);

        return new PreparedAdapterAttempt(this, prepared, kind, options.maxOutputBytes);
      },
      observe: async (input, options = {}) => {
        this.ensureOpen();
        assertSignal(options.signal);

        const signal = options.signal
          ? AbortSignal.any([this.signal, options.signal])
          : this.signal;

        const checked = z
          .strictObject({
            scope: ReferenceSchema.shape.scope,
            kind: z.enum([
              "create",
              "destroy",
              "exec",
              "file_write",
              "image_build",
              "sandbox_renew",
              "snapshot_capture",
              "snapshot_restore",
              "snapshot_delete",
              "volume_create",
              "volume_delete",
            ]),
            operationId: z.string().min(1).max(128),
            submissionId: z.string().min(1).max(128),
            sandboxId: z.string().min(1).max(512).optional(),
            sandboxReference: ReferenceSchema.shape.sandboxReference,
            resource: ResourceReference.optional(),
            renewal: ReferenceSchema.shape.renewal,
            capture: CaptureExpectation.optional(),
            mounts: z.array(importMountSpec).max(32).optional(),
            token: z.json().optional(),
            tokenVersion: z.number().int().positive().optional(),
          })
          .parse(input);

        if (canonicalScope(checked.scope) !== canonicalScope(this.scope))
          throw new SandbarError(
            "FORBIDDEN",
            "Observation scope differs from the verified connection",
          );

        if (checked.kind === "sandbox_renew" && (!checked.renewal || !checked.sandboxReference))
          throw new SandbarError(
            "INVALID_ARGUMENT",
            "Renewal observation requires saved intent and identity",
          );
        this.assertRecoverySandbox(checked);
        assertRecoveryResourceKind(checked.kind, checked.resource);

        if (checked.resource)
          assertResourceScope(checked.resource, { provider: this.provider, scope: this.scope });

        for (const mount of checked.mounts ?? [])
          assertResourceScope(mount.volume, { provider: this.provider, scope: this.scope });

        if (
          ([
            "create",
            "image_build",
            "volume_create",
            "snapshot_restore",
            "snapshot_delete",
            "volume_delete",
          ].includes(checked.kind) &&
            checked.sandboxId) ||
          (["destroy", "exec", "file_write", "snapshot_capture", "sandbox_renew"].includes(
            checked.kind,
          ) &&
            !checked.sandboxId) ||
          (["snapshot_restore", "snapshot_delete", "volume_delete"].includes(checked.kind) &&
            !checked.resource)
        )
          throw new SandbarError("INVALID_ARGUMENT", "Observation sandbox binding is invalid");

        if (checked.kind === "snapshot_capture" && !checked.capture)
          throw new SandbarError(
            "INVALID_ARGUMENT",
            "Capture observation requires saved expectations",
          );

        let locallyValidated = false;

        try {
          return await raceAbort(
            observeOperation(
              this.session,
              checked.kind,
              {
                operationId: checked.operationId,
                submissionId: checked.submissionId,
                sandbox: checked.sandboxId
                  ? sandboxInput(checked.sandboxId, checked.sandboxReference)
                  : undefined,
                resource: checked.resource,
                renewal: checked.renewal,
                capture: checked.capture,
                mounts: checked.mounts,
                token: checked.token,
                version: checked.tokenVersion,
              },
              signal,
              undefined,
              () => {
                locallyValidated = true;
              },
            ),
            signal,
          );
        } catch (error) {
          if (signal.aborted)
            return {
              kind: "unknown",
              reason: "Provider observation outcome is unknown after cancellation",
            };

          if (locallyValidated)
            return {
              kind: "unknown",
              reason: "Provider observation failed; submission outcome remains unknown",
            };
          throw error;
        }
      },
    };
    this.sandboxes = {
      get: (reference, options = {}) => this.reopenSandbox(reference, options),
      checkCreate: (input) => this.checkCreate(input),
      create: async (input, options = {}) =>
        waitFor(this.telemetry, await internalMethod(this.submitCreate)(input, options), options),
      submitCreate: (input, options = {}) => this.submitCreate(input, options),
    };
    this.images = {
      build: async (input, options = {}) =>
        waitFor(this.telemetry, await internalMethod(this.submitBuild)(input, options), options),
      submitBuild: (input, options = {}) => this.submitBuild(input, options),
    };
    instrument(this, "capabilities", this.telemetry, "sandbar.capabilities");
    instrument(this, "checkCreate", this.telemetry, "sandbar.sandbox.check_create");
    instrument(this, "submitCreate", this.telemetry, "sandbar.sandbox.submit_create", {
      effect: "possible",
    });
    instrument(this, "submitBuild", this.telemetry, "sandbar.image.submit_build", {
      effect: "possible",
    });
    instrument(this, "recover", this.telemetry, "sandbar.operation.recover", {
      effect: "possible",
    });
    instrument(this, "close", this.telemetry, "sandbar.close");
    instrument(this.sandboxes, "create", this.telemetry, "sandbar.sandbox.create", {
      effect: "applied",
    });
    instrument(this.images, "build", this.telemetry, "sandbar.image.build", { effect: "applied" });
    instrument(this.operations, "inventory", this.telemetry, "sandbar.sandbox.inventory");
    instrument(this.operations, "prepare", this.telemetry, "sandbar.prepare", { phase: true });
    instrument(this.operations, "observe", this.telemetry, "sandbar.observe", { phase: true });
  }
  isClosed() {
    return this.closed || this.signal.aborted;
  }
  ensureOpen() {
    if (this.isClosed()) throw new SandbarError("CLIENT_CLOSED", "Client is closed");
  }
  async capabilities(
    target: { sandbox?: Sandbox; create?: AdapterCreateInput } = {},
    options: WaitOptions = {},
  ): Promise<AdapterCapabilities> {
    this.ensureOpen();
    assertSignal(options.signal);
    const support = this.session.supports;
    const signal = AbortSignal.any([this.signal, ...(options.signal ? [options.signal] : [])]);

    let state: Awaited<ReturnType<typeof stateCapabilities>>;

    try {
      state = await readWhileOpen(
        this,
        raceAbort(
          stateCapabilities(this.session, target, {
            signal,
            deadline: Date.now() + 30000,
          }),
          signal,
        ),
      );
    } catch (error) {
      assertSignal(options.signal);

      if (error instanceof AdapterError) throw new SandbarError(error.code, error.message);
      throw error;
    }

    return structuredClone({
      ...state,
      observedAt: new Date().toISOString(),
      commands: [...(support.exec?.commands ?? [])],
      images: [...support.images],
      network: [...support.network],
      exec: !!this.session.exec && !!support.exec,
      inspect: !!this.session.inspect,
      inventory: !!this.session.inventory,
      readFile: !!this.session.files?.read,
      writeFile: !!this.session.files?.write,
      maxOutputBytes: support.exec?.maxOutputBytes ?? 0,
      maxFileBytes: this.session.files ? fileReadLimit(this.session.files.maxBytes) : 0,
    });
  }
  async checkCreate(input?: CreateInput): Promise<Support<CreatePlan>> {
    return this.checkCreateWithSignal(input, this.signal);
  }
  private async checkCreateWithSignal(
    input: CreateInput | undefined,
    signal: AbortSignal,
  ): Promise<Support<CreatePlan>> {
    this.ensureOpen();
    const request = validateCreate(input, this.session.defaultImage);
    this.checkImageBinding(request);

    for (const mount of request.mounts ?? [])
      assertResourceScope(mount.volume, { provider: this.provider, scope: this.scope });

    if (request.mounts?.length)
      sealedReference({
        version: 2,
        mode: "direct",
        kind: "create",
        provider: this.provider,
        scope: this.connection.scope,
        ...identity(),
        mounts: request.mounts,
      });

    return readWhileOpen(
      this,
      checkCreate(
        this.session,
        {
          image: { kind: request.environment.kind, value: request.environment.value },
          networkPolicy: request.networkPolicy ?? "blocked",
          region: request.region,
          labels: request.labels,
          requirements: request.requirements,
          mounts: request.mounts,
        },
        { signal, deadline: Date.now() + 30_000 },
      ),
    );
  }
  private checkImageBinding(
    request: CreateInput & { environment: import("./resource").ImageInput },
  ): void {
    if (
      request.environment.kind === "prepared" &&
      request.environment.binding &&
      (request.environment.binding.provider !== this.provider ||
        canonicalScope(request.environment.binding.scope) !== canonicalScope(this.scope))
    )
      throw new SandbarError("FORBIDDEN", "Prepared image scope differs from this connection");
  }
  async submitCreate(
    input?: CreateInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<AdapterOperation<AdapterSandbox>> {
    const request = validateCreate(input, this.session.defaultImage);
    this.checkImageBinding(request);

    for (const mount of request.mounts ?? [])
      assertResourceScope(mount.volume, { provider: this.provider, scope: this.scope });
    this.ensureOpen();
    assertSignal(options.signal);
    const signal = options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
    let evaluation: Support<CreatePlan>;

    try {
      evaluation = await raceAbort(this.checkCreateWithSignal(request, signal), signal);
    } catch (error) {
      this.ensureOpen();
      assertSignal(options.signal);

      if (error instanceof AdapterError && error.code === "TIMEOUT")
        throw new SandbarError(error.code, error.message);
      throw error;
    }

    this.ensureOpen();
    assertSignal(options.signal);

    if (evaluation.status === "unsupported")
      throw new UnsupportedFeatureError("create", [evaluation.reason]);

    if (evaluation.status !== "supported") throw new SandbarError("UNAVAILABLE", evaluation.reason);

    return this.submit(
      "create",
      {
        image: { kind: request.environment.kind, value: request.environment.value },
        networkPolicy: request.networkPolicy ?? "blocked",
        region: request.region,
        labels: request.labels,
        requirements: request.requirements,
        mounts: request.mounts,
      },
      (result, ref) => {
        if (result.kind !== "completed" || !("id" in result.value)) throw asUnknown(ref);

        if (
          request.mounts?.length &&
          (result.value.state !== "running" ||
            JSON.stringify(result.value.mounts) !== JSON.stringify(request.mounts))
        )
          throw asUnknown(ref, "Requested native mounts are not confirmed ready");

        return new AdapterSandbox(this, result.value.id, result.value.reference ?? null);
      },
      { ...options, mounts: request.mounts },
    );
  }
  private async reopenSandbox(
    reference: SandboxReference,
    options: WaitOptions,
  ): Promise<AdapterSandbox> {
    this.ensureOpen();

    try {
      reference = validateResourceReference(reference);

      if (reference.kind !== "sandbox")
        throw new SandbarError("INVALID_ARGUMENT", "Expected sandbox reference");
      assertResourceScope(reference, { provider: this.provider, scope: this.scope });
    } catch (error) {
      if (error instanceof AdapterError) throw new SandbarError(error.code, error.message);
      throw error;
    }

    if (!this.session.reopen) unsupported("reopen");
    assertSignal(options.signal);

    const timeout = AbortSignal.timeout(30000);

    const signal = AbortSignal.any([
      this.signal,
      ...(options.signal ? [options.signal] : []),
      timeout,
    ]);

    let info: SandboxInfo;

    try {
      info = await readWhileOpen(
        this,
        raceAbort(this.session.reopen(reference, { signal, deadline: Date.now() + 30000 }), signal),
      );
    } catch (error) {
      assertSignal(options.signal);

      if (timeout.aborted) throw new SandbarError("TIMEOUT", "Sandbox reopen timed out");

      if (error instanceof AdapterError) throw new SandbarError(error.code, error.message);
      throw error;
    }

    if (!info.reference)
      throw new SandbarError("INVALID_RESPONSE", "Provider did not verify sandbox identity");
    assertSandboxReference(info.reference, reference);

    if (info.state === "destroyed") throw new SandbarError("NOT_FOUND", "Sandbox is destroyed");

    return new AdapterSandbox(this, reference.nativeId, reference);
  }
  async submitBuild(
    input: ImageBuildInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<AdapterOperation<ImageBuildResult>> {
    if (!this.session.imageBuild) unsupported("image build");

    return this.submit(
      "image_build",
      input,
      (result, ref) => {
        if (result.kind !== "completed" || !("preparedId" in result.value)) throw asUnknown(ref);

        return {
          prepared: {
            kind: "prepared",
            value: result.value.preparedId,
            provider: this.provider,
            scope: structuredClone(this.scope),
          },
          retainedResources: result.value.retainedResources,
        };
      },
      options,
    );
  }
  async submit<T, K extends OperationKind = OperationKind>(
    kind: K,
    input: OperationInput,
    decode: (result: RuntimeResult, ref: AdapterRecoveryReference) => T,
    options: {
      signal?: AbortSignal;
      sandboxId?: string;
      sandboxReference?: SandboxReference;
      resource?: ResourceReference;
      capture?: z.infer<typeof CaptureExpectation>;
      mounts?: import("sandbar-adapter").MountSpec[];
      file?: { path: string; bytes: number };
      maxOutputBytes?: number;
    } = {},
  ): Promise<AdapterOperation<T, K>> {
    this.ensureOpen();
    assertSignal(options.signal);
    const prepared = await this.operations.prepare(kind, input, options);
    this.ensureOpen();
    assertSignal(options.signal);
    const ids = identity();

    let reference = sealedReference({
      version: 2,
      mode: "direct",
      provider: this.provider,
      kind,
      scope: this.connection.scope,
      ...ids,
      sandboxId: options.sandboxId,
      sandboxReference: options.sandboxReference,
      resource: options.resource,
      renewal: preparedRenewals.get(prepared),
      capture: options.capture,
      mounts: options.mounts,
      file: options.file,
      maxOutputBytes: options.maxOutputBytes,
    });

    this.telemetry.correlate({ reference });
    let first: RuntimeResult;
    let barrierStarted = false;
    const signals = options.signal ? [this.signal, options.signal] : [this.signal];
    const waiting = AbortSignal.any(signals);

    try {
      first = await waitForSubmission(
        prepared
          .submit(ids, {
            beforeSubmit: async () => {
              barrierStarted = true;
              await this.onReference?.(reference);

              return true;
            },
            signal: waiting,
            onCheckpoint: async (token, tokenVersion) => {
              reference = sealedReference({ ...reference, token, tokenVersion });
              await this.onReference?.(reference);
            },
          })
          .then((value) => {
            if (!value) throw new SandbarError("CONFLICT", "Submission was cancelled");

            return value;
          }),
        kind === "snapshot_capture" ? this.signal : waiting,
        this.signal,
        kind === "snapshot_delete" || kind === "volume_delete",
      );

      if (first.kind === "pending") {
        reference = sealedReference({
          ...reference,
          token: first.token,
          tokenVersion: first.version,
        });
        await this.onReference?.(reference);
      }
    } catch (error) {
      if (!barrierStarted) {
        this.ensureOpen();
        assertSignal(options.signal);
        throw error;
      }

      if (error instanceof BeforeSubmitError) throw error.original;

      if (error instanceof AdapterCheckpointError && error.outcome)
        throw new SandbarError(
          "REFERENCE_SAVE_FAILED",
          error.message,
          "possible",
          this.checkedOutcome(reference, error.outcome),
          reference,
        );

      if (waiting.aborted && kind === "sandbox_renew" && !dispatchedRenewals.has(prepared)) {
        throw new SandbarError("WAIT_ABORTED", "Waiting stopped before renewal dispatch", "none");
      }

      if (waiting.aborted) abortWaiting(reference, waiting.reason);
      throw asUnknown(reference, "Provider submission outcome is unknown");
    }

    return new AdapterOperation(this, reference, decode, first, kind);
  }
  checkedOutcome(
    reference: AdapterRecoveryReference,
    outcome?: import("sandbar-adapter").OperationOutcome,
  ): import("sandbar-adapter").OperationOutcome | undefined {
    if (!outcome) return undefined;
    const parsed = OperationOutcome.safeParse(outcome);

    if (!parsed.success) throw asUnknown(reference, "Provider partial result failed validation");
    const checked = parsed.data;

    if (checked.kind !== reference.kind)
      throw asUnknown(reference, "Provider partial result does not match operation");

    if (checked.kind === "sandbox_renew") {
      if (!reference.sandboxReference || !reference.renewal)
        throw asUnknown(reference, "Saved renewal intent is missing");
      assertSandboxReference(checked.reference, reference.sandboxReference);

      if (checked.requested.forSeconds !== reference.renewal.forSeconds)
        throw asUnknown(reference, "Observed renewal intent differs");

      if (checked.observation?.reference)
        assertSandboxReference(checked.observation.reference, reference.sandboxReference);

      return checked;
    }

    const resources =
      checked.kind === "snapshot_capture"
        ? checked.snapshot
          ? [checked.snapshot]
          : []
        : checked.retainedVolumes;

    try {
      for (const resource of resources)
        assertResourceScope(resource, { provider: this.provider, scope: this.scope });
    } catch {
      throw asUnknown(reference, "Provider partial result scope differs");
    }

    if (checked.kind === "snapshot_capture" && checked.capture && reference.capture) {
      const expected = reference.capture.profile;

      if (
        checked.capture.preserve !== expected.preserve ||
        checked.capture.interruption !== expected.interruption ||
        checked.capture.restoreExecution !== expected.restoreExecution
      )
        throw asUnknown(reference, "Provider partial capture guarantees differ");
    }

    return checked;
  }
  async persistReference(reference: AdapterRecoveryReference): Promise<void> {
    try {
      await this.onReference?.(reference);
    } catch {
      throw asUnknown(reference, "Operation reference persistence failed after submission");
    }
  }

  private assertRecoverySandbox(reference: {
    sandboxId?: string;
    sandboxReference?: SandboxReference;
  }): void {
    if (!reference.sandboxReference) return;

    if (reference.sandboxReference.nativeId !== reference.sandboxId)
      throw new SandbarError("INVALID_ARGUMENT", "Recovery sandbox identity differs");

    try {
      assertResourceScope(reference.sandboxReference, {
        provider: this.provider,
        scope: this.scope,
      });
    } catch (error) {
      if (error instanceof AdapterError) throw new SandbarError(error.code, error.message);
      throw error;
    }
  }

  async recover(reference: AdapterRecoveryReference): Promise<RecoveredOperation> {
    this.ensureOpen();
    reference = sealedReference(reference);

    if (
      reference.provider !== this.provider ||
      canonicalScope(reference.scope) !== canonicalScope(this.connection.scope)
    )
      throw new SandbarError("FORBIDDEN", "Recovery scope does not match the verified connection");

    if (
      ["snapshot_restore", "snapshot_delete", "volume_delete"].includes(reference.kind) &&
      !reference.resource
    )
      throw new SandbarError("INVALID_ARGUMENT", "Recovery resource is missing");

    if (reference.kind === "snapshot_capture" && !reference.capture)
      throw new SandbarError("INVALID_ARGUMENT", "Recovery capture expectations are missing");

    if (reference.kind === "sandbox_renew" && (!reference.renewal || !reference.sandboxReference))
      throw new SandbarError(
        "INVALID_ARGUMENT",
        "Recovery renewal intent and identity are missing",
      );

    this.assertRecoverySandbox(reference);
    assertRecoveryResourceKind(reference.kind, reference.resource);

    if (reference.resource)
      assertResourceScope(reference.resource, { provider: this.provider, scope: this.scope });

    for (const mount of reference.mounts ?? [])
      assertResourceScope(mount.volume, { provider: this.provider, scope: this.scope });

    if (
      [
        "create",
        "image_build",
        "volume_create",
        "snapshot_restore",
        "snapshot_delete",
        "volume_delete",
      ].includes(reference.kind) &&
      reference.sandboxId
    )
      throw new SandbarError("INVALID_ARGUMENT", "Create reference cannot have a sandbox");

    if (
      ["destroy", "exec", "file_write", "snapshot_capture", "sandbox_renew"].includes(
        reference.kind,
      ) &&
      !reference.sandboxId
    )
      throw new SandbarError("INVALID_ARGUMENT", "Recovery sandbox is missing");

    const completed = (result: RuntimeResult, ref: AdapterRecoveryReference) => {
      if (result.kind !== "completed") throw asUnknown(ref);

      return result.value;
    };

    switch (reference.kind) {
      case "sandbox_renew":
        return new AdapterOperation(this, reference, decodeRenew, undefined, "sandbox_renew");
      case "snapshot_capture":
        return new AdapterOperation(
          this,
          reference,
          (result, ref) => {
            const value = completed(result, ref);

            if (!("snapshot" in value)) throw asUnknown(ref);

            return decodeCapture(this, value, ref);
          },
          undefined,
          "snapshot_capture",
        );
      case "snapshot_restore":
      case "create":
        return new AdapterOperation(
          this,
          reference,
          (result, ref) => {
            const value = completed(result, ref);

            if (!("id" in value) || (ref.kind === "snapshot_restore" && value.state !== "running"))
              throw asUnknown(ref);

            if (
              ref.mounts?.length &&
              (value.state !== "running" ||
                JSON.stringify(value.mounts) !== JSON.stringify(ref.mounts))
            )
              throw asUnknown(ref, "Recovered mounts not confirmed ready");

            return new AdapterSandbox(this, value.id, value.reference ?? null);
          },
          undefined,
          reference.kind,
        );
      case "snapshot_delete":
      case "volume_delete":
        return new AdapterOperation(
          this,
          reference,
          (result, ref) => {
            const value = completed(result, ref);

            if (!("deleted" in value) || !ref.resource) throw asUnknown(ref);
            assertResourceIdentity(value.reference, ref.resource);

            return value;
          },
          undefined,
          reference.kind,
        );
      case "volume_create":
        return new AdapterOperation(
          this,
          reference,
          (result, ref) => {
            const value = completed(result, ref);

            if (!("filesystem" in value)) throw asUnknown(ref);

            return new AdapterVolume(this, value.reference);
          },
          undefined,
          "volume_create",
        );
      case "image_build":
        return new AdapterOperation(
          this,
          reference,
          (result, ref) => {
            const value = completed(result, ref);

            if (!("preparedId" in value)) throw asUnknown(ref);

            return {
              prepared: {
                kind: "prepared" as const,
                value: value.preparedId,
                provider: this.provider,
                scope: structuredClone(this.scope),
              },
              retainedResources: value.retainedResources,
            };
          },
          undefined,
          "image_build",
        );
      case "exec":
        return new AdapterOperation(
          this,
          reference,
          (result, ref) => {
            const value = completed(result, ref);

            if (
              !("stdout" in value) ||
              !(value.stdout instanceof Uint8Array) ||
              !(value.stderr instanceof Uint8Array)
            )
              throw asUnknown(ref);

            return checkExec(
              execOutput(value.exitCode, value.stdout, value.stderr, value.truncated),
            );
          },
          undefined,
          "exec",
        );
      case "destroy":
        return new AdapterOperation(
          this,
          reference,
          (result, ref) => {
            const value = completed(result, ref);

            if (!("computeStopped" in value) || !value.computeStopped) throw asUnknown(ref);

            return value;
          },
          undefined,
          "destroy",
        );
      case "file_write":
        return new AdapterOperation(
          this,
          reference,
          (result, ref) => {
            const value = completed(result, ref);

            if (!("bytesWritten" in value) || value.bytesWritten !== ref.file?.bytes)
              throw asUnknown(ref);
          },
          undefined,
          "file_write",
        );
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = this.connection.close();
    }

    return this.closePromise;
  }
}

/** Default storage requirement for new compute cleanup submissions. */
export type DirectConnectOptions = ObservabilityOptions & {
  cleanup?: { storage?: "require-durable" | "allow-unconfirmed" };
};

export type AdapterConnectOptions<
  C extends z.ZodType,
  K extends z.ZodType,
  S extends RuntimeSession,
> = DirectConnectOptions & {
  adapter: Pick<AdapterDefinition<C, K, S>, "name" | "config" | "credentials"> & {
    connect: (input: never) => Promise<S>;
    policy?: { schema: z.ZodType; default: Json };
  };
  config: z.input<C>;
  credentials: z.input<K>;
  onReference?: (reference: AdapterRecoveryReference) => void | Promise<void>;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A cleanup hook may throw any JavaScript value; the diagnostic receives it intact.
  onDiagnostic?: (error: unknown) => void;
};

export function connectDirect(
  adapter: BoundAdapter,
  options?: DirectConnectOptions,
): Promise<AdapterDirectClient>;
export function connectDirect<C extends z.ZodType, K extends z.ZodType, S extends RuntimeSession>(
  options: AdapterConnectOptions<C, K, S>,
): Promise<AdapterDirectClient>;

export async function connectDirect<
  C extends z.ZodType,
  K extends z.ZodType,
  S extends RuntimeSession,
>(
  options: AdapterConnectOptions<C, K, S> | BoundAdapter,
  observability: DirectConnectOptions = {},
): Promise<AdapterDirectClient> {
  const cleanup = z
    .strictObject({ storage: z.enum(["require-durable", "allow-unconfirmed"]).optional() })
    .optional()
    .safeParse(("bound" in options ? observability : options).cleanup);

  if (!cleanup.success)
    throw new SandbarError("INVALID_ARGUMENT", "Invalid cleanup configuration", "none");
  const storage = cleanup.data?.storage ?? "require-durable";

  const telemetry = new Telemetry(
    "bound" in options ? observability : options,
    "direct",
    "bound" in options ? options.name : options.adapter.name,
  );

  return telemetry.run("sandbar.connect", async () => {
    if ("bound" in options) {
      const connection = await connectAdapter(options, { config: {}, credentials: {} });

      return new AdapterDirectClient(options.name, connection, undefined, observability, storage);
    }

    const connection = await connectAdapter(options.adapter, {
      config: options.config,
      credentials: options.credentials,
      onDiagnostic: options.onDiagnostic,
    });

    return new AdapterDirectClient(
      options.adapter.name,
      connection,
      options.onReference,
      options,
      storage,
    );
  });
}
