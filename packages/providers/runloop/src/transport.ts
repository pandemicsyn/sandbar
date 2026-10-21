import { AdapterError, type AdapterErrorCode } from "@sandbar-sdk/adapter";
import { z } from "zod";

/** Fixed Runloop API origin; it is not a project-controlled setting. */
export const RUNLOOP_API = "https://api.runloop.ai";

/** Largest JSON response body the adapter accepts, before decoding. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const Metadata = z.record(z.string(), z.string());

const AfterIdle = z.object({
  idle_time_seconds: z.number(),
  on_idle: z.enum(["shutdown", "suspend"]),
});

const LaunchParameters = z.object({
  after_idle: AfterIdle.nullish(),
  lifecycle: z.object({ after_idle: AfterIdle.nullish() }).nullish(),
  keep_alive_time_seconds: z.number().nullish(),
  network_policy_id: z.string().nullish(),
  resource_size_request: z.string().nullish(),
  custom_cpu_cores: z.number().nullish(),
  custom_gb_memory: z.number().nullish(),
});

export const Devbox = z.object({
  id: Id,
  status: z.string(),
  create_time_ms: z.number().nullish(),
  end_time_ms: z.number().nullish(),
  launch_parameters: LaunchParameters.nullish(),
  metadata: Metadata.nullish(),
  blueprint_id: z.string().nullish(),
  snapshot_id: z.string().nullish(),
  failure_reason: z.string().nullish(),
  shutdown_reason: z.string().nullish(),
  tunnel: z
    .object({
      auth_mode: z.enum(["open", "authenticated"]),
      tunnel_key: z.string(),
      auth_token: z.string().nullish(),
    })
    .nullish(),
});

export type Devbox = z.infer<typeof Devbox>;

export const Execution = z.object({
  devbox_id: z.string(),
  execution_id: Id,
  status: z.enum(["queued", "running", "completed"]),
  exit_status: z.number().int().nullish(),
  stdout: z.string().nullish(),
  stderr: z.string().nullish(),
  stdout_truncated: z.boolean().nullish(),
  stderr_truncated: z.boolean().nullish(),
});

export type Execution = z.infer<typeof Execution>;

export const Snapshot = z.object({
  id: Id,
  create_time_ms: z.number().nullish(),
  metadata: Metadata.nullish(),
  source_devbox_id: z.string(),
  name: z.string().nullish(),
  source_blueprint_id: z.string().nullish(),
});

export type Snapshot = z.infer<typeof Snapshot>;

export const SnapshotStatus = z.object({
  status: z.enum(["in_progress", "error", "complete", "deleted"]),
  error_message: z.string().nullish(),
  snapshot: Snapshot.nullish(),
});

export const NetworkPolicy = z.object({
  id: Id,
  name: z.string(),
  egress: z.object({
    allow_all: z.boolean(),
    allowed_hostnames: z.array(z.string()),
    allowed_cidrs: z.array(z.unknown()).default([]),
    allow_devbox_to_devbox: z.boolean(),
    allow_agent_gateway: z.boolean(),
    allow_mcp_gateway: z.boolean(),
    allow_runloop_mirrors: z.boolean().default(false),
  }),
});

export type NetworkPolicy = z.infer<typeof NetworkPolicy>;

export const Blueprint = z.object({
  id: Id,
  name: z.string(),
  state: z.string(),
  status: z.string(),
});

const Account = z.object({ id: z.string(), account_status: z.string() });

const page = <T extends z.ZodType>(key: string, item: T) =>
  z
    .object({ [key]: z.array(item).max(1000), has_more: z.boolean().default(false) })
    .transform((value) => ({
      // SAFETY: the schema above requires this key to hold an array of parsed items.
      items: value[key] as z.output<T>[],
      hasMore: value.has_more,
    }));

/** A non-2xx Runloop response; the body is kept only for redacted messages. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Runloop API ${status}`);
  }
}

const codes = new Map<number, AdapterErrorCode>([
  [400, "INVALID_ARGUMENT"],
  [401, "UNAUTHENTICATED"],
  [402, "CAPACITY"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [408, "TIMEOUT"],
  [409, "CONFLICT"],
  [413, "CAPACITY"],
  [422, "INVALID_ARGUMENT"],
  [429, "RATE_LIMIT"],
  [503, "UNAVAILABLE"],
  [504, "TIMEOUT"],
]);

/** Statuses that refuse a request before it takes effect. */
const definitive = new Set([400, 401, 402, 403, 404, 409, 413, 422, 429]);

export type NativeFailure = {
  /** HTTP status, or undefined when no response arrived. */
  status?: number;
  error: AdapterError;
};

function clean(text: string, secrets: readonly string[]): string {
  let value = text;

  for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[redacted]");

  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, 300);
}

const ErrorBody = z.object({
  message: z.string().optional(),
  error: z.unknown().optional(),
});

