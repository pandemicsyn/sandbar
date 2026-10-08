import {
  AdapterError,
  AdapterFilesystemError,
  type ReadContext,
  type FileTransferContext,
} from "sandbar-adapter";
import { SandbarError, raceAbort } from "./resource";

export type TransferPolicy = {
  setupTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  overallTimeoutMs?: number;
};

export type FileReadOptions = { signal?: AbortSignal; maxBytes?: number };

export type FileStreamOptions = FileReadOptions & TransferPolicy;

export type FileWriteOptions = FileReadOptions & { overwrite?: boolean };

export type FileStreamWriteOptions = FileStreamOptions & { overwrite?: boolean };

export class FilesystemError extends SandbarError {
  constructor(
    code: string,
    message: string,
    readonly details: AdapterFilesystemError["details"],
  ) {
    super(code, message, details.effect);
    this.name = "FilesystemError";
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Adapter and producer failures can throw arbitrary values; preserve Error instances and retain other failures as the cause.
export function filesystemError(error: unknown): Error {
  if (error instanceof AdapterFilesystemError)
    return new FilesystemError(error.code, error.message, error.details);

  if (error instanceof AdapterError) return new SandbarError(error.code, error.message);

  return error instanceof Error
    ? error
    : new Error("Filesystem operation failed", { cause: error });
}

export function byteLimit(value: number | undefined, defaultValue?: number): number | undefined {
  const limit = value ?? defaultValue;

  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    throw new SandbarError("INVALID_ARGUMENT", "Invalid file byte limit");

  return limit;
}

export function bufferedLimit(value: number | undefined, adapterLimit: number): number {
  const limit = byteLimit(value, 1_048_576)!;

  if (limit > 16_777_216)
    throw new SandbarError("INVALID_ARGUMENT", "Buffered file limit exceeds 16 MiB; use streams");

  return Math.min(limit, byteLimit(adapterLimit)!);
}

class Transfer {
  readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private overall?: ReturnType<typeof setTimeout>;
  private readonly cancel = () =>
    this.controller.abort(new SandbarError("WAIT_ABORTED", "File transfer cancelled"));
  private readonly close = () =>
    this.controller.abort(new SandbarError("CLIENT_CLOSED", "Client is closed"));
  readonly setup: number;
  readonly inactivity: number;
  constructor(
    private closed: AbortSignal,
    private options: FileStreamOptions,
    defaults: TransferPolicy,
  ) {
    this.setup = options.setupTimeoutMs ?? defaults.setupTimeoutMs ?? 30_000;
    this.inactivity = options.inactivityTimeoutMs ?? defaults.inactivityTimeoutMs ?? 60_000;
    const overall = options.overallTimeoutMs ?? defaults.overallTimeoutMs;

    for (const value of [this.setup, this.inactivity, overall]) {
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
      )
        throw new SandbarError("INVALID_ARGUMENT", "Invalid transfer timeout");
    }

    options.signal?.addEventListener("abort", this.cancel, { once: true });
    closed.addEventListener("abort", this.close, { once: true });

    if (closed.aborted) this.close();
    else if (options.signal?.aborted) this.cancel();

    if (overall !== undefined) this.overall = setTimeout(() => this.timeout(), overall);
  }
  private timeout() {
    this.controller.abort(new SandbarError("TIMEOUT", "File transfer timed out"));
  }
  arm(ms: number) {
    this.pause();
    this.timer = setTimeout(() => this.timeout(), ms);
  }
  pause() {
    clearTimeout(this.timer);
  }
  context(): ReadContext {
    return { signal: this.controller.signal, deadline: Date.now() + this.setup };
  }
  async wait<T>(pending: Promise<T>): Promise<T> {
    return raceAbort(pending, this.controller.signal);
  }
  dispose() {
    this.pause();
    clearTimeout(this.overall);
    this.options.signal?.removeEventListener("abort", this.cancel);
    this.closed.removeEventListener("abort", this.close);
  }
}

export async function* streamFile(
  read: (ctx: ReadContext) => Promise<ReadableStream<Uint8Array>>,
  closed: AbortSignal,
  options: FileStreamOptions,
  defaults: TransferPolicy,
): AsyncIterable<Uint8Array> {
  const limit = byteLimit(options.maxBytes);
  const transfer = new Transfer(closed, options, defaults);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    transfer.controller.signal.throwIfAborted();
    transfer.arm(transfer.setup);

    const pending = read(transfer.context()).then((stream) => {
      if (transfer.controller.signal.aborted) {
        void stream.cancel().catch(() => undefined);
        transfer.controller.signal.throwIfAborted();
      }

      return stream;
    });

    reader = (await transfer.wait(pending)).getReader();
    const ownedReader = reader;
    transfer.controller.signal.addEventListener(
      "abort",
      () => {
        void ownedReader.cancel().catch(() => undefined);
      },
      { once: true },
    );
    let total = 0;

    for (;;) {
      transfer.arm(transfer.inactivity);
      const part = await transfer.wait(reader.read());
      transfer.pause();

      if (part.done) return;

      if (!(part.value instanceof Uint8Array))
        throw new SandbarError("INVALID_RESPONSE", "Invalid file stream chunk");
      total += part.value.byteLength;

      if (limit !== undefined && total > limit)
        throw new SandbarError("OUTPUT_CAPACITY", "File exceeds byte limit");

      for (let offset = 0; offset < part.value.length; offset += 65_536) {
        transfer.controller.signal.throwIfAborted();
        yield part.value.slice(offset, offset + 65_536);
      }
    }
  } catch (error) {
    throw filesystemError(error);
  } finally {
    transfer.controller.abort();
    transfer.dispose();

    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

export async function writeStream(
  write: (
    bytes: AsyncIterable<Uint8Array>,
    ctx: FileTransferContext,
  ) => Promise<{ bytesWritten: number }>,
  source: AsyncIterable<Uint8Array>,
  closed: AbortSignal,
  options: FileStreamOptions,
  defaults: TransferPolicy,
  retain?: FileTransferContext["retain"],
): Promise<number> {
  const limit = byteLimit(options.maxBytes);
  const transfer = new Transfer(closed, options, defaults);
  const iterator = source[Symbol.asyncIterator]();
  let total = 0;
  let complete = false;

  const bytes = (async function* () {
    for (;;) {
      transfer.arm(transfer.inactivity);
      const part = await transfer.wait(Promise.resolve(iterator.next()));

      if (part.done) {
        complete = true;

        return;
      }

      if (!(part.value instanceof Uint8Array))
        throw new SandbarError("INVALID_ARGUMENT", "Expected byte stream chunks");

      if (limit !== undefined && total + part.value.length > limit)
        throw new SandbarError("OUTPUT_CAPACITY", "File exceeds byte limit");

      for (let offset = 0; offset < part.value.length; offset += 65_536) {
        transfer.controller.signal.throwIfAborted();
        const chunk = part.value.slice(offset, offset + 65_536);
        total += chunk.length;
        transfer.arm(transfer.inactivity);
        yield chunk;
      }
    }
  })();

  try {
    transfer.controller.signal.throwIfAborted();
    transfer.arm(transfer.setup);
    const result = await transfer.wait(write(bytes, { ...transfer.context(), retain }));

    if (!complete || result.bytesWritten !== total)
      throw new SandbarError(
        "INVALID_RESPONSE",
        "File transfer completion was not confirmed",
        "unknown",
      );

    return total;
  } catch (error) {
    throw filesystemError(error);
  } finally {
    transfer.controller.abort();
    transfer.dispose();

    try {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    } catch {
      /* Producer cleanup is best effort. */
    }
  }
}
