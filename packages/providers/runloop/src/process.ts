import {
  AdapterError,
  type NativeProcess,
  type NativeProcessExit,
  type ProcessStartContext,
  type ProcessStartInput,
} from "@sandbar-sdk/adapter";
import { z } from "zod";
import { commandLine } from "./exec";
import { HttpError, type Execution, type RunloopClient } from "./transport";

/** Largest single server-sent event line accepted, before decoding. */
export const MAX_EVENT_BYTES = 1024 * 1024;

/** How long a dropped log stream is retried after a good connection. */
const RECONNECT_MS = 60_000;

/** How long output may keep arriving after the confirmed exit before it is called incomplete. */
const DRAIN_MS = 10_000;

const Update = z.object({
  offset: z.number().int().nonnegative().safe().nullish(),
  output: z.string(),
});

const encoder = new TextEncoder();

export type RunloopProcessOptions = {
  native: Pick<RunloopClient, "execute" | "waitForCommand" | "killExecution" | "streamUpdates">;
  /** A fresh idempotency key for one execute request. */
  commandId(): string;
  /** A signal bounded to `seconds` from now, also following `parent`. */
  bounded(parent: AbortSignal, seconds: number): AbortSignal;
};

/** Yield the `data:` payload of each server-sent event, with every line bounded. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let data: string[] = [];
  let done = false;

  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      buffered += done ? `${decoder.decode()}\n\n` : decoder.decode(chunk.value, { stream: true });
      let newline = buffered.indexOf("\n");

      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);

        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));

        newline = buffered.indexOf("\n");
      }

      if (buffered.length > MAX_EVENT_BYTES)
        throw new AdapterError("CAPACITY", "Runloop log event exceeds the adapter bound");
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * One Runloop execution per process, started with `execute` and a fresh command ID. Output
 * comes from the `stream_stdout_updates` and `stream_stderr_updates` server-sent event
 * endpoints as UTF-8 text with byte offsets; a stream that closes before exit is reopened
 * from its offset. Exit comes from `wait_for_status` long polls. Only reads are repeated.
 */
export async function startRunloopProcess(
  options: RunloopProcessOptions,
  input: ProcessStartInput,
  ctx: ProcessStartContext,
): Promise<NativeProcess> {
  if (input.output?.format === "bytes")
    throw new AdapterError("UNSUPPORTED", "Runloop streams command output as UTF-8 text only");

  if (input.terminal)
    throw new AdapterError("UNSUPPORTED", "Runloop processes do not allocate a terminal");

  if (input.stdin === "pipe")
    throw new AdapterError("UNSUPPORTED", "Runloop processes take no incremental stdin");

  // Validates argv, env names and NUL bytes before any effect.
  const command = `(${commandLine(input)}) </dev/null`;
  const { native } = options;
  const devbox = input.sandbox.id;
  let started: Execution;

  try {
    started = await native.execute(
      devbox,
      { command, command_id: options.commandId(), optimistic_timeout: 1 },
      options.bounded(ctx.signal, 60),
    );
  } catch {
    throw new AdapterError("UNAVAILABLE", "Runloop did not acknowledge the command start");
  }

  const execution = started.execution_id;
  const local = new AbortController();
  let observing = true;
  let outputFailure: AdapterError | undefined;
  let confirmedExit: NativeProcessExit | undefined;

  const settle = (value: Execution) => {
    if (value.execution_id !== execution)
      throw new AdapterError("UNAVAILABLE", "Runloop returned a different execution");

    if (value.status !== "completed") return undefined;

    if (value.exit_status === null || value.exit_status === undefined)
      throw new AdapterError("UNAVAILABLE", "Runloop reported no exit status for the command");
    confirmedExit = { exitCode: value.exit_status };

    return confirmedExit;
  };

  const finished = (async () => {
    let exit = settle(started);

    while (!exit) {
      if (local.signal.aborted) throw new AdapterError("UNAVAILABLE", "Process locally detached");

      try {
        exit = settle(
          await native.waitForCommand(devbox, execution, 25, options.bounded(local.signal, 60)),
        );
      } catch (error) {
        // 408 ends one long-poll window while the command keeps running.
        if (!(error instanceof HttpError && error.status === 408))
          throw error instanceof AdapterError
            ? error
            : new AdapterError("UNAVAILABLE", "Runloop command status could not be read");
      }
    }

    return exit;
  })();

  void finished.catch(() => undefined);

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

  const follow = async (stream: "stdout" | "stderr") => {
    let offset = 0;
    let failingSince: number | undefined;

    for (;;) {
      if (local.signal.aborted) throw new AdapterError("UNAVAILABLE", "Process locally detached");
      const exitedBefore = confirmedExit !== undefined;

      try {
        const response = await native.streamUpdates(
          devbox,
          execution,
          stream,
          offset,
          local.signal,
        );

        failingSince = undefined;

        if (!response.body) throw new AdapterError("UNAVAILABLE", "Runloop log stream is empty");

        for await (const payload of events(response.body)) {
          const update = Update.parse(JSON.parse(payload));
          // A replayed prefix from before the requested offset is skipped.
          const start = update.offset ?? offset;
          const bytes = encoder.encode(update.output);
          const skip = Math.max(0, offset - start);

          if (skip < bytes.length) deliver(stream, new TextDecoder().decode(bytes.subarray(skip)));
          offset = Math.max(offset, start + bytes.length);
        }

        // A stream that ended after the confirmed exit has delivered everything.
        if (exitedBefore) return;
      } catch (error) {
        failingSince ??= Date.now();

        if (
          local.signal.aborted ||
          error instanceof AdapterError ||
          error instanceof z.ZodError ||
          error instanceof SyntaxError ||
          (error instanceof HttpError && error.status < 500) ||
          Date.now() - failingSince >= RECONNECT_MS
        )
          throw error instanceof AdapterError
            ? error
            : new AdapterError("UNAVAILABLE", "Runloop log stream failed");
      }

      if (!confirmedExit) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };

  const streams = Promise.all([follow("stdout"), follow("stderr")]);

  void streams.catch(() => undefined);

  const outputDone = (async () => {
    await finished;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), DRAIN_MS);
    });

    try {
      if ((await Promise.race([streams, late])) === "late") {
        local.abort();
        throw new AdapterError("UNAVAILABLE", "Runloop log streams did not close after exit");
      }
    } finally {
      clearTimeout(timer);
    }

    if (outputFailure) throw outputFailure;
  })();

  void outputDone.catch(() => undefined);

  return {
    get confirmedExit() {
      return confirmedExit;
    },
    outputDone,
    wait: () => finished,
    async terminate(operation) {
      if (confirmedExit) return { status: "not-found" as const };

      try {
        await native.killExecution(devbox, execution, options.bounded(operation.signal, 30));
      } catch (error) {
        if (error instanceof HttpError && error.status === 404)
          return { status: "not-found" as const };
        throw new AdapterError("UNAVAILABLE", "Runloop did not acknowledge the kill request");
      }

      return { status: "requested" as const };
    },
    async detachOutput() {
      observing = false;
    },
    async detach() {
      // Stops local reads only; the Runloop execution keeps running.
      observing = false;
      local.abort();
    },
  };
}
