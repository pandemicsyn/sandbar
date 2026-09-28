import {
  Client,
  credentials,
  Metadata,
  type ClientReadableStream,
  type ClientUnaryCall,
} from "@grpc/grpc-js";
import type { ModalClient } from "modal";

// Audited Modal 0.10.1 TaskCommandRouter wire subset. Mutating calls are sent once.
const SERVICE = "/modal.task_command_router.TaskCommandRouter";

const encoder = new TextEncoder();

function varint(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid protobuf integer");
  const out: number[] = [];

  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    out.push(byte | (value ? 128 : 0));
  } while (value);

  return out;
}

export function field(number: number, value: string | number | Uint8Array): Uint8Array {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Wire encoding branches on the declared scalar union.
  if (typeof value === "number") return Uint8Array.from([...varint(number * 8), ...varint(value)]);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Remaining wire values are UTF-8 text or raw bytes.
  const bytes = typeof value === "string" ? encoder.encode(value) : value;

  return Uint8Array.from([...varint(number * 8 + 2), ...varint(bytes.length), ...bytes]);
}

export function message(...parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0;
  let scale = 1;

  for (let i = 0; i < 10; i++) {
    if (cursor.offset >= bytes.length) throw new Error("Truncated Modal protobuf");
    const byte = bytes[cursor.offset++]!;
    value += (byte & 127) * scale;

    if (!(byte & 128)) {
      if (!Number.isSafeInteger(value)) throw new Error("Invalid Modal protobuf integer");

      return value;
    }

    scale *= 128;
  }

  throw new Error("Invalid Modal protobuf varint");
}

export function parse(bytes: Uint8Array): Map<number, Uint8Array | number> {
  const cursor = { offset: 0 };
  const result = new Map<number, Uint8Array | number>();

  while (cursor.offset < bytes.length) {
    const tag = readVarint(bytes, cursor);
    const number = Math.floor(tag / 8);
    const wire = tag % 8;

    if (wire === 0) result.set(number, readVarint(bytes, cursor));
    else if (wire === 2) {
      const length = readVarint(bytes, cursor);

      if (length > bytes.length - cursor.offset) throw new Error("Truncated Modal protobuf field");
      result.set(number, bytes.slice(cursor.offset, cursor.offset + length));
      cursor.offset += length;
    } else throw new Error("Unsupported Modal protobuf wire type");
  }

  return result;
}

function intField(fields: Map<number, Uint8Array | number>, number: number): number | undefined {
  const value = fields.get(number);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Parsed protobuf fields distinguish varints from bytes.
  return typeof value === "number" ? value : undefined;
}

export type RouterRun = {
  sandboxId: string;
  execId: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds: number;
};

export class ModalRouterWire {
  private readonly channels = new Set<Client>();
  private readonly calls = new Set<ClientUnaryCall | ClientReadableStream<Buffer>>();
  private closed = false;

  constructor(private readonly modal: ModalClient) {}

  private assertActive(signal?: AbortSignal): void {
    if (this.closed) throw new Error("Modal transport is closed");
    signal?.throwIfAborted();
  }

