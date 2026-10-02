import {
  Sandbox,
  SandboxNotFoundError,
  AuthenticationError,
  InvalidArgumentError,
  Template,
  Volume,
  CommandExitError,
  type CommandHandle,
} from "e2b";
import {
  AdapterError,
  type NativeProcess,
  type ProcessStartContext,
  type ProcessObservationFailure,
} from "sandbar-adapter";
import { z } from "zod";
import { classifyWriteFailure, E2BWriteFailure } from "./write-failure";

export const E2B_ENDPOINT = "https://api.e2b.app";

export const MAX_BYTES = 1_048_576;

/** A positive guest rejection, never inferred from error text. */
export class E2BDirectoryRejected extends AdapterError {
  constructor() {
    super("INVALID_ARGUMENT", "E2B path is not a directory");
  }
}

class NativeReadError extends AdapterError {
  constructor(readonly statusCode: number) {
    super(
      statusCode === 404
        ? "NOT_FOUND"
        : [401, 403].includes(statusCode)
          ? "FORBIDDEN"
          : "UNAVAILABLE",
      `E2B state read failed (${statusCode})`,
    );
  }
}

export class E2BRenewRejected extends AdapterError {
  constructor(status: number) {
    super(
      status === 404
        ? "NOT_FOUND"
        : [401, 403].includes(status)
          ? "FORBIDDEN"
          : status === 409
            ? "CONFLICT"
            : status === 429
              ? "RATE_LIMIT"
              : "INVALID_ARGUMENT",
      `E2B renewal rejected (${status})`,
    );
  }
}

/** Positive native rejection; messages and response bodies never enter recovery. */
export class E2BVolumeCreateRejected extends Error {
  constructor(readonly status: 400 | 401 | 403) {
    super(`E2B volume creation rejected (${status})`);
    this.name = "E2BVolumeCreateRejected";
  }
}

const Templates = z
  .array(
    z.object({
      templateID: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/),
      buildID: z.string().min(1).max(128),
      buildStatus: z.enum(["building", "waiting", "ready", "error"]),
      names: z.array(z.string().min(1).max(256)).max(100),
    }),
  )
  .max(100);

export type E2BRecord = {
  id: string;
  templateId: string;
  metadata: Record<string, string>;
  state: string;
  endAt?: string | null;
  domain?: string;
  allowPublicTraffic?: boolean;
  lifecycle?: { onTimeout?: string; autoResume?: boolean };
  envdVersion?: string;
  /** Native detail proves guest IO can attach without resuming or changing lifetime. */
  attachmentReady?: boolean;
  volumeMounts?: { name: string; path: string }[];
};

export type E2BTemplateState = {
  templateId: string;
  names: string[];
  public: boolean;
  builds: { buildId: string; status: "building" | "waiting" | "ready" | "error" }[];
};

export type E2BStateTransport = {
  template(id: string): Promise<E2BTemplateState | null>;
  verifyAddress(id: string, names?: string[]): Promise<void>;
  tags(id: string): Promise<{ tag: string; buildId: string }[]>;
  capture(
    id: string,
    name?: string,
    signal?: AbortSignal,
  ): Promise<{ snapshotId: string; names: string[] }>;
  snapshots(input: {
    limit: number;
    name?: string;
    sandboxId?: string;
    cursor?: string;
  }): Promise<{ items: { snapshotId: string; names: string[] }[]; nextCursor?: string }>;
  deleteSnapshot(id: string, signal?: AbortSignal): Promise<boolean>;
  createVolume(name: string, signal?: AbortSignal): Promise<{ volumeId: string; name: string }>;
  volume(id: string): Promise<{ volumeId: string; name: string }>;
  volumes(): Promise<{ volumeId: string; name: string }[]>;
  deleteVolume(id: string, signal?: AbortSignal): Promise<boolean>;
};

