import {
  AdapterError,
  type ExecValue,
  type NativeProcess,
  type NativeProcessExit,
  type ProcessSignal,
  type ProcessStartContext,
  type ProcessStartInput,
  type ReadContext,
} from "@sandbar-sdk/adapter";
import type { ModalTransport } from "./transport";

// The wrapper records the command's PID, then execs it in place, so the PID is the command's own.
const LAUNCH = 'echo $$ >"$0" && exec "$@"';

// Exit 3: no PID recorded yet; exit 4: no such process.
const KILL = 'p=$(cat "$0" 2>/dev/null) || exit 3; kill -s "$1" "$p" 2>/dev/null || exit 4';

/**
 * One command-router exec per process. Modal streams stdout and stderr as separate byte reads
 * and reports exit through `TaskExecWait`. The router has no kill call, so the command is
 * launched through a small `/bin/sh` wrapper that records its PID in `/tmp`, and signals are
 * sent with `kill` in a second exec.
 */
export async function startModalProcess(
  transport: ModalTransport,
  input: ProcessStartInput,
  ctx: ProcessStartContext,
): Promise<NativeProcess> {
  const binaryOutput = input.output?.format === "bytes";
  const onOutputBytes = ctx.onOutputBytes;

  if (binaryOutput && !onOutputBytes)
    throw new AdapterError("INVALID_ARGUMENT", "Byte process output requires a byte consumer");

  if (input.terminal)
    throw new AdapterError("UNSUPPORTED", "Modal processes do not allocate a terminal");

  const stdinWrite = transport.stdinWrite?.bind(transport);

  if (input.stdin === "pipe" && !stdinWrite)
    throw new AdapterError("UNSUPPORTED", "Modal incremental stdin is unavailable");

  const sandboxId = input.sandbox.id;
  const execId = crypto.randomUUID();
  const pidFile = `/tmp/.sandbar-process-${execId}.pid`;

  const command =
    input.command.kind === "argv" ? input.command.argv : ["/bin/sh", "-c", input.command.script];

  ctx.signal.throwIfAborted();

  try {
    await transport.start(
      {
        sandboxId,
        execId,
        command: ["/bin/sh", "-c", LAUNCH, pidFile, ...command],
        cwd: input.cwd,
        env: input.env,
      },
      ctx.signal,
    );
  } catch {
    throw new AdapterError("UNAVAILABLE", "Modal process start was not acknowledged");
  }

  let stdinOffset = 0;

  if (input.stdin !== "pipe")
    try {
      await transport.stdin(sandboxId, execId, new Uint8Array(), ctx.signal);
    } catch {
      throw new AdapterError("UNAVAILABLE", "Modal process stdin EOF was not acknowledged");
    }

  const local = new AbortController();

  const decoders = {
    stdout: new TextDecoder("utf-8", { fatal: true }),
    stderr: new TextDecoder("utf-8", { fatal: true }),
  };

  let observing = true;
  let outputFailure: AdapterError | undefined;
  let confirmedExit: NativeProcessExit | undefined;

  const forward = (stream: "stdout" | "stderr", bytes: Uint8Array) => {
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
  };

  const result = transport
    .result(sandboxId, execId, input.capture?.maxBytes ?? 0, local.signal, forward)
    .catch(() => {
      throw new AdapterError("UNAVAILABLE", "Modal process exit was not observed");
    });

  const finished = result.then((value) => {
    confirmedExit = { exitCode: value.exitCode };

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
    ? result.then((value) => ({ ...value }))
    : undefined;

  void capture?.catch(() => undefined);

  const send = async (signal: ProcessSignal, operation: ReadContext) => {
    if (confirmedExit) return { status: "not-found" as const };
    const killId = crypto.randomUUID();

    try {
      await transport.start(
        {
          sandboxId,
          execId: killId,
          command: ["/bin/sh", "-c", KILL, pidFile, signal.slice(3)],
          timeoutSeconds: 30,
        },
        operation.signal,
      );
      await transport.stdin(sandboxId, killId, new Uint8Array(), operation.signal);
    } catch {
      throw new AdapterError("UNAVAILABLE", "Modal signal request was not acknowledged");
    }

    const { exitCode } = await transport
      .result(sandboxId, killId, 0, operation.signal)
      .catch(() => {
        throw new AdapterError("UNAVAILABLE", "Modal signal result was not observed");
      });

    if (exitCode === 0) return { status: "requested" as const };

    if (exitCode === 4) return { status: "not-found" as const };

    throw new AdapterError("UNAVAILABLE", "Modal process ID was not recorded");
  };

  return {
    get confirmedExit() {
      return confirmedExit;
    },
    outputDone,
    capture,
    wait: () => finished,
    async write(bytes, operation) {
      const offset = stdinOffset;
      stdinOffset += bytes.length;
      await stdinWrite!(sandboxId, execId, offset, bytes, operation.signal);
    },
    async closeStdin(operation) {
      await stdinWrite!(sandboxId, execId, stdinOffset, "eof", operation.signal);
    },
    signal: send,
    terminate: (operation) => send("SIGKILL", operation),
    async detachOutput() {
      observing = false;
    },
    async detach() {
      // Stops local reads only; the Modal command keeps running.
      observing = false;
      local.abort();
    },
  };
}
