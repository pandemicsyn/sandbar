/** Research-only direct CREATE path. This package is deliberately absent from SDK exports. */
import { Cause, Context, Effect, Either, Exit, Layer, ManagedRuntime, Option } from "effect";
import {
  correlateDriverResult,
  normalizeCreate,
  resultDisposition,
  sameNativeScope,
} from "@sandbar/core";
import {
  NativeScope,
  ProviderReadError,
  SandboxRef,
  type DriverResult,
  type InvocationIdentity,
  type NativeRef,
  type ProviderDriver,
} from "@sandbar/provider-spi";
import {
  DirectClient,
  OutcomeUnknownError,
  SandbarError,
  WaitAbortedError,
  type DirectOptions,
  type CreateInput,
  type ExecInput,
  type ExecOutput,
  type OperationHandle,
  type RecoveryReference,
  type SandboxHandle,
} from "@sandbar/sdk/direct";
import {
  newInvocationKey,
  sealedReference,
  throwIfAborted,
  validateCreate,
} from "../../sdk/src/resource";

const providerErrorCodes = {
  invalid: "INVALID_ARGUMENT",
  unsupported: "UNSUPPORTED",
  unauthorized: "UNAUTHENTICATED",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  capacity: "CAPACITY",
  rate_limit: "RATE_LIMIT",
  unavailable: "UNAVAILABLE",
  timeout: "TIMEOUT",
  internal: "INTERNAL",
} as const;

function preflightDriver<A>(call: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.mapError(fromDriver(call), (error) =>
    error instanceof ProviderReadError
      ? new SandbarError(error.code, error.message, "none")
      : error,
  );
}

class Provider extends Context.Tag("@sandbar/effect-prototype/Provider")<
  Provider,
  ProviderDriver
>() {}

/** Legacy SPI bridge: fiber interruption stops waiting, never proves the underlying Promise stopped. */
function fromDriver<A>(call: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.async<A, unknown>((resume) => {
    try {
      call().then(
        (value) => resume(Effect.succeed(value)),
        (error) => resume(Effect.fail(error)),
      );
    } catch (error) {
      resume(Effect.fail(error));
    }
  });
}

function identity(): InvocationIdentity {
  const id = () => `sdk_${crypto.randomUUID().replaceAll("-", "")}`;

  return {
    projectId: "direct",
    operationId: id(),
    invocationKey: newInvocationKey(),
    submissionId: id(),
  };
}

/** Only read-only observation is repeated; mutation dispatch never enters this loop. */
export function pollReadOnly<A, E>(
  observe: () => Effect.Effect<A | null, E>,
  pollMs: number,
): Effect.Effect<A, E> {
  return Effect.gen(function* () {
    for (;;) {
      const value = yield* observe();

      if (value !== null) return value;
      yield* Effect.sleep(pollMs);
    }
  });
}

type CreateOptions = { signal?: AbortSignal; onDispatch?: (reference: RecoveryReference) => void };

export class EffectCreateClient {
  readonly scope: Readonly<NativeScope>;
  private readonly closeController = new AbortController();
  private readonly runtime: ManagedRuntime.ManagedRuntime<Provider, never>;
  private readonly decoder: DirectClient;
  private closed = false;
  readonly sandboxes = {
    create: (input: CreateInput, options: CreateOptions = {}) => this.create(input, options),
    submitCreate: (input: CreateInput, options: CreateOptions = {}) =>
      this.submitCreate(input, options),
  };

  constructor(options: DirectOptions) {
    const scope = NativeScope.safeParse(options.provider.scope);

    if (!scope.success) throw new SandbarError("INVALID_ARGUMENT", "Invalid provider scope");
    this.scope = Object.freeze(scope.data);

    if (options.provider.driver.name !== this.scope.provider)
      throw new SandbarError("INVALID_ARGUMENT", "Provider name and scope mismatch");
    this.runtime = ManagedRuntime.make(
      Layer.scoped(
        Provider,
        Effect.acquireRelease(Effect.succeed(options.provider.driver), () =>
          Effect.sync(() =>
            this.closeController.abort(new SandbarError("CLIENT_CLOSED", "Client is closed")),
          ),
        ),
      ),
    );
    this.decoder = new DirectClient(options);
  }