/** Normalize a client throw into a redacted AdapterError plus the HTTP status, if any. */
export function nativeFailure(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Fetch and client throws are parsed and redacted at this boundary.
  error: unknown,
  secrets: readonly string[],
): NativeFailure {
  if (error instanceof AdapterError) return { error };

  if (error instanceof HttpError) {
    let detail = "";

    try {
      const parsed = ErrorBody.safeParse(JSON.parse(error.body));

      if (parsed.success) {
        const nested = parsed.data.error;

        detail =
          parsed.data.message ??
          z.string().safeParse(nested).data ??
          z.object({ message: z.string() }).safeParse(nested).data?.message ??
          "";
      }
    } catch {
      /* A non-JSON error body keeps only the HTTP status. */
    }

    const code = codes.get(error.status) ?? (error.status >= 500 ? "UNAVAILABLE" : "INTERNAL");
    const message = clean(detail, secrets);

    return {
      status: error.status,
      error: new AdapterError(code, `Runloop API ${error.status}${message ? `: ${message}` : ""}`),
    };
  }

  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
    return { error: new AdapterError("TIMEOUT", "Runloop API request did not complete") };

  return { error: new AdapterError("UNAVAILABLE", "Runloop API request did not complete") };
}

/** True only when Runloop refused the request before it could take effect. */
export function refusedBeforeEffect(failure: NativeFailure): boolean {
  return failure.status !== undefined && definitive.has(failure.status);
}

/** Stream a response body into memory, failing once it passes the bound. */
async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) break;
      length += next.value.byteLength;

      if (length > limit)
        throw new AdapterError("CAPACITY", "Runloop response exceeds the adapter bound");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

type Query = Record<string, string | number | undefined>;

type Body = { json: string } | { form: FormData } | undefined;

export type LaunchParameters = {
  resource_size_request?: string;
  custom_cpu_cores?: number;
  custom_gb_memory?: number;
  keep_alive_time_seconds?: number;
  lifecycle?: { after_idle: { idle_time_seconds: number; on_idle: "shutdown" | "suspend" } };
  network_policy_id?: string;
};

export type CreateDevboxBody = {
  blueprint_id?: string;
  blueprint_name?: string;
  snapshot_id?: string;
  metadata: Record<string, string>;
  launch_parameters: LaunchParameters;
  tunnel: { auth_mode: "open" | "authenticated" };
  environment_variables?: Record<string, string>;
};

export type NetworkPolicyBody = {
  name: string;
  description: string;
  allow_all: boolean;
  allowed_hostnames: string[];
  allowed_cidrs: string[];
  allow_devbox_to_devbox: boolean;
  allow_agent_gateway: boolean;
  allow_mcp_gateway: boolean;
  allow_runloop_mirrors: boolean;
};

/**
 * One fetch per call: this client never retries. Redirects are refused so the API key
 * stays on the Runloop origin, and every response body is bounded before decoding.
 */
