import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { Client, Metadata, credentials as grpcCredentials, status } from "@grpc/grpc-js";
import { AccountNamespace, Disks, Machines, Orgs } from "@boxd-sh/sdk";
import { AdapterError, type ReadContext } from "sandbar-adapter";
import { z } from "zod";

export const BOXD_ENDPOINT = "https://boxd.sh:9443";

const TOKEN_ENDPOINT = "https://app.boxd.sh/api/v1/auth/token";

export const MAX_BYTES = 1_048_576;

type Transport = ConstructorParameters<typeof Machines>[0];

type Method<Req, Resp> = {
  name: string;
  requestType: { encode(value: Req): { finish(): Uint8Array } };
  responseType: { decode(value: Uint8Array): Resp };
};

export type CallContext = ReadContext & {
  maxBytes?: number;
  truncated?: boolean;
  confirmedExit?: number;
  uploadBytes?: number;
  onCreate?: (id: string) => Promise<void>;
};

const context = new AsyncLocalStorage<CallContext>();

const Frame = z.object({ data: z.instanceof(Uint8Array) });

const ExitFrame = z.object({
  data: z.instanceof(Uint8Array),
  exitCode: z.number().int(),
  stdin: z.boolean(),
  windowChange: z.boolean(),
});

const Upload = z.object({ bytesWritten: z.number().int().nonnegative().safe() });

const Token = z.strictObject({
  token: z.string().min(1).max(16384),
  expires_at: z.number().positive(),
});

const GrpcError = z.object({ code: z.number() });

// Native error descriptions can contain credentials, command contents or paths.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- gRPC/fetch thrown values are parsed and redacted here.
export function nativeError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  const code = GrpcError.safeParse(error);

  const codes = new Map<number, ConstructorParameters<typeof AdapterError>[0]>([
    [status.INVALID_ARGUMENT, "INVALID_ARGUMENT"],
    [status.NOT_FOUND, "NOT_FOUND"],
    [status.ALREADY_EXISTS, "CONFLICT"],
    [status.FAILED_PRECONDITION, "CONFLICT"],
    [status.PERMISSION_DENIED, "FORBIDDEN"],
    [status.UNAUTHENTICATED, "UNAUTHENTICATED"],
    [status.RESOURCE_EXHAUSTED, "CAPACITY"],
    [status.DEADLINE_EXCEEDED, "TIMEOUT"],
    [status.UNIMPLEMENTED, "UNSUPPORTED"],
  ]);

  return new AdapterError(
    code.success ? (codes.get(code.data.code) ?? "UNAVAILABLE") : "UNAVAILABLE",
    "boxd request failed",
  );
}

export function definitiveRejection(error: unknown): error is AdapterError {
  return (
    error instanceof AdapterError &&
    [
      "INVALID_ARGUMENT",
      "NOT_FOUND",
      "CONFLICT",
      "FORBIDDEN",
      "UNAUTHENTICATED",
      "UNSUPPORTED",
    ].includes(error.code)
  );
}

