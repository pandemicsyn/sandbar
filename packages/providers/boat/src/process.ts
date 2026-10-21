import type { BoatApi, FetchAPI } from "@boatdev/sdk";
import {
  AdapterError,
  type NativeProcess,
  type NativeProcessExit,
  type ProcessStartContext,
  type ProcessStartInput,
  type ReadContext,
} from "@sandbar-sdk/adapter";
import { z } from "zod";
import { commandLine } from "./exec";
import { BOAT_API } from "./transport";

/** Largest single NDJSON line accepted from the attach stream. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Boat heartbeats every 15 s; this much silence is a dead connection. */
const IDLE_MS = 60_000;

/** How long a dropped attach connection is retried after a good one. */
const RECONNECT_MS = 60_000;

const Offset = z.number().int().nonnegative().safe();

const Frame = z.object({
  type: z.enum(["attached", "stdout", "stderr", "heartbeat", "exit", "reconnect", "error"]),
  data: z.string().optional(),
  nextOffset: Offset.optional(),
  stdoutOffset: Offset.optional(),
  stderrOffset: Offset.optional(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().max(32).nullable().optional(),
});

const signals = new Map([
  ["SIGHUP", 1],
  ["SIGINT", 2],
  ["SIGQUIT", 3],
  ["SIGABRT", 6],
  ["SIGKILL", 9],
  ["SIGSEGV", 11],
  ["SIGPIPE", 13],
  ["SIGALRM", 14],
  ["SIGTERM", 15],
]);

type ProcessNative = Pick<BoatApi, "command" | "stopCommand">;

export type BoatProcessOptions = {
  native: ProcessNative;
  apiKey: string;
  fetch: FetchAPI;
  init(ctx: ReadContext): RequestInit;
};

/** Read NDJSON lines from a response body, each bounded before decoding. */
async function* lines(body: ReadableStream<Uint8Array>, touch: () => void): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let done = false;

  try {
    while (!done) {
      const chunk = await reader.read();
      touch();
      done = chunk.done;
      buffered += done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let newline = buffered.indexOf("\n");

      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);

        if (line) yield line;
        newline = buffered.indexOf("\n");
      }

      if (buffered.length > MAX_FRAME_BYTES)
        throw new AdapterError("CAPACITY", "Boat command stream line exceeds the adapter bound");
    }

    if (buffered.trim()) yield buffered.trim();
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * A Boat command started detached, with no 600-second cap, and observed through
 * `GET /commands/{processId}/stream`. That stream carries UTF-8 text with per-stream
 * byte offsets and ends every 10 minutes with a `reconnect` line; reattaching from
 * the offsets loses and repeats nothing. Only reads are repeated, never the start.
 */
