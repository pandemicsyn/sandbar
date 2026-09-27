import {
  ModalClient,
  NotFoundError,
  type App,
  type ModalClientParams,
  type Sandbox,
} from "modal";

export const MODAL_ENDPOINT = "https://api.modal.com:443";

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
    name: string;
    tags: Record<string, string>;
    timeoutMs: number;
    regions?: string[];
  }): Promise<string>;
  findByName(appName: string, environment: string, name: string): Promise<ModalSandboxRecord | null>;
  list(appId: string): AsyncIterable<ModalSandboxRecord>;
  terminate(sandboxId: string): Promise<boolean>;
  readBytes(sandboxId: string, path: string, maxBytes: number): Promise<Uint8Array>;
  close(): void;
}

export const noRetryGrpcMiddleware: NonNullable<ModalClientParams["grpcMiddleware"]>[number] = async function* (call, options) {
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
  async function appFor(appId: string): Promise<App> {
    const app = apps.get(appId);
    if (!app) throw new Error("Modal app was not verified by this transport");
    return app;
  }
  async function record(sandbox: Sandbox): Promise<ModalSandboxRecord> {
    return { id: sandbox.sandboxId, tags: await sandbox.getTags(), running: (await sandbox.poll()) === null };
  }

  return {
    async lookupApp(appName, environment) {
      const app = await client.apps.fromName(appName, { environment, createIfMissing: false });
      if (!app.appId || app.name !== appName || app.environmentName !== environment) throw new Error("Modal app lookup returned mismatched identity");
      apps.set(app.appId, app);
      return app.appId;
    },
    async imageExists(imageId) {
      try { const image = await client.images.fromId(imageId); return image.imageId === imageId; }
      catch (error) { if (error instanceof NotFoundError) return false; throw error; }
    },
    async create({ appId, imageId, name, tags, timeoutMs, regions }) {
      const image = await client.images.fromId(imageId);
      if (image.imageId !== imageId) throw new Error("Modal image identity mismatch");
      const sandbox = await client.sandboxes.experimentalCreate(await appFor(appId), image, {
        name, tags, timeoutMs, regions, blockNetwork: true,
      });
      if (!sandbox.sandboxId) throw new Error("Modal create returned no sandbox ID");
      return sandbox.sandboxId;
    },
    async findByName(appName, environment, name) {
      try { return await record(await client.sandboxes.experimentalFromName(appName, name, { environment })); }
      catch (error) { if (error instanceof NotFoundError) return null; throw error; }
    },
    async *list(appId) {
      for await (const sandbox of client.sandboxes.experimentalList({ appId })) yield await record(sandbox);
    },
    async terminate(sandboxId) {
      const sandbox = await client.sandboxes.fromId(sandboxId);
      await sandbox.terminate({ wait: true });
      return (await sandbox.poll()) !== null;
    },
    async readBytes(sandboxId, path, maxBytes) {
      const sandbox = await client.sandboxes.fromId(sandboxId);
      const info = await sandbox.filesystem.stat(path);
      if (info.type !== "file" || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > maxBytes) throw new Error("Modal file is not a bounded regular file");
      const bytes = await sandbox.filesystem.readBytes(path);
      if (!(bytes instanceof Uint8Array) || bytes.length > maxBytes) throw new Error("Modal file exceeded bounded read size");
      return bytes;
    },
    close() { client.close(); },
  };
}
