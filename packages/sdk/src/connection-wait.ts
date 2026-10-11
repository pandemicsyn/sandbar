import { SandbarError } from "./resource";

/** Local connection setup controls; this signal does not own a returned client. */
export type ConnectionWaitOptions = { signal?: AbortSignal; timeoutMs?: number };

export type CloseOptions = ConnectionWaitOptions;

export function connectionBudget(options: ConnectionWaitOptions, phase: "connect" | "close") {
  const timeoutMs =
    options.timeoutMs === undefined ? (phase === "connect" ? 30_000 : 5_000) : options.timeoutMs;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new SandbarError(
      "INVALID_ARGUMENT",
      `${phase} timeoutMs must be a positive finite safe integer`,
    );

  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new SandbarError("INVALID_ARGUMENT", `${phase} signal must be an AbortSignal`);
  const controller = new AbortController();

  const failure = (code: "WAIT_ABORTED" | "TIMEOUT", cause: unknown) => {
    const error = new SandbarError(
      code,
      `${phase} local wait ${code === "TIMEOUT" ? "timed out" : "aborted"}`,
    );

    error.cause = cause;

    if (code === "WAIT_ABORTED") error.name = "AbortError";
    controller.abort(error);
  };

  const abort = () => failure("WAIT_ABORTED", options.signal?.reason);

  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  // Node timers overflow above 2^31-1; honor longer finite budgets in chunks.
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    const remaining = timeoutMs - (performance.now() - started);

    if (remaining <= 0)
      failure("TIMEOUT", new DOMException(`${phase} wait deadline exceeded`, "TimeoutError"));
    else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
  };

  if (!controller.signal.aborted) schedule();

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    },
  };
}