export async function startBoatProcess(
  options: BoatProcessOptions,
  input: ProcessStartInput,
  ctx: ProcessStartContext,
): Promise<NativeProcess> {
  if (input.output?.format === "bytes")
    throw new AdapterError("UNSUPPORTED", "Boat streams command output as UTF-8 text only");

  if (input.terminal)
    throw new AdapterError("UNSUPPORTED", "Boat processes do not allocate a terminal");

  if (input.stdin === "pipe")
    throw new AdapterError("UNSUPPORTED", "Boat processes take no incremental stdin");

  // Validates argv, env names and NUL bytes before any effect.
  const command = `(${commandLine(input)}) </dev/null`;
  const sandboxId = input.sandbox.id;
  let started;

  try {
    started = await options.native.command(
      { sandboxId, commandRequest: { command, detached: true } },
      options.init(ctx),
    );
  } catch {
    throw new AdapterError("UNAVAILABLE", "Boat did not acknowledge the command start");
  }

  if (!("processId" in started) || !Offset.safeParse(started.processId).success)
    throw new AdapterError("UNAVAILABLE", "Boat did not return a process id for the command");
  const processId = started.processId;
  const local = new AbortController();
  const offsets = { stdout: 0, stderr: 0 };
  let observing = true;
  let outputFailure: AdapterError | undefined;
  let confirmedExit: NativeProcessExit | undefined;
  // Set at the first failure after a good connection; a good connection clears it.
  let failingSince: number | undefined;

  const deliver = (stream: "stdout" | "stderr", text: string) => {
    if (!observing || !text) return;

    try {
      ctx.onOutput({ stream, text });
    } catch (error) {
      observing = false;
      outputFailure =
        error instanceof AdapterError
          ? error
          : new AdapterError("UNAVAILABLE", "Process output observation failed");
    }
  };

  const connect = async (touch: () => void, signal: AbortSignal) => {
    const url = new URL(
      `${BOAT_API}/sandboxes/${encodeURIComponent(sandboxId)}/commands/${processId}/stream`,
    );

    url.searchParams.set("stdoutOffset", String(offsets.stdout));
    url.searchParams.set("stderrOffset", String(offsets.stderr));

    const response = await options.fetch(url.toString(), {
      headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/x-ndjson" },
      redirect: "error",
      signal,
    });

    touch();

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);

      // A server or gateway failure is a dropped connection; anything else is final.
      if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
      throw new AdapterError(
        response.status === 404 ? "NOT_FOUND" : "UNAVAILABLE",
        `Boat command stream returned HTTP ${response.status}`,
      );
    }

    failingSince = undefined;

    return response.body;
  };

  /** One attach connection; returns the exit, or undefined when Boat asks to reconnect. */
  const attach = async (): Promise<NativeProcessExit | undefined> => {
    const connection = new AbortController();
    const abort = () => connection.abort();
    local.signal.addEventListener("abort", abort, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;

    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(abort, IDLE_MS);
    };

    try {
      touch();

      for await (const line of lines(await connect(touch, connection.signal), touch)) {
        const frame = Frame.parse(JSON.parse(line));

        if (frame.type === "stdout" || frame.type === "stderr") {
          deliver(frame.type, frame.data ?? "");

          if (frame.nextOffset !== undefined) offsets[frame.type] = frame.nextOffset;
        } else if (frame.type === "exit") {
          if (frame.exitCode !== null && frame.exitCode !== undefined)
            return { exitCode: frame.exitCode };
          const number = signals.get(frame.signal ?? "");

          if (number === undefined)
            throw new AdapterError("UNAVAILABLE", "Boat reported no exit status for the command");

          return { exitCode: 128 + number };
        } else if (frame.type === "error")
          throw new AdapterError("UNAVAILABLE", "Boat command stream reported an error");
        else {
          offsets.stdout = frame.stdoutOffset ?? offsets.stdout;
          offsets.stderr = frame.stderrOffset ?? offsets.stderr;

          if (frame.type === "reconnect") return undefined;
        }
      }

      // A cut connection can end the body early; reattach from the offsets.
      throw new Error("Boat command stream ended without an exit");
    } finally {
      clearTimeout(idle);
      local.signal.removeEventListener("abort", abort);
    }
  };

  const finished = (async () => {
    for (;;) {
      if (local.signal.aborted) throw new AdapterError("UNAVAILABLE", "Process locally detached");

      try {
        const exit = await attach();

        if (exit) {
          confirmedExit = exit;

          return exit;
        }
      } catch (error) {
        failingSince ??= Date.now();

        // Adapter errors and malformed frames are final; network failures reattach.
        if (
          local.signal.aborted ||
          error instanceof AdapterError ||
          error instanceof z.ZodError ||
          error instanceof SyntaxError ||
          Date.now() - failingSince >= RECONNECT_MS
        )
          throw error instanceof AdapterError
            ? error
            : new AdapterError("UNAVAILABLE", "Boat command stream failed");

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  })();

  void finished.catch(() => undefined);

  const outputDone = finished.then(() => {
    if (outputFailure) throw outputFailure;
  });

  void outputDone.catch(() => undefined);

  return {
    get confirmedExit() {
      return confirmedExit;
    },
    outputDone,
    wait: () => finished,
    async terminate(operation) {
      if (confirmedExit) return { status: "not-found" as const };
      let stopped;

      try {
        stopped = await options.native.stopCommand(
          { sandboxId, processId },
          options.init(operation),
        );
      } catch {
        throw new AdapterError("UNAVAILABLE", "Boat did not acknowledge the stop request");
      }

      return { status: stopped.signaled ? ("requested" as const) : ("not-found" as const) };
    },
    async detachOutput() {
      observing = false;
    },
    async detach() {
      // Stops local reads only; the detached Boat command keeps running.
      observing = false;
      local.abort();
    },
  };
}
