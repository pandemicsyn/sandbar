import {
  AdapterError,
  type NativeProcess,
  type ExecValue,
  type NativeProcessExit,
  type ProcessStartContext,
  type ReadContext,
} from "sandbar-adapter";
import type { Sandbox } from "e2b";
import { z } from "zod";
import { setImmediate as yieldOutput } from "node:timers/promises";

/** Connect JSON envelopes are bounded before allocating their payload. No native CommandHandle transcript. */
export const PROCESS_FRAME_BYTES = 1_048_576;

const DRAIN_MS = 1_000;

const Frame = z.object({
  event: z
    .object({
      start: z.object({ pid: z.number().int().positive() }).optional(),
      data: z.object({ stdout: z.string().optional(), stderr: z.string().optional() }).optional(),
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
  options: {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: "closed" | "pipe";
    capture?: { maxBytes: number };
  },
  ctx: ProcessStartContext,
  fetcher: typeof fetch,
): Promise<NativeProcess> {
  if (
    options.capture &&
    (!Number.isSafeInteger(options.capture.maxBytes) ||
      options.capture.maxBytes < 1 ||
      options.capture.maxBytes > 1_048_576)
  )
    throw new AdapterError("CAPACITY", "E2B process capture exceeds its byte bound");
  // CloseStdin was added in envd 0.5.2. Reject pipe mode before the Start RPC.
  const parts = credentials.version.split(".").map(Number);

  if (
    options.stdin === "pipe" &&
    (!/^\d+\.\d+\.\d+$/.test(credentials.version) ||
      (parts[0] === 0 && (parts[1]! < 5 || (parts[1] === 5 && parts[2]! < 2))))
  )
    throw new AdapterError("UNSUPPORTED", "E2B incremental stdin requires envd 0.5.2 or later");
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

  async function consume() {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        process: {
          cmd: "/bin/bash",
          args: ["-l", "-c", script],
          cwd: options.cwd,
          envs: options.env,
        },
        stdin: options.stdin === "pipe",
      }),
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

    const response = await fetcher("https://sandbox.e2b.app/process.Process/Start", {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers,
      body: request,
    });

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
            const encoded = event?.data?.[stream];

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
                deliver(
                  stream,
                  decoders[stream].decode(data.subarray(index, index + 16_384), { stream: true }),
                );
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

    for (const stream of ["stdout", "stderr"] as const) deliver(stream, decoders[stream].decode());
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
  } finally {
    clearTimeout(setupTimer);
    ctx.signal.removeEventListener("abort", abort);
  }

  function requestOptions(context: ReadContext) {
    return { signal: context.signal, requestTimeoutMs: Math.max(1, context.deadline - Date.now()) };
  }

  return {
    get confirmedExit() {
      return confirmedExit;
    },
    outputDone: output.promise,
    capture: capture?.promise,
    wait: () => exited.promise,
    async status(context) {
      if (confirmedExit)
        return { state: "exited", exit: confirmedExit, observedAt: new Date().toISOString() };
      // List proves only current PID presence; absence cannot supply an exit code.
      const processes = await sandbox.commands.list(requestOptions(context));

      return {
        state: processes.some((process) => process.pid === pid) ? "running" : "unknown",
        observedAt: new Date().toISOString(),
      };
    },
    async write(bytes, context) {
      await sandbox.commands.sendStdin(pid!, bytes, requestOptions(context));
    },
    async closeStdin(context) {
      await sandbox.commands.closeStdin(pid!, requestOptions(context));
    },
    async terminate(context) {
      if (observationFailed || detached) throw fail();
      const killed = await sandbox.commands.kill(pid!, requestOptions(context));

      return { status: killed ? "requested" : "not-found" };
    },
    async detachOutput() {
      outputDetached = true;
      output.reject(fail());
    },
    async detach() {
      if (detached) return;
      detached = true;
      controller.abort();

      if (reader) void reader.cancel().catch(() => undefined);

      if (!confirmedExit) exited.reject(fail());
      output.reject(fail());
      capture?.reject(fail());
    },
  };
}
