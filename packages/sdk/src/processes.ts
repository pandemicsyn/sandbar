import {
  AdapterError,
  type NativeProcess,
  type Sandbox,
  type ProcessOutput,
} from "sandbar-adapter";
import { z } from "zod";
import {
  SandbarError,
  validateExec,
  validateFilePath,
  raceAbort,
  type ExecInput,
} from "./resource";
import type { AdapterDirectClient } from "./adapter-direct";
import { noteOperation } from "./observability";

export type { ProcessOutput } from "sandbar-adapter";

export type StartProcessInput = Pick<
  ExecInput,
  "command" | "cwd" | "env" | "maxOutputBytes" | "deadlineSeconds"
>;

export type ProcessExit = { exitCode: number; outputComplete: boolean };

/** Local context only; these fields cannot reopen a command. */
export type ProcessFailure = SandbarError & {
  provider: string;
  sandboxId: string;
  confirmedExit?: ProcessExit;
};

export interface ProcessHandle {
  readonly provider: string;
  output(options?: { signal?: AbortSignal }): AsyncIterable<ProcessOutput>;
  wait(options?: { signal?: AbortSignal }): Promise<ProcessExit>;
  detach(): Promise<void>;
}

const Exit = z.object({ exitCode: z.number().int().safe() });

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
    if (this.stopped) return;
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

    if (!this.queue.length) this.removeOutputAbort?.();

    if (this.native) release(this.native);
    this.notify();
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

      if (this.total + bytes > this.max || this.queuedBytes + bytes > 65_536) {
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

    this.total += bytes;
    this.queuedBytes += bytes;
    this.queue.push(...parts);
    this.notify();
  };
  attach(native: NativeProcess): void {
    this.native = native;
    // Observe immediately, even when setup was abandoned and a handle arrived late.
    void Promise.resolve()
      .then(() => native.wait())
      .then(
        (value) => {
          this.evidence(value);

          if (this.exitCode === undefined)
            this.fail(new SandbarError("INVALID_RESPONSE", "Invalid process exit", "possible"));
          else {
            this.finished = true;
            this.notify();
          }
        },
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Adapter wait errors are untrusted; confirmedExit is schema-validated below.
        (error: unknown) => {
          const evidence = z.object({ confirmedExit: Exit.optional() }).safeParse(error);

          if (evidence.success) this.evidence(evidence.data.confirmedExit);
          this.rememberNativeExit();
          this.fail(new SandbarError("UNAVAILABLE", "Process observation failed", "possible"));
          this.notify();
        },
      )
      .catch(() => {
        this.fail(new SandbarError("UNAVAILABLE", "Process observation failed", "possible"));
      });

    if (this.stopped) release(native);
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
      this.signal.removeEventListener("abort", this.closed);
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
          this.signal.removeEventListener("abort", this.closed);
          throw this.failure;
        }

        if (this.stopped || this.finished) {
          if (this.finished && !this.stopped) this.complete = true;
          signal?.removeEventListener("abort", stop);
          this.signal.removeEventListener("abort", this.closed);

          return { done: true, value: undefined };
        }

        await this.changed();
      }
    };

    const iterator: AsyncIterableIterator<ProcessOutput> = {
      next,
      return: async () => {
        signal?.removeEventListener("abort", stop);
        await this.detach();

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

      if (this.failure) throw this.failure;

      if (this.stopped)
        throw new SandbarError(
          "UNAVAILABLE",
          "Process detached without confirmed exit",
          "possible",
        );
      await this.changed(options.signal);
    }
  }
  async detach(): Promise<void> {
    this.queue = [];
    this.queuedBytes = 0;
    this.removeOutputAbort?.();
    this.signal.removeEventListener("abort", this.closed);

    if (this.stopped) return;
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
): Promise<ProcessHandle> {
  if (options.signal?.aborted)
    throw new SandbarError("WAIT_ABORTED", "Process start aborted before dispatch");

  if (!client.session.processes)
    throw new SandbarError("UNSUPPORTED", "Text streaming is unsupported");

  if (input?.deadlineSeconds !== undefined)
    throw new SandbarError("UNSUPPORTED", "Process runtime deadlines are unsupported");
  const request = validateExec(input);

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
