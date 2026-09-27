import type { z } from "zod";
import type { RuntimeSession } from "sandbar-adapter";
import { fileURLToPath } from "node:url";
import { openDomainRuntime } from "../../../apps/server/src/runtime";

/** Trusted installed code; connections only supply validated JSON configuration and credentials. */
export type ServiceAdapter = {
  readonly name: string;
  readonly displayName?: string;
  readonly config: z.ZodType;
  readonly credentials: z.ZodType;
  readonly policy?: { readonly schema: z.ZodType; readonly default: unknown };
  connect(input: never): Promise<RuntimeSession>;
};

export type ServiceOptions = {
  storage: { url: string; keyFile: string };
  auth: { setupTokenFile: string };
  adapters: readonly ServiceAdapter[];
  publicOrigin?: string;
  startRunner?: boolean;
};

export type ServiceHandle = {
  readonly app: { fetch(request: Request): Response | Promise<Response> };
  listen(input: { port: number; hostname?: string }): Promise<{ port: number; hostname: string }>;
  close(): Promise<void>;
};

/** Open the optional Bun service as a consumer of the public SDK adapter lifecycle. */
export async function createService(options: ServiceOptions): Promise<ServiceHandle> {
  const runtime = await openDomainRuntime({
    databaseUrl: options.storage.url,
    keyFile: options.storage.keyFile,
    setupTokenFile: options.auth.setupTokenFile,
    adapters: options.adapters,
    publicOrigin: options.publicOrigin,
    startRunner: options.startRunner,
    webDist: fileURLToPath(new URL("./web/", import.meta.url)),
  });

  let server: ReturnType<typeof Bun.serve> | undefined;

  return {
    app: runtime.app,
    async listen(input) {
      if (server) throw new Error("Service is already listening");

      if (!Number.isInteger(input.port) || input.port < 0 || input.port > 65535)
        throw new Error("Invalid service port");
      const hostname = input.hostname ?? "127.0.0.1";

      if (hostname !== "127.0.0.1" && hostname !== "::1" && !options.publicOrigin)
        throw new Error("Public origin is required outside loopback");
      server = Bun.serve({ port: input.port, hostname, fetch: runtime.app.fetch });

      return { port: server.port ?? input.port, hostname: server.hostname ?? hostname };
    },
    async close() {
      server?.stop();
      await runtime.close();
    },
  };
}
