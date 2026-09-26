import { z } from "zod";
import {
  AcceptedExecution,
  AcceptedOperation,
  CreateProjectRequest,
  CreateProviderConnectionRequest,
  CreateSandboxRequest,
  ExecRequest,
  Execution,
  FileReceipt,
  Operation,
  Project as ProjectSchema,
  ProjectPage,
  ProviderConnection,
  ProviderConnectionPage,
  Sandbox,
  SandboxPage,
  SessionResponse,
} from "@sandbar/contracts";

export type Project = z.infer<typeof ProjectSchema>;
export type Connection = z.infer<typeof ProviderConnection>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

let csrfToken: string | undefined;
export function setCsrfToken(value: string | undefined) {
  csrfToken = value;
}

function notifyUnauthorized() {
  csrfToken = undefined;
  window.dispatchEvent(new Event("sandbar:session-expired"));
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const method = init.method?.toUpperCase() ?? "GET";
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof Uint8Array))
    headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD"].includes(method) && csrfToken)
    headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) {
    if (response.status === 401 && path !== "/v1/session") {
      notifyUnauthorized();
    }
    const raw: unknown = await response.json().catch(() => undefined);
    const parsed = z
      .object({
        error: z.object({
          code: z.string().optional(),
          message: z.string().optional(),
        }),
      })
      .safeParse(raw);
    throw new ApiError(
      parsed.success
        ? (parsed.data.error.message ?? `Request failed (${response.status})`)
        : `Request failed (${response.status})`,
      response.status,
      parsed.success ? parsed.data.error.code : undefined,
    );
  }
  const raw: unknown = await response.json();
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      "The service returned an unexpected response. Refresh or check the server version.",
      502,
      "INVALID_RESPONSE",
    );
  return parsed.data;
}

const json = (value: unknown) => JSON.stringify(value);
const base = (projectId: string) =>
  `/v1/projects/${encodeURIComponent(projectId)}`;
export function newInvocationKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const millis = Date.now();
  for (let i = 0; i < 6; i++)
    bytes[5 - i] = Math.floor(millis / 2 ** (i * 8)) & 255;
  bytes[6] = (bytes[6] & 15) | 0x70;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const api = {
  session: () => request("/v1/session", SessionResponse),
  setup: (setupToken: string) =>
    request("/v1/setup", SessionResponse, {
      method: "POST",
      body: json({ setupToken }),
    }),
  login: (token: string) =>
    request("/v1/sessions", SessionResponse, {
      method: "POST",
      body: json({ token }),
    }),
  logout: async () => {
    const response = await fetch("/v1/sessions/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: csrfToken ? { "X-CSRF-Token": csrfToken } : {},
    });
    if (!response.ok)
      throw new ApiError(
        `Sign out failed (${response.status})`,
        response.status,
      );
    csrfToken = undefined;
  },
  projects: () => request("/v1/projects", ProjectPage),
  createProject: (name: string) =>
    request("/v1/projects", ProjectSchema, {
      method: "POST",
      body: json(CreateProjectRequest.parse({ name })),
    }),
  connections: (projectId: string) =>
    request(`${base(projectId)}/provider-connections`, ProviderConnectionPage),
  createConnection: (projectId: string, name: string) =>
    request(`${base(projectId)}/provider-connections`, ProviderConnection, {
      method: "POST",
      body: json(
        CreateProviderConnectionRequest.parse({ provider: "fake", name }),
      ),
    }),
  verifyConnection: (projectId: string, connectionId: string) =>
    request(
      `${base(projectId)}/provider-connections/${encodeURIComponent(connectionId)}/verify`,
      ProviderConnection,
      { method: "POST" },
    ),
  sandboxes: (
    projectId: string,
    search: {
      state?: string;
      connectionId?: string;
      q?: string;
      cursor?: string;
    },
  ) => {
    const query = new URLSearchParams();
    Object.entries(search).forEach(([k, v]) => {
      if (v) query.set(k, v);
    });
    return request(`${base(projectId)}/sandboxes?${query}`, SandboxPage);
  },
  sandbox: (projectId: string, sandboxId: string) =>
    request(
      `${base(projectId)}/sandboxes/${encodeURIComponent(sandboxId)}`,
      Sandbox,
    ),
  createSandbox: (
    projectId: string,
    input: z.infer<typeof CreateSandboxRequest>,
    invocationKey: string,
  ) =>
    request(`${base(projectId)}/sandboxes`, AcceptedOperation, {
      method: "POST",
      headers: { "Idempotency-Key": invocationKey },
      body: json(CreateSandboxRequest.parse(input)),
    }),
  destroySandbox: (
    projectId: string,
    sandboxId: string,
    invocationKey: string,
  ) =>
    request(
      `${base(projectId)}/sandboxes/${encodeURIComponent(sandboxId)}`,
      AcceptedOperation,
      { method: "DELETE", headers: { "Idempotency-Key": invocationKey } },
    ),
  execute: (
    projectId: string,
    sandboxId: string,
    input: z.infer<typeof ExecRequest>,
    invocationKey: string,
  ) =>
    request(
      `${base(projectId)}/sandboxes/${encodeURIComponent(sandboxId)}/executions`,
      AcceptedExecution,
      {
        method: "POST",
        headers: { "Idempotency-Key": invocationKey },
        body: json(ExecRequest.parse(input)),
      },
    ),
  execution: (projectId: string, executionId: string) =>
    request(
      `${base(projectId)}/executions/${encodeURIComponent(executionId)}`,
      Execution,
    ),
  operation: (projectId: string, operationId: string) =>
    request(
      `${base(projectId)}/operations/${encodeURIComponent(operationId)}`,
      Operation,
    ),
  invocation: (
    projectId: string,
    invocationKey: string,
    kind: "create" | "exec" | "destroy" | "file_write",
    sandboxId?: string,
  ) => {
    const query = new URLSearchParams({ kind });
    if (sandboxId) query.set("sandboxId", sandboxId);
    return request(
      `${base(projectId)}/invocations/${encodeURIComponent(invocationKey)}?${query}`,
      Operation,
    );
  },
  reconcile: (projectId: string, operationId: string) =>
    request(
      `${base(projectId)}/operations/${encodeURIComponent(operationId)}/reconcile`,
      Operation,
      { method: "POST" },
    ),
  readFile: async (projectId: string, sandboxId: string, path: string) => {
    const response = await fetch(
      `${base(projectId)}/sandboxes/${encodeURIComponent(sandboxId)}/files?path=${encodeURIComponent(path)}`,
      { credentials: "same-origin" },
    );
    if (!response.ok) {
      if (response.status === 401) notifyUnauthorized();
      throw new ApiError(
        `File read failed (${response.status})`,
        response.status,
      );
    }
    return response.blob();
  },
  writeFile: (
    projectId: string,
    sandboxId: string,
    path: string,
    bytes: Uint8Array,
    invocationKey: string,
  ) =>
    request(
      `${base(projectId)}/sandboxes/${encodeURIComponent(sandboxId)}/files?path=${encodeURIComponent(path)}`,
      z.union([FileReceipt, AcceptedOperation]),
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Idempotency-Key": invocationKey,
        },
        body: bytes as BodyInit,
      },
    ),
};
