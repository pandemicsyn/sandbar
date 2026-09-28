import { Sandbox, SandboxNotFoundError, Template } from "e2b";
import { z } from "zod";

export const E2B_ENDPOINT = "https://api.e2b.app";

export const MAX_BYTES = 1_048_576;

const Templates = z.array(
  z.object({
    templateID: z.string(),
    buildID: z.string(),
    buildStatus: z.string(),
    names: z.array(z.string()),
  }),
);

export type E2BRecord = {
  id: string;
  templateId: string;
  metadata: Record<string, string>;
  state: "running" | "paused";
};

export type E2BTransport = {
  verifyTeam(teamId: string): Promise<void>;
  verifyTemplate(teamId: string, templateId: string): Promise<void>;
  buildImage(reference: string, name: string): Promise<{ templateId: string; buildId: string }>;
  findBuild(
    teamId: string,
    name: string,
  ): Promise<{ templateId: string; buildId: string; status: string } | null>;
  create(input: {
    templateId: string;
    metadata: Record<string, string>;
    timeoutMs: number;
    allowInternetAccess: boolean;
  }): Promise<string>;
  get(id: string): Promise<E2BRecord | null>;
  list(
    metadata: Record<string, string>,
    limit: number,
    nextToken?: string,
  ): Promise<{ items: E2BRecord[]; nextToken?: string }>;
  kill(id: string): Promise<boolean>;
  run(
    id: string,
    script: string,
    options: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
  ): Promise<string>;
  read(
    id: string,
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; truncated: boolean }>;
  write(id: string, path: string, bytes: Uint8Array): Promise<void>;
  remove(id: string, path: string): Promise<void>;
  close(): void;
};

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const result = new Uint8Array(maxBytes);
  const reader = stream.getReader();
  let used = 0;

  try {
    for (;;) {
      const part = await reader.read();

      if (part.done) return { bytes: result.slice(0, used), truncated: false };

      if (!(part.value instanceof Uint8Array)) throw new Error("E2B returned non-binary file data");
      const copy = Math.min(part.value.length, maxBytes - used);
      result.set(part.value.subarray(0, copy), used);
      used += copy;

      if (copy < part.value.length) {
        await reader.cancel();

        return { bytes: result, truncated: true };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Pinned e2b@2.51.0. Every control-plane call explicitly disables its 429 retry loop. */
export function createSdkTransport(apiKey: string, fetcher: typeof fetch = fetch): E2BTransport {
  const opts = {
    apiKey,
    retries: 0,
    domain: "e2b.app",
    apiUrl: E2B_ENDPOINT,
    sandboxUrl: "https://sandbox.e2b.app",
    debug: false,
    requestTimeoutMs: 30_000,
  } as const;

  async function get(id: string): Promise<E2BRecord | null> {
    try {
      const info = await Sandbox.getInfo(id, opts);

      return {
        id: info.sandboxId,
        templateId: info.templateId,
        metadata: info.metadata,
        state: info.state,
      };
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return null;
      throw error;
    }
  }

  async function controlGet(path: string): Promise<Response> {
    return fetcher(`${E2B_ENDPOINT}${path}`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  }

  async function* teamTemplates(teamId: string) {
    let nextToken: string | undefined;
    const seen = new Set<string>();

    do {
      const query = new URLSearchParams({ teamID: teamId, limit: "100" });

      if (nextToken) query.set("nextToken", nextToken);
      const response = await controlGet(`/v2/templates?${query}`);

      if (!response.ok) throw new Error(`E2B template listing failed (${response.status})`);
      yield Templates.parse(await response.json());
      nextToken = response.headers.get("X-Next-Token") ?? undefined;

      if (nextToken) {
        if (seen.has(nextToken) || seen.size >= 100)
          throw new Error("E2B template listing exceeded its page bound");
        seen.add(nextToken);
      }
    } while (nextToken);
  }

  return {
    async verifyTeam(teamId) {
      const response = await controlGet(
        `/teams/${encodeURIComponent(teamId)}/metrics/max?metric=concurrent_sandboxes`,
      );

      if (!response.ok) throw new Error(`E2B team verification failed (${response.status})`);
      await response.body?.cancel();
    },
    async verifyTemplate(teamId, templateId) {
      for await (const templates of teamTemplates(teamId)) {
        if (
          templates.some(
            (value) => value.templateID === templateId && value.buildStatus === "ready",
          )
        )
          return;
      }

      throw new Error("E2B template is not a ready template in the verified team");
    },
    async buildImage(reference, name) {
      const result = await Template.build(Template().fromImage(reference), name, opts);

      return { templateId: result.templateId, buildId: result.buildId };
    },
    async findBuild(teamId, name) {
      for await (const templates of teamTemplates(teamId)) {
        const found = templates.find((value) =>
          value.names.some((candidate) => {
            const localName = candidate.slice(candidate.lastIndexOf("/") + 1);

            return localName === name || localName === `${name}:default`;
          }),
        );

        if (found)
          return {
            templateId: found.templateID,
            buildId: found.buildID,
            status: found.buildStatus,
          };
      }

      return null;
    },
    async create(input) {
      const sandbox = await Sandbox.create(input.templateId, {
        ...opts,
        metadata: input.metadata,
        timeoutMs: input.timeoutMs,
        allowInternetAccess: input.allowInternetAccess,
      });

      return sandbox.sandboxId;
    },
    get,
    async list(metadata, limit, nextToken) {
      const paginator = Sandbox.list({ ...opts, limit, nextToken, query: { metadata } });

      const items = (await paginator.nextItems()).map((info) => ({
        id: info.sandboxId,
        templateId: info.templateId,
        metadata: info.metadata,
        state: info.state,
      }));

      return { items, nextToken: paginator.nextToken };
    },
    async kill(id) {
      return Sandbox.kill(id, opts);
    },
    async run(id, script, options) {
      const sandbox = await Sandbox.connect(id, opts);

      const result = await sandbox.commands.run(script, {
        cwd: options.cwd,
        envs: options.env,
        timeoutMs: options.timeoutMs,
        requestTimeoutMs: options.timeoutMs,
      });

      return result.stdout;
    },
    async read(id, path, maxBytes) {
      const sandbox = await Sandbox.connect(id, opts);

      return collectBounded(
        await sandbox.files.read(path, { format: "stream", requestTimeoutMs: 30_000 }),
        maxBytes,
      );
    },
    async write(id, path, bytes) {
      const sandbox = await Sandbox.connect(id, opts);
      await sandbox.files.write(path, new Blob([new Uint8Array(bytes)]), {
        requestTimeoutMs: 30_000,
      });
    },
    async remove(id, path) {
      const sandbox = await Sandbox.connect(id, opts);
      await sandbox.files.remove(path, { requestTimeoutMs: 30_000 });
    },
    close() {},
  };
}
