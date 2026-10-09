import {
  AdapterError,
  type NativeProcess,
  type Sandbox,
  type ProcessOutput,
  type NativeProcessStatus,
} from "sandbar-adapter";
import { z } from "zod";
import {
  SandbarError,
  validateExec,
  validateFilePath,
  checkExec,
  execOutput,
  type ExecOutput,
  raceAbort,
  type ExecInput,
} from "./resource";
import type { AdapterDirectClient } from "./adapter-direct";
import { noteOperation } from "./observability";

export type { ProcessOutput } from "sandbar-adapter";

export type StartProcessInput = Pick<
  ExecInput,
  "command" | "cwd" | "env" | "maxOutputBytes" | "deadlineSeconds"
> & { stdin?: "closed" | "pipe"; output?: { mode: "stream" } };

export type ProcessTermination = { status: "requested" | "not-found" | "exited" };

export type ProcessExit = { exitCode: number; outputComplete: boolean };

export type ProcessStatus = Omit<NativeProcessStatus, "exit"> & { exit?: ProcessExit };

/** Local context only; these fields cannot reopen a command. */
export type ProcessFailure = SandbarError & {
  provider: string;
  sandboxId: string;
  confirmedExit?: ProcessExit;
};

export interface ProcessHandle {
  readonly provider: string;
  /** Returning a sustained iterator releases output only; finite legacy iterators detach the handle. */
  output(options?: { signal?: AbortSignal }): AsyncIterable<ProcessOutput>;
  wait(options?: { signal?: AbortSignal }): Promise<ProcessExit>;
  write(input: string | Uint8Array, options?: { signal?: AbortSignal }): Promise<void>;
  closeStdin(options?: { signal?: AbortSignal }): Promise<void>;
  status(options?: { signal?: AbortSignal }): Promise<ProcessStatus>;
  terminate(options?: { signal?: AbortSignal }): Promise<ProcessTermination>;
  /** Dispose local IO and cancel pending local controls; never terminate the remote process. */
  detach(): Promise<void>;
}

const Exit = z.object({ exitCode: z.number().int().safe() });

const Termination = z.object({ status: z.enum(["requested", "not-found"]) });

const Chunk = z.object({ stream: z.enum(["stdout", "stderr"]), text: z.string() });

const encoder = new TextEncoder();

const aborted = () => new SandbarError("WAIT_ABORTED", "Local observation stopped", "possible");

/** Best effort local release must never block a public wait or client close. */
function release(native: NativeProcess): void {
  try {
    void native.detach().catch(() => undefined);
  } catch {
    /* Local cleanup is best effort. */
  }
}

