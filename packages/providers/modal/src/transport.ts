import { status } from "@grpc/grpc-js";
import {
  InvalidError,
  ModalClient,
  NotFoundError,
  SandboxFilesystemNotFoundError,
  type App,
  type Image,
  type ModalClientParams,
  type SandboxCreateParams,
  type Sandbox,
} from "modal";
import { z } from "zod";
import { AdapterError, type AdapterErrorCode } from "@sandbar-sdk/adapter";
import { ModalRouterWire, type RouterOutput, type RouterRun } from "./router-wire";

export const MODAL_ENDPOINT = "https://api.modal.com:443";

// Modal 0.10.1's filesystem.readBytes() collects all stdout before returning.
// Its own filesystem helper uses this command; stream it through the public
// Sandbox.exec API so a growing file cannot exceed Sandbar's transfer bound.
const MODAL_FS_TOOL = "/__modal/.bin/modal-sandbox-fs-tools";

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid byte limit");

  const bytes = new Uint8Array(maxBytes);
  const reader = stream.getReader();
  let used = 0;

  try {
    for (;;) {
      const part = await reader.read();

      if (part.done) return bytes.slice(0, used);

      if (!(part.value instanceof Uint8Array))
        throw new Error("Modal returned non-binary file data");

      if (part.value.length > maxBytes - used)
        throw new Error("Modal file exceeded bounded read size");

      bytes.set(part.value, used);
      used += part.value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

interface ModalFileReadSandbox {
  filesystem: { stat(path: string): Promise<{ type: string; size: number }> };
  exec(
    command: string[],
    options: { mode: "binary" },
  ): Promise<{ stdout: ReadableStream<Uint8Array>; wait(): Promise<number> }>;
}

export async function readModalFile(
  sandbox: ModalFileReadSandbox,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  try {
    const info = await sandbox.filesystem.stat(path);

    if (
      info.type !== "file" ||
      !Number.isSafeInteger(info.size) ||
      info.size < 0 ||
      info.size > maxBytes
    )
      throw new Error("Modal file is not a bounded regular file");

    const process = await sandbox.exec([MODAL_FS_TOOL, JSON.stringify({ ReadFile: { path } })], {
      mode: "binary",
    });

    const bytes = await readBoundedStream(process.stdout, maxBytes);

    if ((await process.wait()) !== 0) throw new Error("Modal file read failed");

    return bytes;
  } catch (error) {
    if (error instanceof SandboxFilesystemNotFoundError)
      throw new AdapterError("NOT_FOUND", "Modal file not found");
    throw error;
  }
}

export interface ModalSandboxRecord {
  id: string;
  tags: Record<string, string>;
  running: boolean;
}

/** The injected boundary is deliberately smaller than Modal's SDK. */
export interface ModalTransport {
  lookupApp(appName: string, environment: string): Promise<string>;
  imageExists(imageId: string): Promise<boolean>;
  create(input: {
    appId: string;
    imageId: string;
    ociReference?: string;
    name: string;
    tags: Record<string, string>;
    timeoutMs: number;
    /** CPU reservation in cores; may be fractional. */
    cpu?: number;
    /** Memory reservation in MiB. */
    memoryMiB?: number;
    regions?: string[];
    /** Native sandbox environment, sent in the single create request; values may be secrets. */
    env?: Record<string, string>;
  }): Promise<string>;
  findByName(
    appName: string,
    environment: string,
    name: string,
  ): Promise<ModalSandboxRecord | null>;
  list(appId: string): AsyncIterable<ModalSandboxRecord>;
  terminate(sandboxId: string): Promise<boolean>;
  poll(sandboxId: string): Promise<"running" | "stopped" | "missing">;
  readBytes(sandboxId: string, path: string, maxBytes: number): Promise<Uint8Array>;
  fileExists(sandboxId: string, path: string): Promise<boolean>;
  start(input: RouterRun, signal?: AbortSignal): Promise<void>;
  stdin(sandboxId: string, execId: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  stdinWrite?(
    sandboxId: string,
    execId: string,
    offset: number,
    bytes: Uint8Array | "eof",
    signal?: AbortSignal,
  ): Promise<void>;
  result(
    sandboxId: string,
    execId: string,
    maxBytes: number,
    signal?: AbortSignal,
    onOutput?: RouterOutput,
  ): Promise<{
    exitCode: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
    truncated: boolean;
  }>;
  /**
   * Capture the sandbox root filesystem as a new Modal image and return its `im-` ID. The image
   * keeps Modal's default retention (30 days from creation). Throws {@link ModalCreateRejected}
   * only when the request provably made no image.
   */
  /** `ttlMs` is the image lifetime from capture: omitted uses Modal's default, `null` never expires. */
  snapshotFilesystem(sandboxId: string, ttlMs?: number | null): Promise<string>;
  /** Delete an image by ID; `missing` when Modal no longer has it. */
  deleteImage(imageId: string): Promise<"deleted" | "missing">;
  close(): void;
}

/**
 * A Modal create or snapshot failure that provably left nothing behind. `imageBuilt` means an
 * OCI image was built first, so the attempt still had a (possibly paid) effect.
 */
export class ModalCreateRejected extends AdapterError {
  constructor(
    code: AdapterErrorCode,
    message: string,
    readonly imageBuilt = false,
  ) {
    super(code, message);
  }
}

// Server statuses that refuse a request before it takes effect. ALREADY_EXISTS
// means the submission name is taken, possibly by this attempt, so it stays uncertain.
const definitiveStatus = new Map<number, AdapterErrorCode>([
  [status.INVALID_ARGUMENT, "INVALID_ARGUMENT"],
  [status.NOT_FOUND, "NOT_FOUND"],
  [status.PERMISSION_DENIED, "FORBIDDEN"],
  [status.RESOURCE_EXHAUSTED, "CAPACITY"],
  [status.FAILED_PRECONDITION, "CONFLICT"],
  [status.UNAUTHENTICATED, "UNAUTHENTICATED"],
]);

const GrpcClientError = z.object({
  name: z.literal("ClientError"),
  code: z.number().int(),
  details: z.string(),
});

const createSteps = {
  lookup: "image lookup",
  source: "source sandbox lookup",
  build: "image build",
  sandbox: "sandbox creation",
  snapshot: "filesystem snapshot",
} as const;

function nativeDetail(text: string, secrets: string[]): string {
  let detail = text;

  for (const secret of secrets) if (secret) detail = detail.replaceAll(secret, "[redacted]");

  return detail
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Classify a create or snapshot failure by step. The read-only image and source lookups
 * precede every effect, so any failure there is a rejection. An image build, sandbox request
 * or snapshot is rejected only by a definitive server status; otherwise this returns undefined.
 */
export function createRejection(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- thrown native values are classified here.
  error: unknown,
  step: keyof typeof createSteps,
  secrets: string[],
): ModalCreateRejected | undefined {
  const grpc = GrpcClientError.safeParse(error);
  const lookup = step === "lookup" || step === "source";

  if (grpc.success) {
    // grpc-js raises this locally for an oversized response, after the server acted.
    const local = grpc.data.details.startsWith("Received message larger than max");
    const code = local ? undefined : definitiveStatus.get(grpc.data.code);

    if (!code && !lookup) return undefined;
    const detail = nativeDetail(grpc.data.details, secrets);

    return new ModalCreateRejected(
      code ?? "UNAVAILABLE",
      `Modal rejected ${createSteps[step]} (${status[grpc.data.code] ?? grpc.data.code})${detail ? `: ${detail}` : ""}`,
    );
  }

  if (!lookup) return undefined;
  const detail = error instanceof Error ? nativeDetail(error.message, secrets) : "";

  return new ModalCreateRejected(
    error instanceof NotFoundError
      ? "NOT_FOUND"
      : error instanceof InvalidError
        ? "INVALID_ARGUMENT"
        : "UNAVAILABLE",
    `Modal rejected ${createSteps[step]}${detail ? `: ${detail}` : ""}`,
  );
}

export const noRetryGrpcMiddleware: NonNullable<ModalClientParams["grpcMiddleware"]>[number] =
  async function* (call, options) {
    // SAFETY: the SDK middleware accepts an internal retries override at runtime;
    // its public type omits that field, and the loopback fixture verifies one attempt.
    return yield* call.next(call.request, { ...options, retries: 0 } as typeof options);
  };

/**
 * Modal 0.10.1's public grpcMiddleware is outside its built-in retry middleware.
 * Pass retries:0 inward so one Sandbar submission makes one control-plane call.
 * The SDK's task-router calls have separate private retries; this adapter does
 * not invoke their mutating exec or filesystem-write paths.
 */
export function createSdkTransport(input: {
  tokenId: string;
  tokenSecret: string;
  environment: string;
}): ModalTransport {
  const client = new ModalClient({
    tokenId: input.tokenId,
    tokenSecret: input.tokenSecret,
    environment: input.environment,
    maxThrottleWaitSecs: 0,
    grpcMiddleware: [noRetryGrpcMiddleware],
  });

  if (client.version() !== "0.10.1" || client.profile.serverUrl !== MODAL_ENDPOINT) {
    client.close();
    throw new Error("Modal SDK version or endpoint differs from the audited 0.10.1 transport");
  }

  const apps = new Map<string, App>();
  const router = new ModalRouterWire(client);

  async function appFor(appId: string): Promise<App> {
    const app = apps.get(appId);

    if (!app) throw new Error("Modal app was not verified by this transport");

    return app;
  }

  async function record(sandbox: Sandbox): Promise<ModalSandboxRecord> {
    return {
      id: sandbox.sandboxId,
      tags: await sandbox.getTags(),
      running: (await sandbox.poll()) === null,
    };
  }

  return {
    async lookupApp(appName, environment) {
      const app = await client.apps.fromName(appName, { environment, createIfMissing: false });

      if (!app.appId || app.name !== appName || app.environmentName !== environment)
        throw new Error("Modal app lookup returned mismatched identity");
      apps.set(app.appId, app);

      return app.appId;
    },
    async imageExists(imageId) {
      try {
        const image = await client.images.fromId(imageId);

        return image.imageId === imageId;
      } catch (error) {
        if (error instanceof NotFoundError) return false;
        throw error;
      }
    },
    async create({
      appId,
      imageId,
      ociReference,
      name,
      tags,
      timeoutMs,
      cpu,
      memoryMiB,
      regions,
      env,
    }) {
      // Environment values may be secrets; native error details never echo them.
      const secrets = [input.tokenId, input.tokenSecret, ...Object.values(env ?? {})].sort(
        (a, b) => b.length - a.length,
      );

      let app: App;
      let image: Image;

      // Resolve and build first so each failure is known to precede the sandbox request.
      try {
        app = await appFor(appId);
        image = ociReference
          ? client.images.fromRegistry(ociReference)
          : await client.images.fromId(imageId);

        if (!ociReference && image.imageId !== imageId)
          throw new Error("Modal image identity mismatch");
      } catch (error) {
        throw createRejection(error, "lookup", secrets) ?? error;
      }

      try {
        await image.build(app);
      } catch (error) {
        throw createRejection(error, "build", secrets) ?? error;
      }

      let sandbox: Sandbox;
      const params: SandboxCreateParams = { name, tags, timeoutMs, regions, blockNetwork: true };

      if (env) params.env = env;

      if (cpu !== undefined) params.cpu = cpu;

      if (memoryMiB !== undefined) params.memoryMiB = memoryMiB;

      try {
        sandbox = await client.sandboxes.experimentalCreate(app, image, params);
      } catch (error) {
        const rejection = createRejection(error, "sandbox", secrets);

        if (!rejection) throw error;

        throw ociReference
          ? new ModalCreateRejected(rejection.code, rejection.message, true)
          : rejection;
      }

      if (!sandbox.sandboxId) throw new Error("Modal create returned no sandbox ID");

      return sandbox.sandboxId;
    },
    async findByName(appName, environment, name) {
      try {
        return await record(
          await client.sandboxes.experimentalFromName(appName, name, { environment }),
        );
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
    async *list(appId) {
      for await (const sandbox of client.sandboxes.experimentalList({ appId }))
        yield await record(sandbox);
    },
    async terminate(sandboxId) {
      const sandbox = await client.sandboxes.fromId(sandboxId);
      await sandbox.terminate({ wait: true });

      return (await sandbox.poll()) !== null;
    },
    async poll(sandboxId) {
      try {
        const sandbox = await client.sandboxes.fromId(sandboxId);

        return (await sandbox.poll()) === null ? "running" : "stopped";
      } catch (error) {
        if (error instanceof NotFoundError) return "missing";

        throw error;
      }
    },
    async readBytes(sandboxId, path, maxBytes) {
      const sandbox = await client.sandboxes.fromId(sandboxId);

      return readModalFile(sandbox, path, maxBytes);
    },
    async fileExists(sandboxId, path) {
      const sandbox = await client.sandboxes.fromId(sandboxId);

      try {
        await sandbox.filesystem.stat(path);

        return true;
      } catch (error) {
        if (error instanceof SandboxFilesystemNotFoundError) return false;
        throw error;
      }
    },
    async snapshotFilesystem(sandboxId, ttlMs) {
      const secrets = [input.tokenId, input.tokenSecret];
      let sandbox: Sandbox;

      try {
        sandbox = await client.sandboxes.fromId(sandboxId);
      } catch (error) {
        throw createRejection(error, "source", secrets) ?? error;
      }

      // Modal 0.10.1 sends one TaskSnapshotFilesystem request with a fresh snapshot ID and
      // resends that same request only after DEADLINE_EXCEEDED or CANCELLED.
      try {
        const image = await sandbox.snapshotFilesystem(ttlMs === undefined ? {} : { ttlMs });

        return image.imageId;
      } catch (error) {
        throw createRejection(error, "snapshot", secrets) ?? error;
      }
    },
    async deleteImage(imageId) {
      try {
        await client.images.delete(imageId);

        return "deleted";
      } catch (error) {
        if (error instanceof NotFoundError) return "missing";
        throw error;
      }
    },
    start: (input, signal) => router.start(input, signal),
    stdin: (sandboxId, execId, bytes, signal) => router.stdin(sandboxId, execId, bytes, signal),
    stdinWrite: (sandboxId, execId, offset, bytes, signal) =>
      router.stdinWrite(sandboxId, execId, offset, bytes, signal),
    result: (sandboxId, execId, maxBytes, signal, onOutput) =>
      router.result(sandboxId, execId, maxBytes, signal, onOutput),
    close() {
      router.close();
      client.close();
    },
  };
}