  ensureOpen() {
    if (this.closed) throw new SandbarError("CLIENT_CLOSED", "Client is closed");
  }
  private combined(signal?: AbortSignal) {
    return signal
      ? AbortSignal.any([signal, this.closeController.signal])
      : this.closeController.signal;
  }
  private async run<A, E>(
    program: Effect.Effect<A, E, Provider>,
    signal?: AbortSignal,
    reference?: () => RecoveryReference | undefined,
  ): Promise<A> {
    const interrupted = (): never => {
      const ref = reference?.();

      if (this.closed && ref)
        throw new OutcomeUnknownError(
          ref,
          "Client closed after submission; recover with this reference",
        );

      if (signal?.aborted && ref) throw new WaitAbortedError(ref, signal.reason);

      if (this.closed) throw new SandbarError("CLIENT_CLOSED", "Client is closed");
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    };

    let exit: Exit.Exit<A, E>;

    try {
      exit = await this.runtime.runPromise(Effect.exit(program), { signal: this.combined(signal) });
    } catch (error) {
      if (this.closed || signal?.aborted) return interrupted();
      throw error;
    }

    if (Exit.isSuccess(exit)) return exit.value;

    if (this.closed || signal?.aborted) return interrupted();
    const failure = Cause.failureOption(exit.cause);

    if (Option.isSome(failure)) throw failure.value;
    throw Cause.squash(exit.cause);
  }

  private reference(invocation: InvocationIdentity): RecoveryReference {
    return sealedReference({
      version: 1,
      mode: "direct",
      kind: "create",
      invocationKey: invocation.invocationKey,
      submissionId: invocation.submissionId,
      operationId: invocation.operationId,
      scope: this.scope,
    });
  }

  async submitCreate(
    input: CreateInput,
    options: CreateOptions = {},
  ): Promise<OperationHandle<SandboxHandle>> {
    this.ensureOpen();
    throwIfAborted(options.signal);
    let dispatched: RecoveryReference | undefined;
    let first: DriverResult | undefined;

    const program = Effect.gen(this, function* () {
      const valid = yield* Effect.sync(() => validateCreate(input));

      const request = yield* Effect.sync(() =>
        normalizeCreate({
          environment:
            valid.environment.kind === "prepared"
              ? { kind: "prepared", imageId: valid.environment.value }
              : { kind: "oci", reference: valid.environment.value },
          region: valid.region,
          network: { policy: valid.networkPolicy ?? "blocked" },
          labels: valid.labels,
        }),
      );

      const driver = yield* Provider;
      const caps = yield* preflightDriver(() => driver.capabilities(this.scope));

      if (caps.provider !== this.scope.provider)
        return yield* Effect.fail(
          new SandbarError("INVALID_RESPONSE", "Provider capability identity mismatch"),
        );

      const prep = yield* preflightDriver(() =>
        driver.prepare({
          scope: this.scope,
          image: request.image,
          networkPolicy: request.networkPolicy,
          region: request.region,
        }),
      );

      if (!prep.supported || !prep.effectiveImage)
        return yield* Effect.fail(
          new SandbarError("UNSUPPORTED", prep.reason ?? "Provider cannot prepare image"),
        );

      // No yield between publishing the reference and invoking the legacy Promise transport.
      const submitted = yield* Effect.sync(() => {
        const invocation = identity();
        const ref = this.reference(invocation);
        options.onDispatch?.(ref);
        dispatched = ref;
        let promise: Promise<DriverResult>;

        try {
          promise = driver.create({
            scope: this.scope,
            identity: invocation,
            image: prep.effectiveImage!,
            networkPolicy: request.networkPolicy,
            labels: request.labels,
          });
        } catch (error) {
          promise = Promise.reject(error);
        }

        return { ref, promise };
      });

      const response = yield* Effect.either(fromDriver(() => submitted.promise));

      if (Either.isRight(response)) first = response.right;

      // A rejected submission response cannot certify no effect.
      return submitted.ref;
    });

    const reference = await this.run(program, options.signal, () => dispatched);

    return new EffectCreateOperation(this, reference, first);
  }

