import { AdapterError, type ReadContext } from "sandbar-adapter";
import { SandbarError, raceAbort, type ReadOptions } from "./resource";

function disposeReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best effort, including readers from external adapters.
  } finally {
    reader.releaseLock();
  }
}

function disposeStream(value: Uint8Array | ReadableStream<Uint8Array>): void {
  if (!(value instanceof Uint8Array)) disposeReader(value.getReader());
}

/** One local deadline covers both adapter dispatch and every streamed chunk. */
export async function readFileBytes(
  read: (context: ReadContext) => Promise<Uint8Array | ReadableStream<Uint8Array>>,
  maxBytes: number,
  closed: AbortSignal,
  options: ReadOptions,
): Promise<Uint8Array> {
  const controller = new AbortController();

  const cancel = () =>
    controller.abort(new SandbarError("WAIT_ABORTED", "File read cancelled", "none"));

  const close = () =>
    controller.abort(new SandbarError("CLIENT_CLOSED", "Client is closed", "none"));

  const deadline = Date.now() + 30_000;

  const timer = setTimeout(
    () => controller.abort(new SandbarError("TIMEOUT", "File read timed out", "none")),
    30_000,
  );

  options.signal?.addEventListener("abort", cancel, { once: true });
  closed.addEventListener("abort", close, { once: true });

  if (closed.aborted) close();
  else if (options.signal?.aborted) cancel();
  const signal = controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    signal.throwIfAborted();

    const pending = read({ signal, deadline }).then((value) => {
      if (signal.aborted) {
        disposeStream(value);
        signal.throwIfAborted();
      }

      return value;
    });

    const value = await raceAbort(pending, signal);

    if (signal.aborted) {
      disposeStream(value);
      signal.throwIfAborted();
    }

    if (value instanceof Uint8Array) {
      if (value.length > maxBytes)
        throw new SandbarError("OUTPUT_CAPACITY", "File exceeds adapter limit", "unknown");

      return Uint8Array.from(value);
    }

    reader = value.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
      const part = await raceAbort(reader.read(), signal);
      signal.throwIfAborted();

      if (part.done) break;

      if (!(part.value instanceof Uint8Array) || total + part.value.length > maxBytes)
        throw new SandbarError("OUTPUT_CAPACITY", "File exceeds adapter limit", "unknown");
      chunks.push(Uint8Array.from(part.value));
      total += part.value.length;
    }

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    return bytes;
  } catch (error) {
    if (signal.aborted) throw signal.reason;

    if (error instanceof AdapterError) throw new SandbarError(error.code, error.message, "none");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    closed.removeEventListener("abort", close);

    if (reader) disposeReader(reader);
  }
}
