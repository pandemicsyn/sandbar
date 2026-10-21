import {
  AdapterError,
  type ExecValue,
  type NativeProcess,
  type NativeProcessExit,
  type ProcessStartContext,
  type ProcessStartInput,
} from "@sandbar-sdk/adapter";
import type { BoxdNativeClient, CallContext } from "./transport";

/**
 * One native `Exec` call per process. boxd sends output frames as the command writes them and
 * kills the command's process group when the call is cancelled, so the call is the process:
 * terminate cancels it, and detach keeps it open, unobserved, until the command exits.
 */
export function startBoxdProcess(
  native: BoxdNativeClient,
  input: ProcessStartInput,
  ctx: ProcessStartContext,
): NativeProcess {
  const binaryOutput = input.output?.format === "bytes";
  const onOutputBytes = ctx.onOutputBytes;

  if (binaryOutput && !onOutputBytes)
    throw new AdapterError("INVALID_ARGUMENT", "Byte process output requires a byte consumer");

  if (input.terminal)
    throw new AdapterError("UNSUPPORTED", "boxd processes do not allocate a terminal");

  if (input.stdin === "pipe")
    throw new AdapterError("UNSUPPORTED", "boxd processes take no incremental stdin");

  if (ctx.signal.aborted) throw new AdapterError("UNAVAILABLE", "Process setup stopped");

  const local = new AbortController();

  const decoders = {
    stdout: new TextDecoder("utf-8", { fatal: true }),
    stderr: new TextDecoder("utf-8", { fatal: true }),
  };

  let observing = true;
  let outputFailure: AdapterError | undefined;

  const call: CallContext = {
    signal: local.signal,
    // Bounds token exchange only; the streaming call itself has no deadline.
    deadline: ctx.deadline,
    cancelOnAbort: true,
    // Only the bounded capture is collected; streamed output is never buffered.
    maxBytes: input.capture?.maxBytes ?? 0,
    truncated: false,
    output: { stdout: [], stderr: [] },
    onOutput(stream, bytes) {
      if (!observing) return;

      try {
        if (binaryOutput) onOutputBytes!({ stream, bytes: Uint8Array.from(bytes) });
        else {
          const text = decoders[stream].decode(bytes, { stream: true });

          if (text) ctx.onOutput({ stream, text });
        }
      } catch (error) {
        observing = false;
        outputFailure =
          error instanceof AdapterError
            ? error
            : new AdapterError("UNAVAILABLE", "Process output observation failed");
      }
    },
  };

  let confirmedExit: NativeProcessExit | undefined;

  const finished = native
    .run(call, () =>
      native.machines.exec(input.sandbox.id, {
        command:
          input.command.kind === "argv"
            ? input.command.argv
            : ["/bin/sh", "-c", input.command.script],
        cwd: input.cwd,
        env: input.env,
        encoding: "buffer",
      }),
    )
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      if (call.confirmedExit === undefined)
        throw new AdapterError("UNAVAILABLE", "boxd command exit was not confirmed");
      confirmedExit = { exitCode: call.confirmedExit };

      return confirmedExit;
    });

  void finished.catch(() => undefined);

  const outputDone = finished.then(() => {
    if (outputFailure) throw outputFailure;

    if (!binaryOutput && observing)
      for (const stream of ["stdout", "stderr"] as const) {
        const text = decoders[stream].decode();

        if (text) ctx.onOutput({ stream, text });
      }
  });

  void outputDone.catch(() => undefined);

  const capture: Promise<ExecValue> | undefined = input.capture
    ? finished.then((exit) => ({
        exitCode: exit.exitCode,
        stdout: Uint8Array.from(Buffer.concat(call.output!.stdout)),
        stderr: Uint8Array.from(Buffer.concat(call.output!.stderr)),
        truncated: call.truncated === true,
      }))
    : undefined;

  void capture?.catch(() => undefined);

  return {
    get confirmedExit() {
      return confirmedExit;
    },
    outputDone,
    capture,
    wait: () => finished,
    async terminate() {
      if (confirmedExit) return { status: "not-found" as const };
      local.abort();

      return { status: "requested" as const };
    },
    async detachOutput() {
      observing = false;
    },
    async detach() {
      // Cancelling the call would kill the command, so only local observation stops.
      observing = false;
    },
  };
}