export function createRunloopClient(apiKey: string, fetch: Fetch = globalThis.fetch) {
  async function send(
    method: "GET" | "POST",
    path: string,
    signal: AbortSignal,
    query: Query = {},
    body: Body = undefined,
    accept = "application/json",
  ): Promise<Response> {
    const url = new URL(path, RUNLOOP_API);

    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));

    const headers = new Headers({ authorization: `Bearer ${apiKey}`, accept });
    let payload: BodyInit | undefined;

    if (body && "json" in body) {
      headers.set("content-type", "application/json");
      payload = body.json;
    } else if (body) payload = body.form;

    const init: RequestInit = { method, headers, signal, redirect: "error" };

    if (payload !== undefined) init.body = payload;
    const response = await fetch(url.toString(), init);

    if (!response.ok) {
      const text = new TextDecoder().decode(
        await readBounded(response, 64 * 1024).catch(() => new Uint8Array()),
      );

      throw new HttpError(response.status, text);
    }

    return response;
  }

  async function json<T extends z.ZodType>(
    schema: T,
    method: "GET" | "POST",
    path: string,
    signal: AbortSignal,
    query?: Query,
    body?: Body,
  ): Promise<z.output<T>> {
    const response = await send(method, path, signal, query, body);
    const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
    const text = new TextDecoder().decode(bytes);
    const parsed = schema.safeParse(text.trim() ? JSON.parse(text) : null);

    if (!parsed.success)
      throw new AdapterError(
        "INTERNAL",
        `Runloop returned an unexpected response for ${method} ${path.replace(/\/[A-Za-z0-9_-]{8,}/g, "/:id")}`,
      );

    return parsed.data;
  }

  const encode = encodeURIComponent;

  return {
    me: (signal: AbortSignal) => json(Account, "GET", "/v1/accounts/me", signal),
    createDevbox: (body: CreateDevboxBody, signal: AbortSignal) =>
      json(Devbox, "POST", "/v1/devboxes", signal, {}, { json: JSON.stringify(body) }),
    getDevbox: (id: string, signal: AbortSignal) =>
      json(Devbox, "GET", `/v1/devboxes/${encode(id)}`, signal),
    listDevboxes: (query: { limit: number; starting_after?: string }, signal: AbortSignal) =>
      json(page("devboxes", Devbox), "GET", "/v1/devboxes", signal, {
        ...query,
        include_total_count: "false",
      }),
    shutdown: (id: string, signal: AbortSignal) =>
      json(Devbox, "POST", `/v1/devboxes/${encode(id)}/shutdown`, signal, { force: "false" }),
    suspend: (id: string, signal: AbortSignal) =>
      json(Devbox, "POST", `/v1/devboxes/${encode(id)}/suspend`, signal),
    resume: (id: string, signal: AbortSignal) =>
      json(Devbox, "POST", `/v1/devboxes/${encode(id)}/resume`, signal),
    execute: (
      id: string,
      body: { command: string; command_id: string; optimistic_timeout: number },
      signal: AbortSignal,
    ) =>
      json(
        Execution,
        "POST",
        `/v1/devboxes/${encode(id)}/execute`,
        signal,
        { last_n: "8" },
        { json: JSON.stringify(body) },
      ),
    waitForCommand: (id: string, execution: string, seconds: number, signal: AbortSignal) =>
      json(
        Execution,
        "POST",
        `/v1/devboxes/${encode(id)}/executions/${encode(execution)}/wait_for_status`,
        signal,
        { last_n: "8" },
        { json: JSON.stringify({ statuses: ["completed"], timeout_seconds: seconds }) },
      ),
    /** Server-sent log updates for one stream; the caller reads and bounds the body. */
    streamUpdates: (
      id: string,
      execution: string,
      stream: "stdout" | "stderr",
      offset: number,
      signal: AbortSignal,
    ) =>
      send(
        "GET",
        `/v1/devboxes/${encode(id)}/executions/${encode(execution)}/stream_${stream}_updates`,
        signal,
        { offset },
        undefined,
        "text/event-stream",
      ),
    killExecution: (id: string, execution: string, signal: AbortSignal) =>
      json(
        Execution,
        "POST",
        `/v1/devboxes/${encode(id)}/executions/${encode(execution)}/kill`,
        signal,
        {},
        { json: JSON.stringify({ kill_process_group: true }) },
      ),
    async uploadFile(id: string, path: string, bytes: Uint8Array, signal: AbortSignal) {
      const form = new FormData();
      form.set("path", path);
      // SAFETY: a fresh copy is backed by an ArrayBuffer, which Blob accepts.
      form.set("file", new Blob([new Uint8Array(bytes) as Uint8Array<ArrayBuffer>]), "file");

      const response = await send(
        "POST",
        `/v1/devboxes/${encode(id)}/upload_file`,
        signal,
        {},
        {
          form,
        },
      );

      await response.body?.cancel().catch(() => undefined);
    },
    async downloadFile(id: string, path: string, limit: number, signal: AbortSignal) {
      const response = await send(
        "POST",
        `/v1/devboxes/${encode(id)}/download_file`,
        signal,
        {},
        { json: JSON.stringify({ path }) },
        "application/octet-stream",
      );

      return readBounded(response, limit);
    },
    snapshotDiskAsync: (id: string, metadata: Record<string, string>, signal: AbortSignal) =>
      json(
        Snapshot,
        "POST",
        `/v1/devboxes/${encode(id)}/snapshot_disk_async`,
        signal,
        {},
        { json: JSON.stringify({ metadata }) },
      ),
    snapshotStatus: (id: string, signal: AbortSignal) =>
      json(SnapshotStatus, "GET", `/v1/devboxes/disk_snapshots/${encode(id)}/status`, signal),
    listSnapshots: (query: Query, signal: AbortSignal) =>
      json(page("snapshots", Snapshot), "GET", "/v1/devboxes/disk_snapshots", signal, {
        ...query,
        include_total_count: "false",
      }),
    async deleteSnapshot(id: string, signal: AbortSignal) {
      const response = await send(
        "POST",
        `/v1/devboxes/disk_snapshots/${encode(id)}/delete`,
        signal,
      );

      await response.body?.cancel().catch(() => undefined);
    },
    listNetworkPolicies: (query: { name: string; limit: number }, signal: AbortSignal) =>
      json(page("network_policies", NetworkPolicy), "GET", "/v1/network-policies", signal, {
        ...query,
        include_total_count: "false",
      }),
    getNetworkPolicy: (id: string, signal: AbortSignal) =>
      json(NetworkPolicy, "GET", `/v1/network-policies/${encode(id)}`, signal),
    createNetworkPolicy: (body: NetworkPolicyBody, signal: AbortSignal) =>
      json(
        NetworkPolicy,
        "POST",
        "/v1/network-policies",
        signal,
        {},
        { json: JSON.stringify(body) },
      ),
    getBlueprint: (id: string, signal: AbortSignal) =>
      json(Blueprint, "GET", `/v1/blueprints/${encode(id)}`, signal),
    listBlueprints: (query: { name: string; limit: number }, signal: AbortSignal) =>
      json(page("blueprints", Blueprint), "GET", "/v1/blueprints", signal, {
        ...query,
        include_total_count: "false",
      }),
  };
}

export type RunloopClient = ReturnType<typeof createRunloopClient>;