  private async connect(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<{ taskId: string; client: Client; metadata: Metadata }> {
    this.assertActive(signal);
    const task = await this.modal.cpClient.sandboxGetTaskIdV2({ sandboxId });
    this.assertActive(signal);

    if (!task.taskId) throw new Error("Modal sandbox has no task ID");
    this.assertActive(signal);
    const access = await this.modal.cpClient.sandboxGetCommandRouterAccess({ sandboxId });
    this.assertActive(signal);
    const url = new URL(access.url);

    const fixture =
      this.modal.profile.serverUrl.startsWith("http://127.0.0.1:") && url.hostname === "127.0.0.1";

    if ((!fixture && url.protocol !== "https:") || !url.hostname || !access.jwt)
      throw new Error("Invalid Modal command-router access");

    this.assertActive(signal);

    const client = new Client(
      `${url.hostname}:${url.port || "443"}`,
      fixture ? credentials.createInsecure() : credentials.createSsl(),
    );

    this.channels.add(client);
    const metadata = new Metadata();
    metadata.set("authorization", `Bearer ${access.jwt}`);

    return { taskId: task.taskId, client, metadata };
  }

  private release(client: Client): void {
    client.close();
    this.channels.delete(client);
  }

  private unary(
    client: Client,
    metadata: Metadata,
    method: string,
    request: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.assertActive(signal);
      const onAbort = () => call.cancel();

      const call = client.makeUnaryRequest(
        `${SERVICE}/${method}`,
        (value: Uint8Array) => Buffer.from(value),
        (value: Buffer) => value,
        request,
        metadata,
        (error, response) => {
          this.calls.delete(call);
          signal?.removeEventListener("abort", onAbort);

          if (error) reject(error);
          else if (response) resolve(response);
          else reject(new Error("Modal router returned no response"));
        },
      );

      this.calls.add(call);

      if (signal?.aborted) call.cancel();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async start(input: RouterRun, signal?: AbortSignal): Promise<void> {
    const { taskId, client, metadata } = await this.connect(input.sandboxId, signal);

    try {
      const env = Object.entries(input.env ?? {}).map(([key, value]) =>
        field(12, message(field(1, key), field(2, value))),
      );

      await this.unary(
        client,
        metadata,
        "TaskExecStart",
        message(
          field(1, taskId),
          field(2, input.execId),
          ...input.command.map((arg) => field(3, arg)),
          field(4, 1),
          field(5, 1),
          field(6, input.timeoutSeconds),
          ...(input.cwd ? [field(7, input.cwd)] : []),
          ...env,
        ),
        signal,
      );
    } finally {
      this.release(client);
    }
  }

  async stdin(
    sandboxId: string,
    execId: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const { taskId, client, metadata } = await this.connect(sandboxId, signal);

    try {
      // Unary writes carry exact offsets; a lost acknowledgement is never retried.
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        await this.unary(
          client,
          metadata,
          "TaskExecStdinWrite",
          message(
            field(1, taskId),
            field(2, execId),
            field(3, offset),
            field(4, bytes.subarray(offset, offset + 65536)),
          ),
          signal,
        );
      }

      await this.unary(
        client,
        metadata,
        "TaskExecStdinWrite",
        message(field(1, taskId), field(2, execId), field(3, bytes.length), field(5, 1)),
        signal,
      );
    } finally {
      this.release(client);
    }
  }

  async result(
    sandboxId: string,
    execId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array; truncated: boolean }> {
    const { taskId, client, metadata } = await this.connect(sandboxId, signal);

    try {
      const collect = (descriptor: number): Promise<{ bytes: Uint8Array; truncated: boolean }> =>
        new Promise((resolve, reject) => {
          this.assertActive(signal);
          const chunks: Uint8Array[] = [];
          let remaining = maxBytes;
          let truncated = false;

          const call: ClientReadableStream<Buffer> = client.makeServerStreamRequest(
            `${SERVICE}/TaskExecStdioRead`,
            (value: Uint8Array) => Buffer.from(value),
            (value: Buffer) => value,
            message(field(1, taskId), field(2, execId), field(4, descriptor)),
            metadata,
          );

          this.calls.add(call);
          const onAbort = () => call.cancel();

          if (signal?.aborted) call.cancel();
          else signal?.addEventListener("abort", onAbort, { once: true });
          call.on("data", (raw: Buffer) => {
            try {
              const data = parse(raw).get(1);

              if (!(data instanceof Uint8Array)) return;
              const take = Math.min(remaining, data.length);

              if (take) chunks.push(data.slice(0, take));
              remaining -= take;

              if (take < data.length) truncated = true;
            } catch (error) {
              call.cancel();
              reject(error);
            }
          });
          call.on("error", (error) => {
            this.calls.delete(call);
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          });
          call.on("end", () => {
            this.calls.delete(call);
            signal?.removeEventListener("abort", onAbort);
            resolve({ bytes: message(...chunks), truncated });
          });
        });

      const [waitBytes, [stdout, stderr]] = await Promise.all([
        this.unary(
          client,
          metadata,
          "TaskExecWait",
          message(field(1, taskId), field(2, execId)),
          signal,
        ),
        // Modal FileDescriptor enum: stdout = 1, stderr = 2 (0 is unspecified).
        Promise.all([collect(1), collect(2)]),
      ]);

      const wait = parse(waitBytes);

      const code = intField(wait, 1);
      const processSignal = intField(wait, 2);

      if (code === undefined && processSignal === undefined)
        throw new Error("Modal exec exit status unavailable");

      const retainedStderr = stderr.bytes.subarray(0, maxBytes - stdout.bytes.length);

      return {
        exitCode: code ?? 128 + processSignal!,
        stdout: stdout.bytes,
        stderr: retainedStderr,
        truncated:
          stdout.truncated || stderr.truncated || retainedStderr.length < stderr.bytes.length,
      };
    } finally {
      this.release(client);
    }
  }

  close(): void {
    this.closed = true;

    for (const call of this.calls) call.cancel();
    this.calls.clear();

    for (const client of this.channels) client.close();
    this.channels.clear();
  }
}
