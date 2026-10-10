import { z } from "zod";
import {
  AdapterError,
  type NativeProcess,
  type NativeProcessExit,
  type NativeProcessStatus,
  type ExecValue,
  type ProcessStartContext,
  type ProcessStartInput,
  type ReadContext,
  type Json,
  type ProcessReopenInput,
} from "sandbar-adapter";
import {
  processRpc,
  processSupervisor,
  pythonCommand,
  type ProcessRequest,
} from "./process-helper";

export type ProcessExecute = (command: string, ctx: ReadContext) => Promise<string>;

type CapturedStreams = { stdout: Uint8Array[]; stderr: Uint8Array[] };

const Dimensions = z.object({
  columns: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

const Reply = z.object({
  ok: z.boolean().optional(),
  status: z.enum(["requested", "not-found"]).optional(),
  exitCode: z.number().int().nullable().optional(),
  error: z.string().nullable().optional(),
  done: z.boolean().optional(),
  frames: z
    .array(z.object({ stream: z.enum(["stdout", "stderr"]), data: z.string().max(21848) }))
    .max(4)
    .optional(),
});

function context(signal: AbortSignal): ReadContext {
  return { signal, deadline: Date.now() + 30_000 };
}

/** Adapter-owned Unix socket transport; each native HTTP response is bounded independently. */
export async function startDaytonaProcess(
  execute: ProcessExecute,
  input: ProcessStartInput,
  ctx: ProcessStartContext,
  reopening?: Json,
): Promise<NativeProcess> {
  const binaryOutput = input.output?.format === "bytes";
  const onOutputBytes = ctx.onOutputBytes;

  if (binaryOutput && !onOutputBytes)
    throw new AdapterError("INVALID_ARGUMENT", "Byte process output requires a byte consumer");

  if (input.terminal && !binaryOutput)
    throw new AdapterError("INVALID_ARGUMENT", "Terminal processes require byte output");

  if (input.terminal && !Dimensions.safeParse(input.terminal).success)
    throw new AdapterError(
      "INVALID_ARGUMENT",
      "Terminal dimensions must be integers from 1 to 1000",
    );

  const profile = input.terminal ? "terminal" : "process";

  const parsedReference = z
    .object({
      root: z.string().regex(/^\/tmp\/sandbar-process-[0-9a-f-]{36}$/),
      generation: z.string().uuid(),
      profile: z.enum(["process", "terminal"]),
    })
    .strict()
    .safeParse(reopening);

  if (reopening !== undefined && !parsedReference.success)
    throw new AdapterError("INVALID_ARGUMENT", "Invalid process supervisor reference");

  const reference =
    reopening === undefined
      ? {
          root: `/tmp/sandbar-process-${crypto.randomUUID()}`,
          generation: crypto.randomUUID(),
          profile,
        }
      : parsedReference.data!;

  if (reference.profile !== profile)
    throw new AdapterError("INVALID_ARGUMENT", "Process reference profile does not match");
  const { root, generation } = reference;
  const lease = crypto.randomUUID();

  const argv =
    input.command.kind === "argv" ? input.command.argv : ["/bin/sh", "-c", input.command.script];

  const launch = pythonCommand(processSupervisor, {
    root,
    generation,
    lease,
    terminal: input.terminal,
    argv,
    cwd: input.cwd,
    env: input.env,
    pipe: input.stdin === "pipe",
  });

  ctx.signal.throwIfAborted();

  const rpc = async (request: ProcessRequest, operation: ReadContext, wait = 0) => {
    operation.signal.throwIfAborted();

    const result = Reply.parse(
      JSON.parse(
        await execute(
          pythonCommand(processRpc, { root, request: { ...request, generation, lease }, wait }),
          operation,
        ),
      ),
    );

    if (result.error) throw new AdapterError("UNAVAILABLE", result.error);

    if (request.op === "status" && result.exitCode === undefined)
      throw new AdapterError("UNAVAILABLE", "Process status has no observation");

    return result;
  };

  try {
    if (reopening === undefined) {
      await execute(`(${launch} </dev/null >/dev/null 2>&1 &)`, ctx);
      await rpc({ op: "status" }, ctx, Math.max(0, (ctx.deadline - Date.now()) / 1000));
    } else {
      const reply = await rpc({ op: "hello", nextLease: lease }, ctx);

      if (reply.ok !== true || reply.exitCode === undefined)
        throw new AdapterError("UNAVAILABLE", "Process reattachment was not acknowledged");
    }
  } catch (error) {
    // Lost setup does not authorize a remote kill. Independently dispose a late local transport.
    if (reopening !== undefined) {
      const cleanup = AbortSignal.timeout(5_000);
      void rpc({ op: "disconnect" }, { signal: cleanup, deadline: Date.now() + 5_000 }).catch(
        () => undefined,
      );
      throw error;
    }

    const cleanup = AbortSignal.timeout(5_000);
    void rpc({ op: "abandon" }, { signal: cleanup, deadline: Date.now() + 5_000 }).catch(
      () => undefined,
    );
    throw error;
  }

  const local = new AbortController();
  let confirmedExit: NativeProcessExit | undefined;
  let outputDetached = false;
  let detached = false;
  let outputComplete = false;
  let exitedAt: number | undefined;
  let capturedBytes = 0;
  let truncated = false;
  const captured: CapturedStreams = { stdout: [], stderr: [] };
  let resolveExit!: (exit: NativeProcessExit) => void;
  let rejectExit!: (error: Error) => void;

  const exit = new Promise<NativeProcessExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  void exit.catch(() => undefined);

  const observe = (reply: z.infer<typeof Reply>) => {
    if (reply.exitCode !== null && reply.exitCode !== undefined) {
      confirmedExit ??= { exitCode: reply.exitCode };
      exitedAt ??= Date.now();
      resolveExit(confirmedExit);
    }
  };

  const decoders = {
    stdout: new TextDecoder("utf-8", { fatal: true }),
    stderr: new TextDecoder("utf-8", { fatal: true }),
  };

  const outputDone = (async () => {
    try {
      while (!outputDetached && !detached) {
        if (exitedAt !== undefined && Date.now() - exitedAt > 1_000)
          throw new AdapterError(
            "UNAVAILABLE",
            "Process output did not close after confirmed exit",
          );
        const reply = await rpc({ op: "read" }, context(local.signal));
        observe(reply);

        for (const frame of reply.frames ?? []) {
          if (outputDetached || detached) break;
          const bytes = Buffer.from(frame.data, "base64");

          if (bytes.byteLength > 16_384 || bytes.toString("base64") !== frame.data)
            throw new AdapterError("UNAVAILABLE", "Invalid process output frame");

          if (input.capture) {
            const keep = Math.min(
              bytes.byteLength,
              Math.max(0, input.capture.maxBytes - capturedBytes),
            );

            if (keep) captured[frame.stream].push(Uint8Array.from(bytes.subarray(0, keep)));
            capturedBytes += keep;
            truncated ||= keep < bytes.byteLength;
          }

          if (binaryOutput && onOutputBytes) {
            onOutputBytes({ stream: frame.stream, bytes: Uint8Array.from(bytes) });

            continue;
          }

          const text = decoders[frame.stream].decode(bytes, { stream: true });

          if (text) ctx.onOutput({ stream: frame.stream, text });
        }

        if (reply.done) {
          if (!confirmedExit) {
            await exit;
            // Acknowledge a final read carrying the now-confirmed exit before self-removal.
            observe(await rpc({ op: "read" }, context(local.signal)));
          }

          if (!binaryOutput)
            for (const stream of ["stdout", "stderr"] as const) {
              const text = decoders[stream].decode();

              if (text) ctx.onOutput({ stream, text });
            }

          outputComplete = true;

          return;
        }
      }

      throw new AdapterError("UNAVAILABLE", "Process output detached");
    } catch (error) {
      outputDetached = true;

      if (!detached) void rpc({ op: "discard" }, context(local.signal)).catch(() => undefined);
      throw error instanceof AdapterError
        ? error
        : new AdapterError("UNAVAILABLE", "Process output observation failed");
    }
  })();

  void outputDone.catch(() => undefined);

  const capture: Promise<ExecValue> | undefined = input.capture
    ? Promise.all([exit, outputDone]).then(([result]) => ({
        exitCode: result.exitCode,
        stdout: Uint8Array.from(Buffer.concat(captured.stdout)),
        stderr: Uint8Array.from(Buffer.concat(captured.stderr)),
        truncated,
      }))
    : undefined;

  void capture?.catch(() => undefined);

  // Exit observation has its own endpoint and survives failed/detached output.
  const monitor = (async () => {
    try {
      while (!confirmedExit && !detached) {
        observe(await rpc({ op: "status" }, context(local.signal)));

        if (!confirmedExit)
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              local.signal.removeEventListener("abort", finish);
              resolve();
            };

            const timer = setTimeout(finish, 100);
            local.signal.addEventListener("abort", finish, { once: true });

            if (local.signal.aborted) finish();
          });
      }

      if (!confirmedExit) rejectExit(new AdapterError("UNAVAILABLE", "Process locally detached"));
    } catch {
      // A final read may remove the socket while the independent status request is in flight.
      await Promise.race([
        outputDone.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 200)),
      ]);

      if (!confirmedExit)
        rejectExit(new AdapterError("UNAVAILABLE", "Process exit observation unavailable"));
    }
  })();

  void monitor.catch(() => undefined);

  const acknowledged = async (request: ProcessRequest, operation: ReadContext) => {
    const reply = await rpc(request, operation);

    if (reply.ok !== true)
      throw new AdapterError("UNAVAILABLE", "Invalid process control acknowledgement");
  };

  const signalRequest = async (request: ProcessRequest, operation: ReadContext) => {
    if (confirmedExit) return { status: "not-found" as const };

    const reply = await rpc(request, operation);

    if (reply.ok !== true || reply.status === undefined)
      throw new AdapterError("UNAVAILABLE", "Invalid process signal acknowledgement");

    observe(reply);

    return { status: reply.status };
  };

  return {
    reference,
    get confirmedExit() {
      return confirmedExit;
    },
    outputDone,
    capture,
    wait: () => (confirmedExit ? Promise.resolve(confirmedExit) : exit),
    async write(bytes, operation) {
      await acknowledged({ op: "write", data: Buffer.from(bytes).toString("base64") }, operation);
    },
    async closeStdin(operation) {
      await acknowledged({ op: "close" }, operation);
    },
    async status(operation) {
      if (!confirmedExit) observe(await rpc({ op: "status" }, operation));

      const observation: NativeProcessStatus = {
        state: confirmedExit ? "exited" : "running",
        observedAt: new Date().toISOString(),
      };

      if (confirmedExit) observation.exit = confirmedExit;

      return observation;
    },
    async signal(signal, operation) {
      return signalRequest({ op: "signal", signal }, operation);
    },
    async resize(dimensions, operation) {
      if (!Dimensions.safeParse(dimensions).success)
        throw new AdapterError(
          "INVALID_ARGUMENT",
          "Terminal dimensions must be integers from 1 to 1000",
        );

      await acknowledged({ op: "resize", ...dimensions }, operation);
    },
    async disconnect() {
      if (detached) return;
      detached = true;

      try {
        await acknowledged({ op: "disconnect" }, context(new AbortController().signal));
      } finally {
        local.abort();
      }
    },
    async terminate(operation) {
      return signalRequest({ op: "terminate" }, operation);
    },
    async detachOutput() {
      if (outputDetached || outputComplete || detached) return;
      outputDetached = true;
      await acknowledged({ op: "discard" }, context(local.signal));
    },
    async detach() {
      if (detached) return;
      detached = true;

      if (outputComplete && confirmedExit) {
        local.abort();

        return;
      }

      // Remote local-transport cleanup is best effort; a lost ACK cannot imply process exit.
      try {
        await acknowledged({ op: "detach" }, context(new AbortController().signal));
      } catch {
        // The supervisor may already have removed its socket after a final acknowledged read.
      } finally {
        local.abort();
      }
    },
  };
}

export function reopenDaytonaProcess(
  execute: ProcessExecute,
  input: ProcessReopenInput,
  ctx: ProcessStartContext,
): Promise<NativeProcess> {
  const attachment: ProcessStartInput = {
    ...input,
    command: { kind: "argv", argv: ["true"] },
    maxOutputBytes: 0,
  };

  if (input.profile === "terminal") attachment.terminal = { columns: 80, rows: 24 };

  return startDaytonaProcess(execute, attachment, ctx, input.reference);
}