class TextProcess implements ProcessHandle {
  native?: NativeProcess;
  private queue: { chunk: ProcessOutput; bytes: number }[] = [];
  private queuedBytes = 0;
  private total = 0;
  private used = false;
  private stopped = false;
  private finished = false;
  private complete = false;
  private exitCode?: number;
  private failure?: SandbarError;
  private detached = false;
  private readonly local = new AbortController();
  private waitFailure?: SandbarError;
  private inputClosed = false;
  private inputClosing = false;
  private inputFailure?: SandbarError;
  private pendingInputBytes = 0;
  private pendingInputCalls = 0;
  private inputTail: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private termination?: Promise<ProcessTermination>;
  private listeners = new Set<() => void>();
  private removeOutputAbort?: () => void;
  private readonly closed = () => {
    void this.detach();
  };
  constructor(
    readonly provider: string,
    private readonly sandboxId: string,
    private readonly max: number,
    private readonly signal: AbortSignal,
    private readonly controlActive: () => boolean,
    private readonly sustained: boolean,
    private readonly piped: boolean,
  ) {
    signal.addEventListener("abort", this.closed, { once: true });
  }
  get error(): SandbarError | undefined {
    return this.failure;
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native exit evidence is validated at the adapter boundary.
  private evidence(value: unknown): void {
    const parsed = Exit.safeParse(value);

    if (parsed.success) {
      this.exitCode = parsed.data.exitCode;

      if (this.failure) {
        const failure: ProcessFailure = Object.assign(this.failure, {
          provider: this.provider,
          sandboxId: this.sandboxId,
          confirmedExit: { exitCode: this.exitCode, outputComplete: this.complete },
        });

        noteOperation(failure, "completed", "applied");
      }
    }
  }
  private rememberNativeExit(): void {
    this.evidence(this.native?.confirmedExit);
  }
  fail(error: SandbarError): void {
    if (this.stopped || this.failure) return;
    this.rememberNativeExit();

    const failure: ProcessFailure = Object.assign(error, {
      provider: this.provider,
      sandboxId: this.sandboxId,
    });

    if (this.exitCode !== undefined)
      failure.confirmedExit = { exitCode: this.exitCode, outputComplete: this.complete };

    if (this.exitCode !== undefined) noteOperation(failure, "completed", "applied");
    this.failure = failure;
    this.stopped = true;

    if (!this.sustained) {
      this.detached = true;
      this.local.abort();
    }

    if (!this.queue.length) this.removeOutputAbort?.();

    if (this.native) {
      if (this.sustained) this.releaseOutput();
      else release(this.native);
    }

    this.notify();
  }
  private releaseOutput(): void {
    try {
      void this.native?.detachOutput?.().catch(() => undefined);
    } catch {
      /* Output disposal must not hold observation or control. */
    }
  }
  onOutput = (value: ProcessOutput): void => {
    if (this.stopped) return;
    const checked = Chunk.safeParse(value);

    if (!checked.success) {
      const error = new SandbarError("INVALID_RESPONSE", "Invalid process text", "possible");
      this.fail(error);
      throw error;
    }

    const { stream, text } = checked.data;
    // Count without allocating an encoded copy of an arbitrarily large native callback.
    let bytes = 0;

    for (const point of text) {
      bytes += encoder.encode(point).length;

      if ((!this.sustained && this.total + bytes > this.max) || this.queuedBytes + bytes > 65_536) {
        const error = new SandbarError(
          "OUTPUT_CAPACITY",
          "Process text budget exceeded",
          "possible",
        );

        this.fail(error);
        throw error;
      }
    }

    if (!bytes) return;
    const parts: { chunk: ProcessOutput; bytes: number }[] = [];
    let part = "";
    let partBytes = 0;

    for (const point of text) {
      const size = encoder.encode(point).length;

      if (partBytes + size > 16_384) {
        parts.push({ chunk: { stream, text: part }, bytes: partBytes });
        part = "";
        partBytes = 0;
      }

      part += point;
      partBytes += size;
    }

    parts.push({ chunk: { stream, text: part }, bytes: partBytes });

    if (this.queue.length + parts.length > 256) {
      const error = new SandbarError(
        "OUTPUT_CAPACITY",
        "Process chunk budget exceeded",
        "possible",
      );

      this.fail(error);
      throw error;
    }

    if (!this.sustained) this.total += bytes;
    this.queuedBytes += bytes;
    this.queue.push(...parts);
    this.notify();
  };
  attach(native: NativeProcess): void {
    this.native = native;

    if (this.sustained && (!native.outputDone || !native.detachOutput))
      this.fail(
        new SandbarError("INVALID_RESPONSE", "Sustained output contract is incomplete", "possible"),
      );

    if (native.outputDone)
      void native.outputDone.then(
        () => {
          this.finished = true;
          this.notify();
        },
        () =>
          this.fail(
            new SandbarError("UNAVAILABLE", "Process output observation failed", "possible"),
          ),
      );

    // Observe immediately, even when setup was abandoned and a handle arrived late.
    void Promise.resolve()
      .then(() => native.wait())
      .then(
        (value) => {
          this.evidence(value);

          if (this.exitCode === undefined) {
            this.waitFailure = new SandbarError(
              "INVALID_RESPONSE",
              "Invalid process exit",
              "possible",
            );
            this.fail(this.waitFailure);
            this.notify();
          } else {
            if (!native.outputDone) this.finished = true;
            this.notify();
          }
        },
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Adapter wait errors are untrusted; confirmedExit is schema-validated below.
        (error: unknown) => {
          const evidence = z.object({ confirmedExit: Exit.optional() }).safeParse(error);

          if (evidence.success) this.evidence(evidence.data.confirmedExit);
          this.rememberNativeExit();
          this.waitFailure = new SandbarError(
            "UNAVAILABLE",
            "Process observation failed",
            "possible",
          );
          this.fail(this.waitFailure);
          this.notify();
        },
      )
      .catch(() => {
        this.waitFailure = new SandbarError(
          "UNAVAILABLE",
          "Process observation failed",
          "possible",
        );
        this.fail(this.waitFailure);
        this.notify();
      });

    if (this.detached || (this.stopped && !this.sustained)) release(native);
    else if (this.failure && this.sustained) this.releaseOutput();
  }
  output(options: { signal?: AbortSignal } = {}): AsyncIterable<ProcessOutput> {
    if (this.used) throw new SandbarError("INVALID_ARGUMENT", "Process output has one consumer");
    this.used = true;
    const signal = options.signal;

    const stop = () => {
      if (this.complete) return;
      this.fail(aborted());
      this.queue = [];
      this.queuedBytes = 0;
      this.removeOutputAbort?.();

      if (!this.sustained) this.signal.removeEventListener("abort", this.closed);
    };

    signal?.addEventListener("abort", stop, { once: true });
    this.removeOutputAbort = () => signal?.removeEventListener("abort", stop);

    if (this.stopped && !this.queue.length) this.removeOutputAbort();

    if (signal?.aborted) stop();

    const next = async (): Promise<IteratorResult<ProcessOutput>> => {
      while (true) {
        if (signal?.aborted && !this.complete) {
          stop();
          throw aborted();
        }

        const part = this.queue.shift();

        if (part) {
          this.queuedBytes -= part.bytes;

          return { done: false, value: part.chunk };
        }

        if (this.failure) {
          this.removeOutputAbort?.();

          if (!this.sustained) this.signal.removeEventListener("abort", this.closed);
          throw this.failure;
        }

        if (this.stopped || this.finished) {
          if (this.finished && !this.stopped) this.complete = true;
          signal?.removeEventListener("abort", stop);

          if (!this.sustained) this.signal.removeEventListener("abort", this.closed);

          return { done: true, value: undefined };
        }

        await this.changed();
      }
    };

    const iterator: AsyncIterableIterator<ProcessOutput> = {
      next,
      return: async () => {
        signal?.removeEventListener("abort", stop);

        if (this.sustained) {
          this.queue = [];
          this.queuedBytes = 0;
          this.removeOutputAbort?.();

          if (!this.stopped) {
            this.stopped = true;
            this.releaseOutput();
            this.notify();
          }
        } else await this.detach();

        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    return iterator;
  }
  private changed(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        this.listeners.delete(done);
        signal?.removeEventListener("abort", abort);
        resolve();
      };

      const abort = () => {
        this.listeners.delete(done);
        signal?.removeEventListener("abort", abort);
        reject(aborted());
      };

      this.listeners.add(done);
      signal?.addEventListener("abort", abort, { once: true });

      if (signal?.aborted) abort();
    });
  }
  async wait(options: { signal?: AbortSignal } = {}): Promise<ProcessExit> {
    while (true) {
      if (options.signal?.aborted) throw aborted();
      this.rememberNativeExit();

      if (this.exitCode !== undefined)
        return { exitCode: this.exitCode, outputComplete: this.complete };

      if (this.failure && !this.sustained) throw this.failure;

      if (this.waitFailure) throw this.waitFailure;

      if (this.detached || (this.stopped && !this.sustained))
        throw new SandbarError(
          "UNAVAILABLE",
          "Process detached without confirmed exit",
          "possible",
        );
      await this.changed(options.signal);
    }
  }
  private checkInput(): void {
    this.rememberNativeExit();

    if (this.signal.aborted) throw this.terminationFailure("CLIENT_CLOSED", "Client is closed");

    if (this.detached || !this.controlActive())
      throw this.terminationFailure("UNAVAILABLE", "Process input is detached");

    if (this.exitCode !== undefined)
      throw this.terminationFailure("INVALID_ARGUMENT", "Process has exited");

    if (!this.piped) throw this.terminationFailure("UNSUPPORTED", "Process stdin is closed");

    if (this.inputFailure) throw this.inputFailure;
  }
  async write(input: string | Uint8Array, options: { signal?: AbortSignal } = {}): Promise<void> {
    this.checkInput();

    if (this.inputClosing || this.inputClosed)
      throw this.terminationFailure("INVALID_ARGUMENT", "Process stdin is closing or closed");

    if (options.signal?.aborted)
      throw this.terminationFailure("WAIT_ABORTED", "Input cancelled before dispatch");

    const parsed = z
      .union([
        z
          .string()
          .max(65_536)
          .transform((value) => encoder.encode(value)),
        z.instanceof(Uint8Array),
      ])
      .safeParse(input);

    if (!parsed.success) throw this.terminationFailure("INVALID_ARGUMENT", "Invalid process input");
    const bytes = parsed.data;

    if (bytes.byteLength > 65_536)
      throw this.terminationFailure("INPUT_CAPACITY", "Process write exceeds 64 KiB");

    if (!bytes.byteLength) return;

    if (!this.native?.write)
      throw this.terminationFailure("UNSUPPORTED", "Process stdin transport is unsupported");
    await this.enqueueInput(new Uint8Array(bytes), false, options.signal);
  }
  async closeStdin(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.inputClosed) return;
    this.checkInput();

