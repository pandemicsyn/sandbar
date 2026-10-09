import {
  AdapterError,
  type NativeProcess,
  type ExecValue,
  type NativeProcessExit,
  type ProcessStartContext,
  type ReadContext,
  type Json,
} from "sandbar-adapter";
import type { Sandbox } from "e2b";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { setImmediate as yieldOutput } from "node:timers/promises";

/** Connect JSON envelopes are bounded before allocating their payload. No native CommandHandle transcript. */
export const PROCESS_FRAME_BYTES = 1_048_576;

const DRAIN_MS = 1_000;

const TerminalSize = z.strictObject({
  columns: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

export const ProcessReference = z.strictObject({
  version: z.literal(1),
  tag: z
    .string()
    .regex(/^sandbar-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  sandbox: z.string().min(1).max(128),
  binding: z.string().regex(/^[0-9a-f]{64}$/),
  profile: z.enum(["process", "terminal"]),
  expiresAt: z.number().int().positive().safe(),
});

export type E2BProcessReference = z.infer<typeof ProcessReference>;

export type E2BProcessOptions = {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "closed" | "pipe";
  format?: "text" | "bytes";
  capture?: { maxBytes: number };
  terminal?: { columns: number; rows: number };
  binding?: string;
  reopen?: E2BProcessReference;
};

const Frame = z.object({
  event: z
    .object({
      start: z.object({ pid: z.number().int().positive() }).optional(),
      data: z
        .object({
          stdout: z.string().optional(),
          stderr: z.string().optional(),
          pty: z.string().optional(),
        })
        .optional(),
      end: z.object({ exitCode: z.number().int().default(0) }).optional(),
      keepalive: z.object({}).optional(),
    })
    .optional(),
});

function validBase64(value: string): boolean {
  if (value.length % 4) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;

  for (let i = 0; i < value.length - padding; i++) {
    const code = value.charCodeAt(i);

    if (
      !(code >= 65 && code <= 90) &&
      !(code >= 97 && code <= 122) &&
      !(code >= 48 && code <= 57) &&
      code !== 43 &&
      code !== 47
    )
      return false;
  }

  return true;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  void promise.catch(() => undefined);

  return { promise, resolve, reject };
}

export async function startProcess(
  sandbox: Sandbox,
  credentials: { id: string; token: string; version: string },
  script: string,
  options: E2BProcessOptions,
  ctx: ProcessStartContext,
  fetcher: typeof fetch,
): Promise<NativeProcess> {
  if (options.terminal && !TerminalSize.safeParse(options.terminal).success)
    throw new AdapterError("INVALID_ARGUMENT", "E2B terminal dimensions are invalid");

  if (
    options.capture &&
    (!Number.isSafeInteger(options.capture.maxBytes) ||
      options.capture.maxBytes < 1 ||
      options.capture.maxBytes > 1_048_576)
  )
    throw new AdapterError("CAPACITY", "E2B process capture exceeds its byte bound");

  if (options.format === "bytes" && !ctx.onOutputBytes)
    throw new AdapterError("UNSUPPORTED", "E2B binary output requires a byte consumer hook");
  // CloseStdin was added in envd 0.5.2. Reject pipe mode before the Start RPC.
  const parts = credentials.version.split(".").map(Number);

  if (
    options.stdin === "pipe" &&
    !options.terminal &&
    (!/^\d+\.\d+\.\d+$/.test(credentials.version) ||
      (parts[0] === 0 && (parts[1]! < 5 || (parts[1] === 5 && parts[2]! < 2))))
  )
    throw new AdapterError("UNSUPPORTED", "E2B incremental stdin requires envd 0.5.2 or later");

  const reference =
    options.reopen ??
    (options.binding
      ? {
          version: 1 as const,
          tag: `sandbar-${randomUUID()}`,
          sandbox: credentials.id,
          binding: options.binding,
          profile: options.terminal ? ("terminal" as const) : ("process" as const),
          expiresAt: Date.now() + 86_400_000,
        }
      : undefined);

  const controller = new AbortController();
  const started = deferred<number>();
  const exited = deferred<NativeProcessExit>();
  const output = deferred<void>();
  const capture = options.capture ? deferred<ExecValue>() : undefined;
  const captureLimit = options.capture?.maxBytes ?? 0;
  const captured = { stdout: new Uint8Array(captureLimit), stderr: new Uint8Array(captureLimit) };
  const capturedSize = { stdout: 0, stderr: 0 };
  let capturedBytes = 0;
  let truncated = false;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  let confirmedExit: NativeProcessExit | undefined;
  let pid: number | undefined;
  let outputDetached = false;
  let detached = false;
  let observationFailed = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const fail = () => new AdapterError("UNAVAILABLE", "E2B process observation failed");
  const abort = () => controller.abort();
  ctx.signal.addEventListener("abort", abort, { once: true });

  if (ctx.signal.aborted) abort();
  const setupTimer = setTimeout(abort, Math.max(1, ctx.deadline - Date.now()));

  const deliver = (stream: "stdout" | "stderr", text: string) => {
    if (!text || outputDetached || detached) return;

    try {
      ctx.onOutput({ stream, text });
    } catch (error) {
      outputDetached = true;
      output.reject(error instanceof Error ? error : fail());
    }
  };

  const deliverBytes = (stream: "stdout" | "stderr", bytes: Uint8Array) => {
    if (!bytes.length || outputDetached || detached) return;

    try {
      ctx.onOutputBytes!({ stream, bytes: new Uint8Array(bytes) });
    } catch (error) {
      outputDetached = true;
      output.reject(error instanceof Error ? error : fail());
    }
  };

  async function consume() {
    const bytes = new TextEncoder().encode(
      JSON.stringify(
        options.reopen
          ? { process: { tag: options.reopen.tag } }
          : {
              tag: reference?.tag,
              pty: options.terminal
                ? { size: { cols: options.terminal.columns, rows: options.terminal.rows } }
                : undefined,
              process: {
                cmd: "/bin/bash",
                args: ["-l", "-c", script],
                cwd: options.cwd,
                envs: options.terminal
                  ? { TERM: "xterm-256color", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...options.env }
                  : options.env,
              },
              stdin: options.terminal ? undefined : options.stdin === "pipe",
            },
      ),
    );

    const request = new Uint8Array(bytes.length + 5);
    new DataView(request.buffer).setUint32(1, bytes.length);
    request.set(bytes, 5);

    const headers = new Headers({
      "Content-Type": "application/connect+json",
      "Connect-Protocol-Version": "1",
      "X-Access-Token": credentials.token,
      "E2b-Sandbox-Id": credentials.id,
      "E2b-Sandbox-Port": "49983",
      "Keepalive-Ping-Interval": "50",
    });

    if (parts[0] === 0 && parts[1]! < 4) headers.set("Authorization", `Basic ${btoa("user:")}`);

    const response = await fetcher(
      `https://sandbox.e2b.app/process.Process/${options.reopen ? "Connect" : "Start"}`,
      {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers,
        body: request,
      },
    );

    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw fail();
    }

    reader = response.body.getReader();
    const header = new Uint8Array(5);
    let headerUsed = 0;
    let payload: Uint8Array | undefined;
    let payloadUsed = 0;
    let ended = false;

    readLoop: for (;;) {
      const part = await reader.read();

      if (part.done) break;
      let offset = 0;

      while (offset < part.value.length) {
        if (ended) throw fail();

        if (!payload) {
          const n = Math.min(5 - headerUsed, part.value.length - offset);
          header.set(part.value.subarray(offset, offset + n), headerUsed);
          headerUsed += n;
          offset += n;

          if (headerUsed < 5) continue;
          const size = new DataView(header.buffer).getUint32(1);

          if (size > PROCESS_FRAME_BYTES || (header[0] !== 0 && header[0] !== 2)) throw fail();
          payload = new Uint8Array(size);
          payloadUsed = 0;
        }

        const n = Math.min(payload.length - payloadUsed, part.value.length - offset);
        payload.set(part.value.subarray(offset, offset + n), payloadUsed);
        offset += n;
        payloadUsed += n;

        if (payloadUsed < payload.length) continue;

        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(payload),
        );

        if (header[0] === 2) {
          const trailer = z.object({ error: z.object({}).optional() }).parse(value);

          if (trailer.error || !confirmedExit) throw fail();
          ended = true;
        } else {
          const event = Frame.parse(value).event;

          if (event?.start) {
            if (pid !== undefined) throw fail();
            pid = event.start.pid;
            started.resolve(pid);
          }

          if (event?.end) {
            if (pid === undefined || confirmedExit) throw fail();
            confirmedExit = { exitCode: event.end.exitCode };
            exited.resolve(confirmedExit);
            drainTimer = setTimeout(() => controller.abort(), DRAIN_MS);
          }

          for (const stream of ["stdout", "stderr"] as const) {
            const encoded = options.terminal
              ? stream === "stdout"
                ? event?.data?.pty
                : undefined
              : event?.data?.[stream];

            if (encoded !== undefined) {
              if (pid === undefined || !validBase64(encoded)) throw fail();
              const data = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));

              if (capture) {
                const take = Math.min(data.length, captureLimit - capturedBytes);
                captured[stream].set(data.subarray(0, take), capturedSize[stream]);
                capturedSize[stream] += take;
                capturedBytes += take;

                if (take < data.length) truncated = true;
              }

              // A fetch read may contain many envelopes, and an envelope may exceed
              // the SDK queue. Yield after each bounded delivery so a ready consumer
              // can drain without accumulating callback promises or another queue.
              for (let index = 0; index < data.length; index += 16_384) {
                const segment = data.subarray(index, index + 16_384);

                if (options.format === "bytes") deliverBytes(stream, segment);
                else deliver(stream, decoders[stream].decode(segment, { stream: true }));
                await yieldOutput();

                if (controller.signal.aborted) throw fail();
              }
            }
          }
        }

        payload = undefined;
        headerUsed = 0;

        if (ended) {
          if (offset !== part.value.length) throw fail();
          break readLoop;
        }
      }
    }

    if (!ended || headerUsed || payload) throw fail();

    if (options.format !== "bytes")
      for (const stream of ["stdout", "stderr"] as const)
        deliver(stream, decoders[stream].decode());
    capture?.resolve({
      exitCode: confirmedExit!.exitCode,
      stdout: captured.stdout.slice(0, capturedSize.stdout),
      stderr: captured.stderr.slice(0, capturedSize.stderr),
      truncated,
    });
    output.resolve();
  }

  void consume()
    .catch(() => {
      observationFailed = true;
      const error = fail();
      started.reject(error);

      if (!confirmedExit) exited.reject(error);
      output.reject(error);
      capture?.reject(error);
    })
    .finally(() => {
      if (drainTimer) clearTimeout(drainTimer);

      if (reader) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    });

  try {
    pid = await started.promise;
  } catch {
    throw new Error("E2B process start was not acknowledged");
  } finally {
    clearTimeout(setupTimer);
    ctx.signal.removeEventListener("abort", abort);
  }

  function requestOptions(context: ReadContext) {
    return { signal: context.signal, requestTimeoutMs: Math.max(1, context.deadline - Date.now()) };
  }

  const selector = (): Json => (reference ? { tag: reference.tag } : { pid: pid! });

  async function unary(method: string, body: Json, context: ReadContext) {
    if (observationFailed || detached || controller.signal.aborted || context.signal.aborted)
      throw fail();

    const headers = new Headers({
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "X-Access-Token": credentials.token,
      "E2b-Sandbox-Id": credentials.id,
      "E2b-Sandbox-Port": "49983",
    });

    if (parts[0] === 0 && parts[1]! < 4) headers.set("Authorization", `Basic ${btoa("user:")}`);

    const response = await fetcher(`https://sandbox.e2b.app/process.Process/${method}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([
        context.signal,
        AbortSignal.timeout(Math.max(1, context.deadline - Date.now())),
      ]),
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);

      if (response.status === 404) return false;
      throw fail();
    }

    if (!response.body) throw fail();
    const acknowledgement = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
      for (;;) {
        const chunk = await acknowledgement.read();

        if (chunk.done) break;
        size += chunk.value.length;

        if (size > 16_384) throw fail();
        chunks.push(chunk.value);
      }

      z.strictObject({}).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } finally {
      void acknowledgement.cancel().catch(() => undefined);
      acknowledgement.releaseLock();
    }

    return true;
  }

  async function sendSignal(signal: "SIGTERM" | "SIGKILL", context: ReadContext) {
    const accepted = await unary(
      "SendSignal",
      { process: selector(), signal: `SIGNAL_${signal}` },
      context,
    );

    return { status: accepted ? ("requested" as const) : ("not-found" as const) };
  }

  async function disconnect() {
    if (detached) return;
    detached = true;
    controller.abort();

    if (reader) void reader.cancel().catch(() => undefined);

    if (!confirmedExit) exited.reject(fail());
    output.reject(fail());
    capture?.reject(fail());
  }

  return {
    reference,
    signal: sendSignal,
    disconnect,
    async resize(dimensions, context) {
      if (!TerminalSize.safeParse(dimensions).success)
        throw new AdapterError("INVALID_ARGUMENT", "E2B terminal dimensions are invalid");

      if (!options.terminal) throw new AdapterError("UNSUPPORTED", "Only E2B terminals resize");

      if (
        !(await unary(
          "Update",
          {
            process: selector(),
            pty: { size: { cols: dimensions.columns, rows: dimensions.rows } },
          },
          context,
        ))
      )
        throw new AdapterError("NOT_FOUND", "E2B terminal is absent");
    },
    get confirmedExit() {
      return confirmedExit;
    },
    outputDone: output.promise,
    capture: capture?.promise,
    wait: () => exited.promise,
    async status(context) {
      if (confirmedExit)
        return { state: "exited", exit: confirmedExit, observedAt: new Date().toISOString() };
      // Tag/PID presence is observation only; absence cannot supply an exit code.
      const processes = await sandbox.commands.list(requestOptions(context));

      return {
        state: processes.some((process) =>
          reference ? process.tag === reference.tag : process.pid === pid,
        )
          ? "running"
          : "unknown",
        observedAt: new Date().toISOString(),
      };
    },
    async write(bytes, context) {
      if (
        !(await unary(
          "SendInput",
          {
            process: selector(),
            input: { [options.terminal ? "pty" : "stdin"]: Buffer.from(bytes).toString("base64") },
          },
          context,
        ))
      )
        throw new AdapterError("NOT_FOUND", "E2B process is absent");
    },
    async closeStdin(context) {
      if (options.terminal)
        throw new AdapterError("UNSUPPORTED", "E2B terminals do not have pipe EOF");

      if (!(await unary("CloseStdin", { process: selector() }, context)))
        throw new AdapterError("NOT_FOUND", "E2B process is absent");
    },
    terminate: (context) => sendSignal("SIGKILL", context),
    async detachOutput() {
      outputDetached = true;
      output.reject(fail());
    },
    detach: disconnect,
  };
}