  async create(input: CreateInput, options: CreateOptions = {}): Promise<SandboxHandle> {
    const operation = await this.submitCreate(input, options);

    try {
      return await operation.wait(options);
    } catch (error) {
      if (error instanceof SandbarError && error.code === "CLIENT_CLOSED")
        throw new OutcomeUnknownError(
          operation.reference,
          "Client closed after submission; recover with this reference",
        );

      if (options.signal?.aborted)
        throw new WaitAbortedError(operation.reference, options.signal.reason);
      throw error;
    }
  }

  async recover(reference: RecoveryReference): Promise<OperationHandle<SandboxHandle>> {
    this.ensureOpen();
    const checked = sealedReference(reference);

    if (
      checked.kind !== "create" ||
      checked.mode !== "direct" ||
      !checked.scope ||
      !sameNativeScope(checked.scope, this.scope)
    )
      throw new SandbarError("FORBIDDEN", "Recovery scope does not match configured provider");

    const caps = await this.run(
      Effect.flatMap(Provider, (driver) => preflightDriver(() => driver.capabilities(this.scope))),
    );

    if (caps.provider !== this.scope.provider)
      throw new SandbarError("INVALID_RESPONSE", "Provider capability identity mismatch");

    return new EffectCreateOperation(this, checked);
  }

  async observation(
    reference: RecoveryReference,
    first?: DriverResult,
    signal?: AbortSignal,
  ): Promise<SandboxHandle | null> {
    this.ensureOpen();

    const initialResponse = first !== undefined;
    let raw: DriverResult | null;

    try {
      raw = initialResponse
        ? first
        : await this.run(
            Effect.flatMap(Provider, (driver) =>
              fromDriver(() =>
                driver.observe({ scope: this.scope, submissionId: reference.submissionId! }),
              ),
            ),
            signal,
          );
    } catch {
      throw new OutcomeUnknownError(
        reference,
        "Provider observation failed after submission; observe without replay",
      );
    }

    this.ensureOpen();

    if (!raw)
      throw new OutcomeUnknownError(
        reference,
        "Provider has no observation for this submission; resubmission is unsafe",
      );
    let result: DriverResult;

    try {
      result = correlateDriverResult(raw, {
        submissionId: reference.submissionId!,
        kind: "create",
        scope: this.scope,
        requireSubmissionId: !initialResponse,
      });
    } catch {
      throw new OutcomeUnknownError(
        reference,
        "Provider result failed identity or scope validation; observe without replay",
      );
    }

    const disposition = resultDisposition(result, initialResponse ? "submission" : "observation");

    if (disposition === "definitive_rejection" && result.status === "rejected")
      throw new SandbarError(providerErrorCodes[result.error.code], result.error.message, "none");

    if (result.status === "rejected")
      throw new OutcomeUnknownError(
        reference,
        "Observed rejection cannot prove the earlier submission had no effect",
      );

    if (result.status === "unknown") throw new OutcomeUnknownError(reference);

    if (result.status === "pending") return null;

    if (result.value.kind !== "sandbox")
      throw new OutcomeUnknownError(reference, "Provider returned a non-sandbox completion");

    // Delay reuse of non-CREATE methods until the caller actually needs them.
    return new PrototypeSandbox(this.decoder, reference, result.value.observation.ref);
  }

