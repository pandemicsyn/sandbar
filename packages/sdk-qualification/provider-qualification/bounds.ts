import { SandbarError } from "sandbar-sdk";

/** Bound read-only SDK waits that do not expose a caller signal. */
export async function boundedRead<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let abort = () => {};

  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new SandbarError("WAIT_ABORTED", "Qualification wait interrupted"));
    signal.addEventListener("abort", abort, { once: true });

    if (signal.aborted) abort();
  });

  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
