import {
  ModalClient,
  NotFoundError,
  SandboxFilesystemNotFoundError,
  type App,
  type ModalClientParams,
  type Sandbox,
} from "modal";
import { AdapterError } from "sandbar-adapter";
import { ModalRouterWire, type RouterRun } from "./router-wire";

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
    regions?: string[];
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
  result(
    sandboxId: string,
    execId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{
    exitCode: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
    truncated: boolean;
  }>;
  close(): void;
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
    async create({ appId, imageId, ociReference, name, tags, timeoutMs, regions }) {
      const image = ociReference
        ? client.images.fromRegistry(ociReference)
        : await client.images.fromId(imageId);

      if (!ociReference && image.imageId !== imageId)
        throw new Error("Modal image identity mismatch");

      const sandbox = await client.sandboxes.experimentalCreate(await appFor(appId), image, {
        name,
        tags,
        timeoutMs,
        regions,
        blockNetwork: true,
      });

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
    start: (input, signal) => router.start(input, signal),
    stdin: (sandboxId, execId, bytes, signal) => router.stdin(sandboxId, execId, bytes, signal),
    result: (sandboxId, execId, maxBytes, signal) =>
      router.result(sandboxId, execId, maxBytes, signal),
    close() {
      router.close();
      client.close();
    },
  };
}