  wait(
    reference: RecoveryReference,
    first: DriverResult | undefined,
    options: { signal?: AbortSignal; pollMs?: number },
  ): Promise<SandboxHandle> {
    const pollMs = options.pollMs ?? 500;

    if (!Number.isSafeInteger(pollMs) || pollMs < 50 || pollMs > 60_000)
      return Promise.reject(new RangeError("Invalid pollMs"));
    let initial = first;

    const program = pollReadOnly(() => {
      const current = initial;
      initial = undefined;

      return fromDriver(() => this.observation(reference, current, options.signal));
    }, pollMs);

    return this.run(program, options.signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort(new SandbarError("CLIENT_CLOSED", "Client is closed"));
    await this.decoder.close();
    await this.runtime.dispose();
  }
}

/** Bounded shortcut: methods outside CREATE stay on the baseline implementation. */
class PrototypeSandbox implements SandboxHandle {
  readonly id: string;
  readonly ref: Readonly<NativeRef>;
  private materialized?: Promise<SandboxHandle>;
  constructor(
    private readonly decoder: DirectClient,
    private readonly reference: RecoveryReference,
    ref: NativeRef,
  ) {
    const parsed = SandboxRef.safeParse(ref);

    if (!parsed.success)
      throw new SandbarError(
        "INVALID_RESPONSE",
        "Provider returned invalid sandbox ref",
        "unknown",
      );

    Object.freeze(parsed.data.scope);
    this.ref = Object.freeze(parsed.data);
    this.id = this.ref.nativeId;
  }
  private resolve(): Promise<SandboxHandle> {
    return (this.materialized ??= this.decoder.recover(this.reference).then(async (operation) => {
      // SAFETY: a validated direct CREATE reference decodes to the baseline SandboxHandle.
      const box = (await operation.wait()) as SandboxHandle;

      if (box.id !== this.id)
        throw new OutcomeUnknownError(
          this.reference,
          "Provider changed the sandbox identity during handle resolution",
        );

      return box;
    }));
  }
  async inspect() {
    return (await this.resolve()).inspect();
  }
  async exec(input: ExecInput, options?: { signal?: AbortSignal }): Promise<ExecOutput> {
    return (await this.resolve()).exec(input, options);
  }
  async submitExec(
    input: ExecInput,
    options?: { signal?: AbortSignal },
  ): Promise<OperationHandle<ExecOutput>> {
    return (await this.resolve()).submitExec(input, options);
  }
  async readFile(path: string): Promise<Uint8Array> {
    return (await this.resolve()).readFile(path);
  }
  async writeFile(
    path: string,
    bytes: Uint8Array,
    options?: { overwrite?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    return (await this.resolve()).writeFile(path, bytes, options);
  }
  async destroy(options?: { signal?: AbortSignal }): Promise<void> {
    return (await this.resolve()).destroy(options);
  }
}

class EffectCreateOperation implements OperationHandle<SandboxHandle> {
  readonly durability = "process" as const;
  readonly reference: RecoveryReference;
  private first?: DriverResult;
  private settled?: { value: SandboxHandle } | { error: unknown };
  constructor(
    private readonly client: EffectCreateClient,
    reference: RecoveryReference,
    first?: DriverResult,
  ) {
    this.reference = sealedReference(reference);
    this.first = first;
  }
  async observe(): Promise<SandboxHandle | null> {
    this.client.ensureOpen();

    if (this.settled) {
      if ("error" in this.settled) throw this.settled.error;

      return this.settled.value;
    }

    const first = this.first;
    this.first = undefined;

    try {
      const value = await this.client.observation(this.reference, first);

      if (value) this.settled = { value };

      return value;
    } catch (error) {
      if (error instanceof SandbarError) this.settleTerminalError(error);
      throw error;
    }
  }
  async wait(options: { signal?: AbortSignal; pollMs?: number } = {}): Promise<SandboxHandle> {
    this.client.ensureOpen();

    if (this.settled) {
      if ("error" in this.settled) throw this.settled.error;

      return this.settled.value;
    }

    const first = this.first;
    this.first = undefined;

    try {
      const value = await this.client.wait(this.reference, first, options);
      this.settled = { value };

      return value;
    } catch (error) {
      if (error instanceof SandbarError) this.settleTerminalError(error);
      throw error;
    }
  }
  private settleTerminalError(error: SandbarError): void {
    if (
      error.code !== "OUTCOME_UNKNOWN" &&
      error.code !== "CLIENT_CLOSED" &&
      error.code !== "WAIT_ABORTED"
    )
      this.settled = { error };
  }
}