export type E2BTransport = {
  state?: E2BStateTransport;
  verifyAuth(): Promise<void>;
  verifyTeam(teamId: string): Promise<void>;
  verifyTemplate(teamId: string | undefined, templateId: string): Promise<string>;
  buildImage(reference: string, name: string): Promise<{ templateId: string; buildId: string }>;
  findBuild(
    teamId: string | undefined,
    name: string,
  ): Promise<{ templateId: string; buildId: string; status: string } | null>;
  create(input: {
    templateId: string;
    metadata: Record<string, string>;
    timeoutMs: number;
    allowInternetAccess: boolean;
    allowPublicTraffic?: boolean;
    volumeMounts?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<string>;
  get(id: string): Promise<E2BRecord | null>;
  list(
    metadata: Record<string, string>,
    limit: number,
    nextToken?: string,
  ): Promise<{ items: E2BRecord[]; nextToken?: string }>;
  renew?: (id: string, seconds: number, signal: AbortSignal) => Promise<void>;
  kill(id: string, signal?: AbortSignal): Promise<boolean>;
  run(
    id: string,
    script: string,
    options: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
  ): Promise<string>;
  startText?: (
    id: string,
    script: string,
    options: { cwd?: string; env?: Record<string, string> },
    ctx: ProcessStartContext,
  ) => Promise<NativeProcess>;
  read(
    id: string,
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; truncated: boolean }>;
  write(id: string, path: string, bytes: Uint8Array): Promise<void>;
  exists?: (id: string, path: string, signal: AbortSignal) => Promise<boolean>;
  makeDirectory?: (id: string, path: string, signal: AbortSignal) => Promise<void>;
  removeEntry?: (id: string, path: string, signal: AbortSignal) => Promise<void>;
  remove(id: string, path: string): Promise<void>;
  close(): void;
};

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const result = new Uint8Array(maxBytes);
  const reader = stream.getReader();
  let used = 0;

  try {
    for (;;) {
      signal?.throwIfAborted();
      const part = await readChunk(reader, signal);
      signal?.throwIfAborted();

      if (part.done) return { bytes: result.slice(0, used), truncated: false };

      if (!(part.value instanceof Uint8Array)) throw new Error("E2B returned non-binary file data");
      const copy = Math.min(part.value.length, maxBytes - used);
      result.set(part.value.subarray(0, copy), used);
      used += copy;

      if (copy < part.value.length) {
        return { bytes: result, truncated: true };
      }
    }
  } finally {
    disposeFileReader(reader);
  }
}

function disposeFileReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Native stream cleanup is best effort and must not hold local cancellation.
  } finally {
    reader.releaseLock();
  }
}