async function tokenBody(response: Response): Promise<string> {
  if (!response.body) throw new AdapterError("UNAUTHENTICATED", "boxd token response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) break;
      length += next.value.length;

      if (length > 32768)
        throw new AdapterError("UNAUTHENTICATED", "boxd token response exceeds bound");
      chunks.push(next.value);
    }

    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Public namespace constructors supply their own protobuf codecs; no private SDK imports. */
export function createNativeClient(
  apiKey: string,
  options: {
    channel?: Client;
    exchange?: (url: string, options: RequestInit) => Promise<Response>;
  } = {},
) {
  const channel =
    options.channel ??
    new Client("boxd.sh:9443", grpcCredentials.createSsl(), {
      "grpc.enable_retries": 0,
      "grpc.max_receive_message_length": 4 * MAX_BYTES,
      "grpc.max_send_message_length": 4 * MAX_BYTES,
    });

  const exchange = options.exchange ?? fetch;
  let token: z.infer<typeof Token> | undefined;
  let refresh: Promise<void> | undefined;
  let closing = false;
  let executions = 0;

  const localContext = (): CallContext =>
    context.getStore() ?? {
      signal: AbortSignal.timeout(30000),
      deadline: Date.now() + 30000,
    };

  const metadata = async (ctx: CallContext) => {
    ctx.signal.throwIfAborted();

    if (!token || token.expires_at * 1000 <= Date.now() + 30000) {
      refresh ??= (async () => {
        const response = await exchange(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: apiKey }),
          signal: AbortSignal.any([
            ctx.signal,
            AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now())),
          ]),
          redirect: "error",
        });

        if (!response.ok) throw new AdapterError("UNAUTHENTICATED", "boxd token exchange failed");
        token = Token.parse(JSON.parse(await tokenBody(response)));

        if (token.expires_at * 1000 <= Date.now())
          throw new AdapterError("UNAUTHENTICATED", "boxd token is expired");
      })().finally(() => {
        refresh = undefined;
      });
      await refresh;
    }

    ctx.signal.throwIfAborted();

    if (closing) throw new AdapterError("CONFLICT", "boxd connection is closed");
    const result = new Metadata();
    result.set("authorization", `Bearer ${token!.token}`);

    return result;
  };

  const path = (method: { name: string }) => `/boxd.api.v1.BoxdApi/${method.name}`;

  const encode =
    <Req, Resp>(method: Method<Req, Resp>) =>
    (value: Req) =>
      Buffer.from(method.requestType.encode(value).finish());

  const decode =
    <Req, Resp>(method: Method<Req, Resp>) =>
    (value: Buffer) =>
      method.responseType.decode(value);

  const transport: Transport = {
    supportsInteractiveExec: false,
    async consoleOrigin() {
      return "https://app.boxd.sh";
    },
    close() {
      closing = true;

      // Cancelling Exec kills its guest process group. Drain already dispatched
      // finite commands until their explicit execution deadline, then release.
      if (executions === 0) channel.close();
    },
    async unary(method, request) {
      const ctx = localContext();
      const md = await metadata(ctx);

      return new Promise((resolve, reject) => {
        const call = channel.makeUnaryRequest(
          path(method),
          encode(method),
          decode(method),
          request,
          md,
          { deadline: new Date(ctx.deadline) },
          async (error, response) => {
            ctx.signal.removeEventListener("abort", abort);

            if (error) {
              reject(nativeError(error));

              return;
            }

            if (response === undefined) {
              reject(new AdapterError("UNAVAILABLE", "boxd response is missing"));

              return;
            }

            if (method.name === "UploadFile" && ctx.uploadBytes !== undefined) {
              const ack = Upload.safeParse(response);

              if (!ack.success || ack.data.bytesWritten !== ctx.uploadBytes) {
                reject(
                  new AdapterError("UNAVAILABLE", "boxd upload byte count was not acknowledged"),
                );

                return;
              }
            }

            try {
              if (method.name === "CreateVm" && ctx.onCreate) {
                const acknowledgement = z.object({ vmId: z.uuid() }).parse(response);
                await ctx.onCreate(acknowledgement.vmId);
              }

              resolve(response);
            } catch (error) {
              reject(error);
            }
          },
        );

        const abort = () => call.cancel();
        ctx.signal.addEventListener("abort", abort, { once: true });

        if (ctx.signal.aborted) abort();
      });
    },
    serverStream(method, request) {
      const ctx = localContext();
      const events = new EventEmitter();
      void (async () => {
        const md = await metadata(ctx);

        const call = channel.makeServerStreamRequest(
          path(method),
          encode(method),
          decode(method),
          request,
          md,
          { deadline: new Date(ctx.deadline) },
        );

        let count = 0;
        let failed = false;
        const abort = () => call.cancel();
        ctx.signal.addEventListener("abort", abort, { once: true });

        if (ctx.signal.aborted) abort();
        call.on("data", (message) => {
          if (failed) return;
          const frame = Frame.parse(message);
          count += frame.data.length;

          if (count > (ctx.maxBytes ?? MAX_BYTES)) {
            failed = true;
            events.emit("error", new AdapterError("CAPACITY", "boxd file exceeds the read bound"));
            call.cancel();
          } else events.emit("data", message);
        });
        call.on("error", (error) => {
          if (!failed) {
            failed = true;
            events.emit("error", nativeError(error));
          }

          ctx.signal.removeEventListener("abort", abort);
        });
        call.on("end", () => {
          ctx.signal.removeEventListener("abort", abort);

          if (!failed) events.emit("end");
        });
      })().catch((error) => events.emit("error", nativeError(error)));

      return {
        on(event, listener) {
          events.on(event, listener);
        },
      };
    },
    duplex(method) {
      const ctx = localContext();
      const events = new EventEmitter();

      type Req = Parameters<typeof method.requestType.encode>[0];

      let live:
        | ReturnType<
            typeof channel.makeBidiStreamRequest<Req, ReturnType<typeof method.responseType.decode>>
          >
        | undefined;

      const pending: Req[] = [];
      let ended = false;
      let cancelled = false;
      void (async () => {
        const md = await metadata(ctx);

        if (cancelled) return;

        const call = channel.makeBidiStreamRequest(
          path(method),
          encode(method),
          decode(method),
          md,
          { deadline: new Date(ctx.deadline) },
        );

        live = call;
        executions++;
        let count = 0;
        let finished = false;

        const finish = () => {
          if (finished) return;
          finished = true;
          executions--;

          if (closing && executions === 0) channel.close();
        };

        call.on("data", (message) => {
          const frame = Frame.parse(message);
          const terminal = ExitFrame.parse(message);

          if (
            !terminal.stdin &&
            !terminal.windowChange &&
            (terminal.data.length === 0 || terminal.exitCode !== 0)
          )
            ctx.confirmedExit = terminal.exitCode;
          const remaining = Math.max(0, (ctx.maxBytes ?? MAX_BYTES) - count);
          count += frame.data.length;

          if (frame.data.length > remaining) ctx.truncated = true;

          // SAFETY: The public Exec codec validated the message. Only its data
          // bytes are shortened before the native SDK's collector receives it.
          const bounded = {
            ...message,
            data: ctx.signal.aborted ? new Uint8Array() : frame.data.subarray(0, remaining),
          } as typeof message;

          events.emit("data", bounded);
        });
        call.on("error", (error) => {
          finish();
          events.emit("error", nativeError(error));
        });
        call.on("end", () => {
          finish();

          if (ctx.confirmedExit === undefined)
            events.emit(
              "error",
              new AdapterError("UNAVAILABLE", "boxd command exit was not confirmed"),
            );
          else events.emit("end");
        });

        for (const message of pending.splice(0)) call.write(message);

        if (ended) call.end();
      })().catch((error) => events.emit("error", nativeError(error)));

      return {
        on(event, listener) {
          events.on(event, listener);
        },
        write(message) {
          if (live) live.write(message);
          else pending.push(message);
        },
        end() {
          ended = true;
          live?.end();
        },
        cancel() {
          cancelled = true;
          live?.cancel();
        },
      };
    },
    clientStream() {
      // Buffered uploads are bounded below the native unary threshold. Large
      // staged transfers need a separately implemented publication contract.
      throw new AdapterError("UNSUPPORTED", "boxd streaming writes are not implemented");
    },
  };

  return {
    machines: new Machines(transport),
    disks: new Disks(transport),
    account: new AccountNamespace(transport),
    orgs: new Orgs(transport),
    run<T>(ctx: CallContext, action: () => Promise<T>) {
      return context.run(ctx, action);
    },
    close: () => transport.close(),
  };
}

export type BoxdNativeClient = ReturnType<typeof createNativeClient>;