    if (options.signal?.aborted)
      throw this.terminationFailure("WAIT_ABORTED", "EOF cancelled before dispatch");

    if (this.closePromise) {
      try {
        return await (options.signal
          ? raceAbort(this.closePromise, options.signal)
          : this.closePromise);
      } catch (error) {
        if (options.signal?.aborted)
          throw this.terminationFailure(
            "OUTCOME_UNKNOWN",
            "EOF observation stopped; the shared request may still complete",
            "possible",
          );
        throw error;
      }
    }

    if (!this.native?.closeStdin)
      throw this.terminationFailure("UNSUPPORTED", "Process EOF transport is unsupported");
    this.inputClosing = true;
    this.closePromise = this.enqueueInput(new Uint8Array(), true, options.signal).then(
      () => {
        this.inputClosed = true;
      },
      (error) => {
        this.inputClosing = false;
        this.closePromise = undefined;
        throw error;
      },
    );

    return this.closePromise;
  }
  private enqueueInput(bytes: Uint8Array, eof: boolean, caller?: AbortSignal): Promise<void> {
    if (this.pendingInputCalls >= 256 || this.pendingInputBytes + bytes.byteLength > 262_144)
      return Promise.reject(
        this.terminationFailure("INPUT_CAPACITY", "Process input queue is full"),
      );
    this.pendingInputCalls++;
    this.pendingInputBytes += bytes.byteLength;
    let dispatched = false;

    const work = this.inputTail
      .then(async () => {
        if (caller?.aborted || this.local.signal.aborted)
          throw this.terminationFailure("WAIT_ABORTED", "Input cancelled before dispatch");
        this.checkInput();
        const controller = new AbortController();

        const signal = AbortSignal.any([
          controller.signal,
          this.signal,
          this.local.signal,
          ...(caller ? [caller] : []),
        ]);

        const timer = setTimeout(() => controller.abort(), 30_000);

        try {
          dispatched = true;
          const context = { signal, deadline: Date.now() + 30_000 };
          await raceAbort(
            eof ? this.native!.closeStdin!(context) : this.native!.write!(bytes, context),
            signal,
          );
        } catch {
          this.inputFailure = this.terminationFailure(
            "OUTCOME_UNKNOWN",
            "Process input was not acknowledged; input will not be retried",
            "possible",
          );
          throw this.inputFailure;
        } finally {
          clearTimeout(timer);
        }
      })
      .finally(() => {
        this.pendingInputCalls--;
        this.pendingInputBytes -= bytes.byteLength;
      });

    this.inputTail = work.catch(() => undefined);

    const observation = AbortSignal.any([this.local.signal, ...(caller ? [caller] : [])]);

    return raceAbort(work, observation).catch((error) => {
      if (!observation.aborted) throw error;

      if (!dispatched)
        throw this.terminationFailure("WAIT_ABORTED", "Input cancelled before dispatch");
      this.inputFailure ??= this.terminationFailure(
        "OUTCOME_UNKNOWN",
        "Process input was not acknowledged; input will not be retried",
        "possible",
      );
      throw this.inputFailure;
    });
  }
  async status(options: { signal?: AbortSignal } = {}): Promise<ProcessStatus> {
    if (options.signal?.aborted) throw aborted();
    this.rememberNativeExit();

    if (this.exitCode !== undefined)
      return {
        state: "exited",
        exit: { exitCode: this.exitCode, outputComplete: this.complete },
        observedAt: new Date().toISOString(),
      };

    if (this.signal.aborted) throw this.terminationFailure("CLIENT_CLOSED", "Client is closed");

    if (this.detached || !this.controlActive())
      throw this.terminationFailure("UNAVAILABLE", "Process observation is detached");

    if (!this.native?.status) return { state: "unknown", observedAt: new Date().toISOString() };
    const controller = new AbortController();

    const signal = AbortSignal.any([
      controller.signal,
      this.signal,
      this.local.signal,
      ...(options.signal ? [options.signal] : []),
    ]);

    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const value = await raceAbort(
        this.native.status({ signal, deadline: Date.now() + 30_000 }),
        signal,
      );

      const parsed = z
        .object({
          state: z.enum(["running", "exited", "unknown"]),
          exit: Exit.optional(),
          observedAt: z.iso.datetime(),
        })
        .safeParse(value);

      if (
        !parsed.success ||
        (parsed.data.state === "exited" && !parsed.data.exit) ||
        (parsed.data.state !== "exited" && parsed.data.exit)
      )
        throw this.terminationFailure("INVALID_RESPONSE", "Invalid process status");

      if (parsed.data.exit) {
        this.evidence(parsed.data.exit);
        this.notify();
      }

      this.rememberNativeExit();

      if (this.exitCode !== undefined)
        return {
          state: "exited",
          exit: { exitCode: this.exitCode, outputComplete: this.complete },
          observedAt: parsed.data.observedAt,
        };

      return { state: parsed.data.state, observedAt: parsed.data.observedAt };
    } catch (error) {
      if (options.signal?.aborted) throw aborted();

      if (error instanceof SandbarError) throw error;
      throw this.terminationFailure("UNAVAILABLE", "Process status observation failed");
    } finally {
      clearTimeout(timer);
    }
  }
  private terminationFailure(code: string, message: string, effect: "none" | "possible" = "none") {
    return Object.assign(new SandbarError(code, message, effect), {
      provider: this.provider,
      sandboxId: this.sandboxId,
    });
  }
  async terminate(options: { signal?: AbortSignal } = {}): Promise<ProcessTermination> {
    if (options.signal?.aborted)
      throw this.terminationFailure("WAIT_ABORTED", "Termination wait aborted before dispatch");
    this.rememberNativeExit();

    if (this.exitCode !== undefined) return { status: "exited" };

    if (!this.termination) {
      if (this.signal.aborted) throw this.terminationFailure("CLIENT_CLOSED", "Client is closed");

      if (this.detached || (this.stopped && !this.sustained) || !this.controlActive())
        throw this.terminationFailure(
          "UNAVAILABLE",
          "Process termination authority is no longer active",
        );
      const native = this.native;

      if (!native?.terminate)
        throw this.terminationFailure("UNSUPPORTED", "Process termination is unsupported");
      // Dispatch once; caller signals only cancel their own waits on this promise.
      this.termination = this.requestTermination(native);
      void this.termination.catch(() => undefined);
    }

    try {
      const result = await (options.signal
        ? raceAbort(this.termination, options.signal)
        : this.termination);

      return { status: result.status };
    } catch (error) {
      if (options.signal?.aborted)
        throw this.terminationFailure(
          "OUTCOME_UNKNOWN",
          "Termination wait stopped; the shared request may still complete",
          "possible",
        );
      throw error;
    }
  }
  private async requestTermination(native: NativeProcess): Promise<ProcessTermination> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.signal, this.local.signal]);
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const result = await raceAbort(
        native.terminate!({ signal, deadline: Date.now() + 30_000 }),
        signal,
      );

      const parsed = Termination.safeParse(result);

      if (!parsed.success) throw new Error("Invalid termination acknowledgement");

      return parsed.data;
    } catch {
      throw this.terminationFailure(
        "OUTCOME_UNKNOWN",
        "Termination was not acknowledged; the request will not be repeated",
        "possible",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async detach(): Promise<void> {
    this.signal.removeEventListener("abort", this.closed);
    this.queue = [];
    this.queuedBytes = 0;
    this.removeOutputAbort?.();

    if (!this.sustained) this.signal.removeEventListener("abort", this.closed);

    if (this.detached) return;
    this.detached = true;
    this.local.abort();
    this.rememberNativeExit();
    this.stopped = true;

    if (this.native) release(this.native);
    this.notify();
  }
}

export async function startProcess(
  client: AdapterDirectClient,
  sandbox: Sandbox,
  input: StartProcessInput,
  options: { signal?: AbortSignal },
  controlActive: () => boolean,
  capture?: { maxBytes: number },
): Promise<TextProcess> {
  if (options.signal?.aborted)
    throw new SandbarError("WAIT_ABORTED", "Process start aborted before dispatch");

  if (!client.session.processes)
    throw new SandbarError("UNSUPPORTED", "Text streaming is unsupported");

  if (input?.deadlineSeconds !== undefined)
    throw new SandbarError("UNSUPPORTED", "Process runtime deadlines are unsupported");

  const extra = z
    .object({
      stdin: z.enum(["closed", "pipe"]).optional(),
      output: z.strictObject({ mode: z.literal("stream") }).optional(),
    })
    .safeParse(input);

  if (!extra.success) throw new SandbarError("INVALID_ARGUMENT", "Invalid process IO options");
  const sustained = extra.data.output?.mode === "stream";
  const piped = extra.data.stdin === "pipe";

  if (sustained && input.maxOutputBytes !== undefined)
    throw new SandbarError("INVALID_ARGUMENT", "Stream output cannot specify maxOutputBytes");

  if (sustained && !client.session.processes.supports?.sustainedOutput)
    throw new SandbarError("UNSUPPORTED", "Sustained process output is unsupported");

  if (piped && client.session.processes.supports?.stdin !== "bytes")
    throw new SandbarError("UNSUPPORTED", "Incremental process stdin is unsupported");
  const request = validateExec({ ...input, stdin: undefined }, { allowStdin: false });

  if (request.maxOutputBytes < 1)
    throw new SandbarError("INVALID_ARGUMENT", "Process output limit must be positive");

  if (request.cwd !== undefined) validateFilePath(request.cwd);
  const strings = request.command.kind === "argv" ? request.command.argv : [request.command.script];

  if (
    strings.some((part) => part.includes("\0")) ||
    Object.values(request.env ?? {}).some((part) => part.includes("\0"))
  )
    throw new SandbarError("INVALID_ARGUMENT", "Process input contains NUL");
  const controller = new AbortController();

  const setup = AbortSignal.any([
    controller.signal,
    client.signal,
    ...(options.signal ? [options.signal] : []),
  ]);

  const timer = setTimeout(() => controller.abort(), 30_000);

  const process = new TextProcess(
    client.provider,
    sandbox.id,
    request.maxOutputBytes,
    client.signal,
    controlActive,
    sustained,
    piped,
  );

  let established = false;
  let dispatched = false;

  const started = Promise.resolve().then(() => {
    if (setup.aborted)
      throw new SandbarError("WAIT_ABORTED", "Process start aborted before dispatch");
    dispatched = true;

    return client.session.processes!.start(
      {
        sandbox,
        capture,
        stdin: extra.data.stdin,
        output: extra.data.output,
        command: request.command,
        cwd: request.cwd,
        env: request.env,
        maxOutputBytes: request.maxOutputBytes,
      },
      {
        signal: setup,
        deadline: Date.now() + 30_000,
        onOutput: (chunk) => {
          try {
            process.onOutput(chunk);
          } catch (error) {
            if (!established) controller.abort();
            throw error;
          }
        },
      },
    );
  });

  // Late handles are always disposed; the start dispatch is never repeated.
  const work = started.then((native) => {
    established = true;
    process.attach(native);

    if (process.error) throw process.error;

    return process;
  });

  try {
    return await raceAbort(work, setup);
  } catch (error) {
    const failure =
      process.error ??
      (!dispatched
        ? new SandbarError("WAIT_ABORTED", "Process start aborted before dispatch")
        : error instanceof AdapterError && !setup.aborted
          ? new SandbarError(error.code, error.message, "possible")
          : new SandbarError(
              "OUTCOME_UNKNOWN",
              "Process start was not acknowledged; do not resubmit",
              "possible",
            ));

    process.fail(failure);
    await process.detach();
    throw Object.assign(failure, { provider: client.provider, sandboxId: sandbox.id });
  } finally {
    clearTimeout(timer);
  }
}

export type ExecOptions = {
  signal?: AbortSignal;
  /** Awaited live text delivery; captured stdout/stderr remain bounded by maxOutputBytes. */
  onOutput?: (chunk: ProcessOutput) => void | Promise<void>;
};

/** Exactly one process dispatch; callback failure cannot fall back to finite exec. */
export async function callbackExec(
  client: AdapterDirectClient,
  sandbox: Sandbox,
  controlActive: () => boolean,
  input: ExecInput | readonly string[],
  options: ExecOptions,
): Promise<ExecOutput> {
  const callback = options.onOutput;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate JavaScript callers before any command dispatch.
  if (typeof callback !== "function")
    throw new SandbarError("INVALID_ARGUMENT", "Expected execution output callback");

  if (!Array.isArray(input) && "deadlineSeconds" in input && input.deadlineSeconds !== undefined)
    throw new SandbarError("UNSUPPORTED", "Streaming execution runtime deadlines are unsupported");
  const request = validateExec(input);

  if (client.session.processes?.supports?.execCapture !== "bytes")
    throw new SandbarError("UNSUPPORTED", "Streaming execution byte capture is unsupported");

  const process = await startProcess(
    client,
    sandbox,
    {
      command: request.command,
      cwd: request.cwd,
      env: request.env,
      output: { mode: "stream" },
      stdin: request.stdin === undefined ? "closed" : "pipe",
    },
    options,
    controlActive,
    { maxBytes: request.maxOutputBytes },
  );

  const observation = new AbortController();

  const signal = AbortSignal.any([
    observation.signal,
    client.signal,
    ...(options.signal ? [options.signal] : []),
  ]);

  let exit: ProcessExit | undefined;
  let captured: ExecOutput | undefined;

  const waiting = process.wait({ signal }).then((value) => {
    exit = value;

    return value;
  });

  void waiting.catch(() => undefined);

  const capture = Promise.resolve(process.native?.capture).then((value) => {
    if (
      !value ||
      !(value.stdout instanceof Uint8Array) ||
      !(value.stderr instanceof Uint8Array) ||
      value.stdout.length + value.stderr.length > request.maxOutputBytes ||
      !z.number().int().safe().safeParse(value.exitCode).success ||
      !z.boolean().safeParse(value.truncated).success
    )
      throw new SandbarError("INVALID_RESPONSE", "Invalid execution byte capture", "possible");
    captured = execOutput(
      value.exitCode,
      new Uint8Array(value.stdout),
      new Uint8Array(value.stderr),
      value.truncated,
    );

    return captured;
  });

  void capture.catch(() => undefined);

  const output = (async () => {
    for await (const chunk of process.output({ signal }))
      await raceAbort(
        Promise.resolve().then(() => callback(chunk)),
        signal,
      );
  })();

  void output.catch(() => undefined);

  try {
    if (request.stdin !== undefined) {
      for (let offset = 0; offset < request.stdin.length; offset += 65_536)
        await process.write(request.stdin.subarray(offset, offset + 65_536), { signal });
      await process.closeStdin({ signal });
    }

    await Promise.all([output, waiting, raceAbort(capture, signal)]);

    if (captured!.exitCode !== exit!.exitCode)
      throw new SandbarError(
        "INVALID_RESPONSE",
        "Execution capture conflicts with confirmed exit",
        "possible",
      );

    return checkExec(captured!);
  } catch (error) {
    observation.abort();

    if (
      exit &&
      error instanceof SandbarError &&
      (error.code === "NONZERO_EXIT" || error.code === "NO_EXIT_CODE")
    )
      throw error;

    const failure = new SandbarError(
      error instanceof SandbarError
        ? error.code
        : options.signal?.aborted
          ? "WAIT_ABORTED"
          : "UNAVAILABLE",
      "Execution observation failed",
      error instanceof SandbarError ? error.effect : "possible",
    );

    const context: ProcessFailure & { output?: ExecOutput } = Object.assign(failure, {
      provider: process.provider,
      sandboxId: sandbox.id,
    });

    if (exit) context.confirmedExit = exit;

    if (captured) context.output = captured;
    throw context;
  } finally {
    await process.detach();
  }
}