function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
  const pending = reader.read();

  if (!signal) return pending;

  return new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };

    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );

    if (signal.aborted) abort();
  });
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

  const Detail = z.object({
    sandboxID: z.string(),
    templateID: z.string(),
    metadata: z.record(z.string(), z.string()),
    state: z.string(),
    envdVersion: z.string().optional(),
    envdAccessToken: z.string().min(1).max(8192).optional(),
    domain: z.string().optional(),
    network: z.object({ allowPublicTraffic: z.boolean().optional() }).optional(),
    lifecycle: z
      .object({ onTimeout: z.string().optional(), autoResume: z.boolean().optional() })
      .optional(),
    endAt: z.string().nullable().optional(),
    volumeMounts: z.array(z.object({ name: z.string(), path: z.string() })).optional(),
  });

  async function attach(
    id: string,
    logger?: { error(label: string, status: number): void },
    signal?: AbortSignal,
  ): Promise<Sandbox> {
    const response = await controlGet(`/sandboxes/${encodeURIComponent(id)}`, signal);
    const detail = await readNative(response, Detail, signal);

    if (detail.sandboxID !== id) throw new AdapterError("CONFLICT", "E2B identity differs");

    if (
      detail.state !== "running" ||
      detail.lifecycle?.autoResume !== false ||
      !detail.envdAccessToken ||
      !detail.envdVersion ||
      detail.domain !== "e2b.app"
    )
      throw new AdapterError("UNAVAILABLE", "E2B read-only guest attachment is unavailable");

    return new Sandbox({
      ...opts,
      logger,
      sandboxId: id,
      envdVersion: detail.envdVersion,
      envdAccessToken: detail.envdAccessToken,
      sandboxDomain: detail.domain,
    });
  }

  async function get(id: string): Promise<E2BRecord | null> {
    try {
      const response = await controlGet(`/sandboxes/${encodeURIComponent(id)}`);

      if (response.status === 404) return null;
      const info = await readNative(response, Detail);

      return {
        id: info.sandboxID,
        templateId: info.templateID,
        metadata: info.metadata,
        state: info.state,
        envdVersion: info.envdVersion,
        attachmentReady:
          info.state === "running" &&
          info.lifecycle?.autoResume === false &&
          !!info.envdAccessToken &&
          !!info.envdVersion &&
          info.domain === "e2b.app",
        endAt: info.endAt,
        domain: info.domain,
        allowPublicTraffic: info.network?.allowPublicTraffic,
        lifecycle: info.lifecycle,
        volumeMounts: info.volumeMounts,
      };
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return null;
      throw error;
    }
  }

  async function controlGet(path: string, signal?: AbortSignal): Promise<Response> {
    return fetcher(`${E2B_ENDPOINT}${path}`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  }

  async function readNative<S extends z.ZodType>(
    response: Response,
    schema: S,
    signal?: AbortSignal,
  ): Promise<z.output<S>> {
    if (!response.ok) throw new NativeReadError(response.status);

    if (!response.body) throw new Error("E2B returned no native data");
    const body = await collectBounded(response.body, MAX_BYTES, signal);

    if (body.truncated) throw new Error("E2B native response exceeded its byte bound");

    return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)));
  }

  async function readSnapshots(input: {
    limit: number;
    name?: string;
    sandboxId?: string;
    cursor?: string;
  }) {
    const query = new URLSearchParams({ limit: String(input.limit) });

    if (input.name) query.set("name", input.name);

    if (input.sandboxId) query.set("sandboxID", input.sandboxId);

    if (input.cursor) query.set("nextToken", input.cursor);
    const response = await controlGet(`/snapshots?${query}`);

    const values = await readNative(
      response,
      z
        .array(
          z.object({
            snapshotID: z.string().min(1).max(512),
            names: z.array(z.string().min(1).max(512)).max(100),
          }),
        )
        .max(input.limit),
    );

    return {
      items: values.map((value) => ({ snapshotId: value.snapshotID, names: value.names })),
      nextCursor: response.headers.get("X-Next-Token") ?? undefined,
    };
  }

  const readTemplates = (response: Response) => readNative(response, Templates);

  async function* teamTemplates(teamId: string | undefined) {
    let nextToken: string | undefined;
    const seen = new Set<string>();

    do {
      const query = new URLSearchParams({ limit: "100" });

      if (teamId) query.set("teamID", teamId);

      if (nextToken) query.set("nextToken", nextToken);
      const response = await controlGet(`/v2/templates?${query}`);

      if (!response.ok) throw new Error(`E2B template listing failed (${response.status})`);
      yield await readTemplates(response);
      nextToken = response.headers.get("X-Next-Token") ?? undefined;

      if (nextToken) {
        if (seen.has(nextToken) || seen.size >= 100)
          throw new Error("E2B template listing exceeded its page bound");
        seen.add(nextToken);
      }
    } while (nextToken);
  }

  return {
    state: {
      async template(id) {
        const response = await controlGet(`/templates/${encodeURIComponent(id)}?limit=100`);

        if (response.status === 404) {
          await response.body?.cancel();

          return null;
        }

        if (response.headers.get("X-Next-Token"))
          throw new Error("E2B template builds exceed the inspection bound");

        const value = await readNative(
          response,
          z.object({
            templateID: z.string().min(1).max(128),
            names: z.array(z.string().max(256)).max(100),
            public: z.boolean(),
            builds: z
              .array(
                z.object({
                  buildID: z.uuid(),
                  status: z.enum(["building", "waiting", "ready", "error"]),
                }),
              )
              .max(100),
          }),
        );

        return {
          templateId: value.templateID,
          names: value.names,
          public: value.public,
          builds: value.builds.map((build) => ({ buildId: build.buildID, status: build.status })),
        };
      },
      async verifyAddress(id, names = []) {
        for await (const templates of teamTemplates(undefined)) {
          for (const value of templates) {
            if (
              value.templateID !== id &&
              value.names.some((name) => {
                const local = name.slice(name.lastIndexOf("/") + 1).replace(/:default$/, "");

                return local === id || name.replace(/:default$/, "") === id;
              })
            )
              throw new Error("E2B raw template identity is shadowed by an alias");
          }
        }

        let cursor: string | undefined;
        let foundSnapshot = false;
        const seen = new Set<string>();
        const withoutTag = (value: string) => value.split(":")[0]!;

        for (let count = 0; count < 100; count++) {
          const page = await readSnapshots({ limit: 100, cursor });

          for (const value of page.items) {
            if (
              withoutTag(value.snapshotId) === id ||
              value.names.some((name) => names.includes(withoutTag(name)))
            ) {
              foundSnapshot = true;
              continue;
            }

            if (
              value.names.some((name) => {
                const local = name.slice(name.lastIndexOf("/") + 1).replace(/:default$/, "");

                return local === id || name.replace(/:default$/, "") === id;
              })
            )
              throw new Error("E2B raw snapshot identity is shadowed by an alias");
          }

          cursor = page.nextCursor;

          if (!cursor) {
            if (!foundSnapshot) throw new Error("Native snapshot kind is unverified");

            return;
          }

          if (seen.has(cursor)) throw new Error("E2B snapshot inventory repeated a cursor");
          seen.add(cursor);
        }

        throw new Error("E2B snapshot address inventory exceeds its page bound");
      },
      async tags(id) {
        const tags = await readNative(
          await controlGet(`/templates/${encodeURIComponent(id)}/tags`),
          z
            .array(
              z.object({ tag: z.string().min(1).max(128), buildID: z.string().min(1).max(128) }),
            )
            .max(100),
        );

        return tags.map((tag) => ({ tag: tag.tag, buildId: tag.buildID }));
      },
      capture: (id, name, signal) => Sandbox.createSnapshot(id, { ...opts, name, signal }),
      snapshots: readSnapshots,
      deleteSnapshot: (id, signal) => Sandbox.deleteSnapshot(id, { ...opts, signal }),
      async createVolume(name, signal) {
        const response = await fetcher(`${E2B_ENDPOINT}/volumes`, {
          method: "POST",
          headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        });

        if (response.status === 400 || response.status === 401 || response.status === 403) {
          void response.body?.cancel().catch(() => undefined);
          throw new E2BVolumeCreateRejected(response.status);
        }

        if (response.status !== 201)
          throw new Error(`E2B volume create acknowledgement unavailable (${response.status})`);

        const volume = await readNative(
          response,
          z.object({ volumeID: z.string().min(1).max(128), name: z.string().min(1).max(128) }),
        );

        return { volumeId: volume.volumeID, name: volume.name };
      },
      async volume(id) {
        const v = await Volume.getInfo(id, opts);

        return { volumeId: v.volumeId, name: v.name };
      },
      async volumes() {
        const values = await readNative(
          await controlGet("/volumes"),
          z.array(
            z.object({ volumeID: z.string().min(1).max(128), name: z.string().min(1).max(128) }),
          ),
        );

        return values.map((value) => ({ volumeId: value.volumeID, name: value.name }));
      },
      deleteVolume: (id, signal) => Volume.destroy(id, { ...opts, signal }),
    },
    async verifyAuth() {
      const response = await controlGet("/v2/templates?limit=1");

      if (!response.ok) throw new NativeReadError(response.status);
      const templates = await readTemplates(response);

      if (templates.length > 1) throw new Error("E2B authentication exceeded its item bound");
    },
    async verifyTeam(teamId) {
      const response = await controlGet(
        `/teams/${encodeURIComponent(teamId)}/metrics/max?metric=concurrent_sandboxes`,
      );

      if (!response.ok) throw new NativeReadError(response.status);
      await response.body?.cancel();
    },
    async verifyTemplate(teamId, templateId) {
      let resolved: string | undefined;

      for await (const templates of teamTemplates(teamId)) {
        for (const value of templates) {
          const matches =
            value.templateID === templateId ||
            value.names.some((name) => {
              if (name.includes(":") && !name.endsWith(":default")) return false;
              const localName = name.slice(name.lastIndexOf("/") + 1);

              return [
                name,
                localName,
                name.replace(/:default$/, ""),
                localName.replace(/:default$/, ""),
              ].includes(templateId);
            });

          if (!matches || value.buildStatus !== "ready") continue;

          if (resolved && resolved !== value.templateID)
            throw new Error("E2B template selector is ambiguous");
          resolved = value.templateID;
        }
      }

      if (resolved) return resolved;

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
        lifecycle: { onTimeout: "kill", autoResume: false },
        allowInternetAccess: input.allowInternetAccess,
        network: { allowPublicTraffic: input.allowPublicTraffic ?? false },
        volumeMounts: input.volumeMounts,
        signal: input.signal,
      });

      return sandbox.sandboxId;
    },
    get,
    async list(metadata, limit, nextToken) {
      const paginator = Sandbox.list({
        ...opts,
        limit,
        nextToken,
        query: Object.keys(metadata).length ? { metadata } : undefined,
      });

      const items = (await paginator.nextItems()).map((info) => ({
        id: info.sandboxId,
        templateId: info.templateId,
        metadata: info.metadata,
        state: info.state,
        envdVersion: info.envdVersion,
        endAt: info.endAt?.toISOString(),
        volumeMounts: info.volumeMounts,
      }));

      return { items, nextToken: paginator.nextToken };
    },
    async renew(id, seconds, signal) {
      const response = await fetcher(
        `${E2B_ENDPOINT}/sandboxes/${encodeURIComponent(id)}/timeout`,
        {
          method: "POST",
          headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ timeout: seconds }),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        },
      );

      void response.body?.cancel().catch(() => undefined);

      if ([400, 401, 403, 404, 409, 422, 429].includes(response.status))
        throw new E2BRenewRejected(response.status);

      if (!response.ok) throw new AdapterError("UNAVAILABLE", "E2B renewal response is uncertain");
    },
    async kill(id, signal) {
      return Sandbox.kill(id, { ...opts, signal });
    },
    async startText(id, script, options, ctx) {
      const sandbox = await attach(id, undefined, ctx.signal);

      if (ctx.signal.aborted) throw new AdapterError("UNAVAILABLE", "Process setup stopped");
      const stream = new AbortController();
      let native: CommandHandle | undefined;
      let abandoned = false;
      let disconnected = false;

      const disconnect = (): Promise<void> => {
        if (!native || disconnected) return Promise.resolve();
        disconnected = true;

        return native.disconnect();
      };

      const stop = () => {
        abandoned = true;
        stream.abort();

        void disconnect().catch(() => undefined);
      };

      ctx.signal.addEventListener("abort", stop, { once: true });

      const deliver = (streamName: "stdout" | "stderr", text: string) => {
        if (abandoned) return;

        try {
          ctx.onOutput({ stream: streamName, text });
        } catch (error) {
          abandoned = true;
          stream.abort();

          void disconnect().catch(() => undefined);
          throw error;
        }
      };

      try {
        native = await sandbox.commands.run(script, {
          background: true,
          stdin: false,
          timeoutMs: 0,
          requestTimeoutMs: 30_000,
          cwd: options.cwd,
          envs: options.env,
          signal: stream.signal,
          onStdout: (text) => deliver("stdout", text),
          onStderr: (text) => deliver("stderr", text),
        });
        const handle = native;

        const confirmedExit = () =>
          Number.isSafeInteger(handle.exitCode) ? { exitCode: handle.exitCode! } : undefined;

        const wait = handle.wait().then(
          (result) => ({ exitCode: result.exitCode }),
          // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native wait rejects arbitrary values; only the pinned error class and public exitCode supply evidence.
          (error: unknown) => {
            if (error instanceof CommandExitError) return { exitCode: error.exitCode };

            const failure: ProcessObservationFailure = new AdapterError(
              "UNAVAILABLE",
              "E2B process observation failed",
            );

            failure.confirmedExit = confirmedExit();
            throw failure;
          },
        );

        void wait.catch(() => undefined);

        if (abandoned) void disconnect().catch(() => undefined);

        return {
          get confirmedExit() {
            return confirmedExit();
          },
          wait: () => wait,
          async terminate(ctx) {
            const killed = await sandbox.commands.kill(handle.pid, {
              signal: ctx.signal,
              requestTimeoutMs: Math.max(1, ctx.deadline - Date.now()),
            });

            return { status: killed ? "requested" : "not-found" };
          },
          detach: disconnect,
        };
      } finally {
        // Setup cancellation must not stay connected to an established stream.
        ctx.signal.removeEventListener("abort", stop);
      }
    },
    async run(id, script, options) {
      const sandbox = await attach(id);

      const result = await sandbox.commands.run(script, {
        cwd: options.cwd,
        envs: options.env,
        timeoutMs: options.timeoutMs,
        requestTimeoutMs: options.timeoutMs,
      });

      return result.stdout;
    },
    async read(id, path, maxBytes, signal) {
      signal?.throwIfAborted();
      const sandbox = await attach(id, undefined, signal);
      signal?.throwIfAborted();

      const stream = await sandbox.files.read(path, {
        format: "stream",
        requestTimeoutMs: 30_000,
        signal,
      });

      return collectBounded(stream, maxBytes, signal);
    },
    async write(id, path, bytes) {
      let stage: "connect" | "upload" = "connect";
      let httpStatus: number | undefined;

      const logger = {
        // The pinned SDK exposes response status here even when its error drops statusCode.
        // Ignore status text, trace IDs, bodies and all other logger arguments.
        error(label: string, status: number) {
          if (label === "Response:" && Number.isInteger(status) && status >= 100 && status <= 599)
            httpStatus = status;
        },
      };

      try {
        const sandbox = await attach(id, logger);
        stage = "upload";
        httpStatus = undefined;
        await sandbox.files.write(path, new Blob([new Uint8Array(bytes)]), {
          requestTimeoutMs: 30_000,
        });
      } catch (error) {
        throw new E2BWriteFailure(classifyWriteFailure(error, stage, httpStatus));
      }
    },
    async exists(id, path, signal) {
      // Attachment absence is a sandbox error, never a missing guest entry.
      const sandbox = await attach(id, undefined, signal);
      signal.throwIfAborted();

      try {
        return await sandbox.files.exists(path, { requestTimeoutMs: 30_000, signal });
      } catch (error) {
        if (error instanceof AuthenticationError)
          throw new AdapterError("FORBIDDEN", "E2B filesystem access rejected");
        throw new AdapterError("UNAVAILABLE", "E2B entry existence read failed");
      }
    },
    async makeDirectory(id, path, signal) {
      const sandbox = await attach(id, undefined, signal);
      signal.throwIfAborted();

      try {
        // The native call always creates ancestors; adapter preflight requires recursive:true.
        await sandbox.files.makeDir(path, { requestTimeoutMs: 30_000, signal });
      } catch (error) {
        if (error instanceof InvalidArgumentError) throw new E2BDirectoryRejected();
        throw error;
      }
    },
    async removeEntry(id, path, signal) {
      const sandbox = await attach(id, undefined, signal);
      signal.throwIfAborted();
      await sandbox.files.remove(path, { requestTimeoutMs: 30_000, signal });
    },
    async remove(id, path) {
      const sandbox = await attach(id);
      await sandbox.files.remove(path, { requestTimeoutMs: 30_000 });
    },
    close() {},
  };
}
