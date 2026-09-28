import { AdapterSandbox, SandbarError, UnsupportedFeatureError } from "sandbar-sdk";
import { AdapterError } from "sandbar-adapter";
import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import {
  Capabilities,
  SnapshotCheck,
  CreateCheck,
  SnapshotRequest,
  AcceptedExecution,
  AcceptedOperation,
  CreateProjectRequest,
  CreateProviderConnectionRequest,
  CreateSandboxRequest,
  ErrorResponse,
  ExecRequest,
  Execution,
  FileReceipt,
  ImageBuildRequest,
  FileWriteQuery,
  Id,
  InvocationKey,
  Operation,
  ProjectPage,
  ProviderConnection,
  ProviderConnectionPage,
  ProviderCatalog,
  Sandbox,
  SandboxListQuery,
  SandboxPage,
  SessionRequest,
  SessionResponse,
  SetupRequest,
  intentSha256,
} from "../http-contracts";
import { ProviderReadError, type NativeScope, type SandboxRef } from "@sandbar/provider-spi";
import {
  ControlStore,
  StoreError,
  type ConnectionRow,
  type ExecutionRow,
  type OperationRow,
  type SandboxRow,
} from "@sandbar/store";
import { sha256 } from "@sandbar/core";
import {
  DurableRunner,
  SecretBox,
  ProviderRegistry,
  type AdapterProviderLease,
  ProviderConfigurationError,
  storedScope,
  publicScope,
} from "@sandbar/service-runtime";

export interface DomainDependencies {
  store: ControlStore;
  registry: ProviderRegistry;
  secrets: SecretBox;
  setupToken: string;
  runner?: DurableRunner;
  publicOrigin?: string;
}

type Auth = { kind: "bearer" } | { kind: "session"; idHash: string; csrfHash: string };

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonRequestBody = { [key: string]: JsonValue };

const sessionMs = 12 * 60 * 60 * 1000;

const publicJsonBodyLimit = 64 * 1024;

function safeError(code: string, message: string, effect: "none" | "possible" = "none") {
  return { code, message, effect, retry: effect === "possible" ? "observe_only" : "never" };
}

function errorResponse(c: Context, error: Error | z.ZodError): Response {
  if (error instanceof SandbarError)
    return c.json(
      ErrorResponse.parse({
        error: {
          ...safeError(error.code, error.message.slice(0, 1024)),
          feature: error instanceof UnsupportedFeatureError ? error.feature : undefined,
          unmetRequirements:
            error instanceof UnsupportedFeatureError ? [...error.unmetRequirements] : undefined,
        },
      }),
      error.code === "FORBIDDEN" ? 403 : error.code === "UNSUPPORTED" ? 422 : 400,
    );

  if (error instanceof AdapterError)
    return c.json(
      ErrorResponse.parse({
        error: safeError(error.code, "Adapter input or connection is invalid"),
      }),
      error.code === "UNAUTHENTICATED" ? 401 : error.code === "UNSUPPORTED" ? 422 : 400,
    );

  if (error instanceof ProviderConfigurationError)
    return c.json(
      ErrorResponse.parse({ error: safeError("INVALID_ARGUMENT", "Invalid request") }),
      400,
    );

  if (error instanceof ProviderReadError && error.code === "UNAUTHENTICATED")
    return c.json(
      ErrorResponse.parse({ error: safeError("UNAUTHENTICATED", "Provider credential rejected") }),
      401,
    );

  if (error instanceof ProviderReadError && error.code === "NOT_FOUND")
    return c.json(
      ErrorResponse.parse({ error: safeError("NOT_FOUND", "Provider file not found") }),
      404,
    );

  if (error instanceof StoreError) {
    // SAFETY: StoreError.code is limited to the five keys in this status map.
    const status = {
      NOT_FOUND: 404,
      CONFLICT: 409,
      CAPACITY: 409,
      OUTPUT_CAPACITY: 409,
      INVOCATION_EXPIRED: 410,
      UNAUTHENTICATED: 401,
    }[error.code] as 401 | 404 | 409 | 410;

    return c.json(ErrorResponse.parse({ error: safeError(error.code, error.message) }), status);
  }

  if (error instanceof SyntaxError || error instanceof z.ZodError) {
    return c.json(
      ErrorResponse.parse({ error: safeError("INVALID_ARGUMENT", "Invalid request") }),
      400,
    );
  }

  return c.json(
    ErrorResponse.parse({ error: safeError("INTERNAL", "Internal service error") }),
    500,
  );
}

function equalHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex"),
    right = Buffer.from(b, "hex");

  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieName(c: Context, deps: DomainDependencies): string {
  return new URL(deps.publicOrigin ?? c.req.url).protocol === "https:"
    ? "__Host-sandbar_session"
    : "sandbar_session";
}

function putCookie(c: Context, deps: DomainDependencies, token: string): void {
  setCookie(c, cookieName(c, deps), token, {
    httpOnly: true,
    secure: new URL(deps.publicOrigin ?? c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    maxAge: sessionMs / 1000,
  });
}

function originOkay(c: Context, deps: DomainDependencies): boolean {
  const origin = c.req.header("origin");

  return !origin || origin === new URL(deps.publicOrigin ?? c.req.url).origin;
}

async function parseBody<T>(
  c: Context,
  schema: { parse(input: JsonRequestBody): T },
  maxBytes?: number,
): Promise<T> {
  const type = c.req.header("content-type")?.split(";")[0];

  if (type !== "application/json") throw new SyntaxError("JSON required");

  const body =
    maxBytes === undefined
      ? await c.req.json()
      : JSON.parse(
          new TextDecoder().decode(
            await boundedBody(c, maxBytes, "JSON body exceeds 64 KiB limit"),
          ),
        );

  return schema.parse(body);
}

function idParam(c: Context, name: string): string {
  return Id.parse(c.req.param(name));
}

function opDto(row: OperationRow) {
  let result: object | undefined;

  if (row.status === "succeeded" && row.result_json) {
    // SAFETY: This is the stored provider observation written by ControlStore.complete.
    const native = JSON.parse(row.result_json) as { kind: string; observation: any };

    if (row.kind === "create") result = { kind: "create", sandboxId: row.sandbox_id };

    if (row.kind === "exec") result = { kind: "exec", executionId: row.execution_id };

    if (row.kind === "destroy")
      result = {
        kind: "destroy",
        computeStopped: native.observation.computeStopped,
        retainedResources: native.observation.retainedResources,
      };

    if (row.kind === "file_write")
      result = {
        kind: "file_write",
        receipt: {
          path: native.observation.path,
          bytesWritten: native.observation.bytesWritten,
          complete: native.observation.complete,
          effect: row.effect,
        },
      };

    if (row.kind === "image_build")
      result = {
        kind: "image_build",
        prepared: {
          kind: "prepared",
          value: native.observation.preparedId,
          provider: native.observation.provider,
          scope: native.observation.scope,
          connectionId: row.connection_id,
        },
        retainedResources: native.observation.retainedResources,
      };
  }

  const dto = {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    phase: row.phase,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    effect: row.effect,
    recovery: row.status === "unknown" ? ["check_again"] : [],
  };

  if (row.sandbox_id) Object.assign(dto, { sandboxId: row.sandbox_id });

  if (row.execution_id) Object.assign(dto, { executionId: row.execution_id });

  if (row.error_json) Object.assign(dto, { error: JSON.parse(row.error_json) });

  if (result) Object.assign(dto, { result });

  return Operation.parse(dto);
}

function connectionDto(row: ConnectionRow) {
  const dto = {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    name: row.name,
    status: row.status,
  };

  if (row.scope)
    Object.assign(dto, {
      nativeScope: publicScope(row.scope),
    });

  return ProviderConnection.parse(dto);
}

async function sandboxDto(store: ControlStore, row: SandboxRow) {
  const creation = await store.getOperation(row.project_id, row.create_operation_id);
  const active = await store.getActiveOperation(row.project_id, row.id);

  if (!creation) throw new Error("Creation intent is missing");
  // SAFETY: Admission persisted a validated create request for this sandbox.
  const request = JSON.parse(creation.request_json) as { environment: unknown; network: unknown };

  const dto = {
    id: row.id,
    projectId: row.project_id,
    connectionId: row.connection_id,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    revision: Number(row.revision),
    environment: request.environment,
    network: request.network,
    labels: JSON.parse(row.labels_json),
  };

  if (row.observed_at)
    Object.assign(dto, { observedAt: new Date(Number(row.observed_at)).toISOString() });

  if (active) Object.assign(dto, { currentOperationId: active.id });

  return Sandbox.parse(dto);
}

async function executionDto(deps: DomainDependencies, row: ExecutionRow) {
  let stdoutBase64: string | undefined, stderrBase64: string | undefined;

  if (row.output_ciphertext) {
    // SAFETY: ControlStore writes this encrypted payload with the two Base64 fields.
    const payload = JSON.parse(
      await deps.secrets.open("execution-output", row.id, row.output_ciphertext),
    ) as { stdoutBase64: string; stderrBase64: string };

    stdoutBase64 = payload.stdoutBase64;
    stderrBase64 = payload.stderrBase64;
  }

  const dto = {
    id: row.id,
    projectId: row.project_id,
    sandboxId: row.sandbox_id,
    operationId: row.operation_id,
    status: row.status,
    outputAvailability: row.output_state,
    capturedBytes: Number(row.output_bytes),
  };

  if (row.exit_code !== null) Object.assign(dto, { exitCode: Number(row.exit_code) });

  if (row.signal) Object.assign(dto, { signal: row.signal });

  if (stdoutBase64 !== undefined) Object.assign(dto, { stdoutBase64 });

  if (stderrBase64 !== undefined) Object.assign(dto, { stderrBase64 });

  return Execution.parse(dto);
}

async function auth(
  c: Context,
  deps: DomainDependencies,
  mutate: boolean,
): Promise<Auth | Response> {
  const authorization = c.req.header("authorization");

  if (authorization?.startsWith("Bearer ")) {
    if (await deps.store.authenticateBearer(await sha256(authorization.slice(7))))
      return { kind: "bearer" };

    return c.json(
      ErrorResponse.parse({ error: safeError("UNAUTHENTICATED", "Invalid bearer token") }),
      401,
    );
  }

  const cookie = getCookie(c, cookieName(c, deps));

  if (!cookie)
    return c.json(
      ErrorResponse.parse({ error: safeError("UNAUTHENTICATED", "Authentication required") }),
      401,
    );

  const idHash = await sha256(cookie),
    session = await deps.store.getSession(idHash);

  if (!session)
    return c.json(
      ErrorResponse.parse({ error: safeError("UNAUTHENTICATED", "Session expired") }),
      401,
    );

  if (mutate) {
    const csrf = c.req.header("x-csrf-token");

    if (!originOkay(c, deps) || !csrf || !equalHash(await sha256(csrf), session.csrf_hash))
      return c.json(
        ErrorResponse.parse({ error: safeError("FORBIDDEN", "CSRF or Origin check failed") }),
        403,
      );
  }

  return { kind: "session", idHash, csrfHash: session.csrf_hash };
}

function protect(
  deps: DomainDependencies,
  mutate: boolean,
  handler: (c: Context, a: Auth) => Promise<Response>,
): (c: Context) => Promise<Response> {
  return async (c) => {
    try {
      const a = await auth(c, deps, mutate);

      return a instanceof Response ? a : await handler(c, a);
    } catch (error) {
      return errorResponse(
        c,
        error instanceof Error || error instanceof z.ZodError
          ? error
          : new Error("Unknown failure"),
      );
    }
  };
}

function accepted(
  c: Context,
  op: OperationRow,
  execution?: ReturnType<typeof Execution.parse>,
): Response {
  c.header("Location", `/v1/projects/${op.project_id}/operations/${op.id}`);

  return c.json(
    execution
      ? AcceptedExecution.parse({ operation: opDto(op), execution })
      : AcceptedOperation.parse({ operation: opDto(op) }),
    202,
  );
}

function nativeRef(box: SandboxRow, scope: NativeScope): SandboxRef {
  if (!box.native_id) throw new StoreError("CONFLICT", "Sandbox has no verified native identity");

  return { scope, nativeId: box.native_id, kind: "sandbox" };
}

function providerAvailable(deps: DomainDependencies, provider: string): boolean {
  return deps.registry.has(provider);
}

async function withProvider<T>(
  deps: DomainDependencies,
  connection: ConnectionRow,
  use: (lease: AdapterProviderLease) => Promise<T>,
): Promise<T> {
  const lease = await deps.registry.connect(connection);

  try {
    return await use(lease);
  } finally {
    try {
      await lease.release();
    } catch {
      console.error("Provider transport release failed");
    }
  }
}

function filePath(c: Context): string {
  const path = new URL(c.req.url).searchParams.get("path");

  if (
    !path ||
    path.length > 4096 ||
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === ".." || part === ".")
  )
    throw new SyntaxError("Invalid path");

  return path;
}

function fileWriteQuery(c: Context) {
  const params = new URL(c.req.url).searchParams;

  if ([...params.keys()].length !== new Set(params.keys()).size)
    throw new SyntaxError("Duplicate query parameter");
  const query = FileWriteQuery.parse(Object.fromEntries(params));
  const path = filePath(c);

  return { path, overwrite: query.overwrite === "true" };
}

async function boundedBody(
  c: Context,
  maxBytes: number,
  message = "File exceeds buffered write limit",
): Promise<Uint8Array> {
  const length = Number(c.req.header("content-length") ?? 0);

  if (length > maxBytes) {
    await c.req.raw.body?.cancel();
    throw new StoreError("CAPACITY", message);
  }

  const reader = c.req.raw.body?.getReader();

  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;
    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel();
      throw new StoreError("CAPACITY", message);
    }

    parts.push(value);
  }

  const all = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    all.set(part, offset);
    offset += part.byteLength;
  }

  return all;
}

export function registerDomainRoutes(app: Hono, deps: DomainDependencies): void {
  app.post("/v1/setup", async (c) => {
    try {
      if (!originOkay(c, deps))
        return c.json(
          ErrorResponse.parse({ error: safeError("FORBIDDEN", "Origin check failed") }),
          403,
        );
      const body = await parseBody(c, SetupRequest, publicJsonBodyLimit);

      if (body.setupToken !== deps.setupToken)
        return c.json(
          ErrorResponse.parse({ error: safeError("UNAUTHENTICATED", "Invalid setup token") }),
          401,
        );
      const token = `sdb_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;

      const sessionId = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        "base64url",
      );

      const csrfToken = await deps.secrets.sessionCsrfToken(sessionId);
      await deps.store.setupOperator(
        await sha256(token),
        await sha256(sessionId),
        await sha256(csrfToken),
        Date.now() + sessionMs,
      );
      putCookie(c, deps, sessionId);
      c.header("Cache-Control", "no-store");

      return c.json(SessionResponse.parse({ operatorId: "operator", csrfToken, token }), 201);
    } catch (error) {
      return errorResponse(
        c,
        error instanceof Error || error instanceof z.ZodError
          ? error
          : new Error("Unknown failure"),
      );
    }
  });
  app.post("/v1/sessions", async (c) => {
    try {
      if (!originOkay(c, deps))
        return c.json(
          ErrorResponse.parse({ error: safeError("FORBIDDEN", "Origin check failed") }),
          403,
        );
      const body = await parseBody(c, SessionRequest, publicJsonBodyLimit);

      if (!(await deps.store.authenticateBearer(await sha256(body.token))))
        return c.json(
          ErrorResponse.parse({ error: safeError("UNAUTHENTICATED", "Invalid token") }),
          401,
        );

      const sessionId = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        "base64url",
      );

      const csrfToken = await deps.secrets.sessionCsrfToken(sessionId);
      await deps.store.createSession(
        await sha256(sessionId),
        await sha256(csrfToken),
        Date.now() + sessionMs,
      );
      putCookie(c, deps, sessionId);
      c.header("Cache-Control", "no-store");

      return c.json(SessionResponse.parse({ operatorId: "operator", csrfToken }), 201);
    } catch (error) {
      return errorResponse(
        c,
        error instanceof Error || error instanceof z.ZodError
          ? error
          : new Error("Unknown failure"),
      );
    }
  });
  app.get(
    "/v1/session",
    protect(deps, false, async (c, a) => {
      if (a.kind !== "session")
        return c.json(
          ErrorResponse.parse({ error: safeError("FORBIDDEN", "Session required") }),
          403,
        );
      const csrfToken = await deps.secrets.sessionCsrfToken(getCookie(c, cookieName(c, deps))!);
      c.header("Cache-Control", "no-store");

      return c.json(SessionResponse.parse({ operatorId: "operator", csrfToken }));
    }),
  );
  app.post(
    "/v1/sessions/logout",
    protect(deps, true, async (c, a) => {
      if (a.kind === "session") await deps.store.deleteSession(a.idHash);
      deleteCookie(c, cookieName(c, deps), {
        path: "/",
        secure: new URL(deps.publicOrigin ?? c.req.url).protocol === "https:",
      });

      return c.body(null, 204);
    }),
  );

  app.post(
    "/v1/projects",
    protect(deps, true, async (c) =>
      c.json(await deps.store.createProject((await parseBody(c, CreateProjectRequest)).name), 201),
    ),
  );
  app.get(
    "/v1/projects",
    protect(deps, false, async (c) =>
      c.json(ProjectPage.parse({ items: await deps.store.listProjects() })),
    ),
  );
  app.get(
    "/v1/providers",
    protect(deps, false, async (c) =>
      c.json(ProviderCatalog.parse({ items: deps.registry?.catalog() ?? [] })),
    ),
  );
  app.post(
    "/v1/projects/:projectId/provider-connections",
    protect(deps, true, async (c) => {
      const projectId = idParam(c, "projectId"),
        body = await parseBody(c, CreateProviderConnectionRequest);

      const id = `conn_${crypto.randomUUID().replaceAll("-", "")}`;

      const raw = structuredClone({
        credentials: body.credentials === undefined ? {} : body.credentials,
        configuration: body.configuration === undefined ? {} : body.configuration,
      });

      deps.registry?.validate(body.provider, structuredClone(raw));

      if (!deps.registry && (body.provider !== "fake" || body.credentials || body.configuration))
        throw new SyntaxError("Provider is not configured");

      const encryptedCredentials = await deps.secrets.seal(
        "provider-connection",
        id,
        JSON.stringify(raw),
      );

      const row = await deps.store.createConnection({
        id,
        projectId,
        provider: body.provider,
        name: body.name,
        encryptedCredentials,
      });

      return c.json(connectionDto(row), 201);
    }),
  );
  app.get(
    "/v1/projects/:projectId/provider-connections",
    protect(deps, false, async (c) =>
      c.json(
        ProviderConnectionPage.parse({
          items: (await deps.store.listConnections(idParam(c, "projectId"))).map(connectionDto),
        }),
      ),
    ),
  );
  app.post(
    "/v1/projects/:projectId/provider-connections/:connectionId/verify",
    protect(deps, true, async (c) => {
      const projectId = idParam(c, "projectId"),
        connectionId = idParam(c, "connectionId");

      const row = await deps.store.getConnection(projectId, connectionId);

      if (!row) throw new StoreError("NOT_FOUND", "Connection not found");

      return withProvider(deps, row, async ({ driver, scope }) => {
        const capabilities = await driver.capabilities();

        if (capabilities.provider !== row.provider)
          throw new StoreError("CONFLICT", "Provider identity mismatch");

        return c.json(
          connectionDto(
            await deps.store.verifyConnection(
              projectId,
              connectionId,
              deps.registry ? storedScope(scope) : scope.accountId!,
            ),
          ),
        );
      });
    }),
  );

  const selectConnection = async (projectId: string, connectionId?: string) => {
    const rows = connectionId
      ? [await deps.store.getConnection(projectId, connectionId)]
      : await deps.store.listConnections(projectId);

    const row = rows
      .filter((row): row is ConnectionRow => !!row)
      .sort((a, b) => Number(a.created_at) - Number(b.created_at) || a.id.localeCompare(b.id))
      .find((row) => row.status === "verified" && deps.registry.has(row.provider));

    if (!row) throw new StoreError("CONFLICT", "No verified provider connection is available");

    return row;
  };

  const checkCreateBody = async (projectId: string, body: z.infer<typeof CreateSandboxRequest>) => {
    const connection = await selectConnection(projectId, body.connectionId);

    return withProvider(deps, connection, async ({ adapterConnection }) => {
      if (
        body.preparedBinding &&
        (body.environment.kind !== "prepared" ||
          body.preparedBinding.connectionId !== connection.id)
      )
        throw new AdapterError("CONFLICT", "Prepared image connection does not match");

      return adapterConnection.sandboxes.checkCreate({
        environment:
          body.environment.kind === "prepared"
            ? {
                kind: "prepared",
                value: body.environment.imageId,
                binding: body.preparedBinding
                  ? { provider: body.preparedBinding.provider, scope: body.preparedBinding.scope }
                  : undefined,
              }
            : { kind: "oci", value: body.environment.reference },
        networkPolicy: body.network?.policy,
        region: body.region,
        labels: body.labels,
        requirements: body.requirements,
      });
    });
  };

  app.get(
    "/v1/projects/:projectId/capabilities",
    protect(deps, false, async (c) => {
      const row = await selectConnection(idParam(c, "projectId"), c.req.query("connectionId"));

      return withProvider(deps, row, async ({ adapterConnection }) =>
        c.json(Capabilities.parse(await adapterConnection.capabilities())),
      );
    }),
  );
  app.post(
    "/v1/projects/:projectId/sandboxes/check-create",
    protect(deps, false, async (c) =>
      c.json(
        CreateCheck.parse(
          await checkCreateBody(idParam(c, "projectId"), await parseBody(c, CreateSandboxRequest)),
        ),
      ),
    ),
  );
  app.get(
    "/v1/projects/:projectId/sandboxes/:sandboxId/capabilities",
    protect(deps, false, async (c) => {
      const projectId = idParam(c, "projectId");
      const box = await deps.store.getSandbox(projectId, idParam(c, "sandboxId"));

      if (!box?.native_id) throw new StoreError("CONFLICT", "Sandbox is not available");
      const row = await selectConnection(projectId, box.connection_id);

      return withProvider(deps, row, async ({ adapterConnection }) =>
        c.json(
          Capabilities.parse(
            await new AdapterSandbox(adapterConnection, box.native_id!).capabilities(),
          ),
        ),
      );
    }),
  );
  app.post(
    "/v1/projects/:projectId/sandboxes/:sandboxId/check-snapshot",
    protect(deps, false, async (c) => {
      const projectId = idParam(c, "projectId");
      const request = await parseBody(c, SnapshotRequest);
      const box = await deps.store.getSandbox(projectId, idParam(c, "sandboxId"));

      if (!box?.native_id) throw new StoreError("CONFLICT", "Sandbox is not available");
      const row = await selectConnection(projectId, box.connection_id);

      return withProvider(deps, row, async ({ adapterConnection }) =>
        c.json(
          SnapshotCheck.parse(
            await new AdapterSandbox(adapterConnection, box.native_id!).checkSnapshot(request),
          ),
        ),
      );
    }),
  );

  app.post(
    "/v1/projects/:projectId/sandboxes",
    protect(deps, true, async (c) => {
      const projectId = idParam(c, "projectId"),
        key = InvocationKey.parse(c.req.header("idempotency-key"));

      const body = await parseBody(c, CreateSandboxRequest);

      if (body.preparedBinding) {
        if (
          body.environment.kind !== "prepared" ||
          !body.connectionId ||
          body.connectionId !== body.preparedBinding.connectionId
        )
          throw new AdapterError("CONFLICT", "Prepared image connection does not match");

        const connection = await deps.store.getConnection(projectId, body.connectionId);
        const scope = connection?.scope ? publicScope(connection.scope).adapterScope : undefined;

        const canonical = (value: NonNullable<typeof scope>) =>
          JSON.stringify({
            authority: value.authority,
            partition: Object.fromEntries(
              Object.entries(value.partition).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            ),
          });

        if (
          !connection ||
          connection.status !== "verified" ||
          connection.provider !== body.preparedBinding.provider ||
          !scope ||
          canonical(scope) !== canonical(body.preparedBinding.scope)
        )
          throw new AdapterError("CONFLICT", "Prepared image scope differs from connection");
      }

      if (
        body.requirements &&
        !(await deps.store.lookupInvocation(projectId, "POST /sandboxes", key))
      ) {
        const check = await checkCreateBody(projectId, body);

        if (check.status === "unsupported")
          throw new UnsupportedFeatureError("create", [check.reason]);

        if (check.status !== "supported") throw new AdapterError("UNAVAILABLE", check.reason);
      }

      const admission = await deps.store.admitCreate({
        projectId,
        endpoint: "POST /sandboxes",
        key,
        intentHash: await intentSha256(body),
        request: body,
        connectionId: body.connectionId,
        providerAvailable: (provider) => providerAvailable(deps, provider),
      });

      return accepted(c, admission.operation);
    }),
  );
  app.post(
    "/v1/projects/:projectId/images/builds",
    protect(deps, true, async (c) => {
      const projectId = idParam(c, "projectId");
      const key = InvocationKey.parse(c.req.header("idempotency-key"));
      const body = await parseBody(c, ImageBuildRequest);

      const admission = await deps.store.admitImageBuild({
        projectId,
        endpoint: "POST /images/builds",
        key,
        intentHash: await intentSha256(body),
        request: { source: body.source },
        connectionId: body.connectionId,
        providerAvailable: (provider) => providerAvailable(deps, provider),
      });

      return accepted(c, admission.operation);
    }),
  );
  app.get(
    "/v1/projects/:projectId/sandboxes",
    protect(deps, false, async (c) => {
      const projectId = idParam(c, "projectId"),
        params = new URL(c.req.url).searchParams;

      for (const key of params.keys())
        if (params.getAll(key).length !== 1) throw new SyntaxError("Duplicate query parameter");

      const rawQuery = Object.fromEntries(params);

      if (rawQuery.limit !== undefined && !/^[1-9][0-9]*$/.test(rawQuery.limit))
        throw new SyntaxError("Invalid limit");

      const query = SandboxListQuery.parse({
        ...rawQuery,
        limit: rawQuery.limit === undefined ? undefined : Number(rawQuery.limit),
      });

      const { state, connectionId, q, cursor } = query;
      const limit = query.limit ?? 50;
      let before: { createdAt: number; id: string } | undefined;

      if (cursor !== undefined) {
        try {
          if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor))
            throw new SyntaxError("Invalid cursor");
          const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
          const createdAt = decoded?.createdAt;

          if (!Number.isSafeInteger(createdAt) || createdAt < 0)
            throw new SyntaxError("Invalid cursor");
          const id = Id.parse(decoded?.id);
          before = { createdAt, id };
        } catch {
          throw new SyntaxError("Invalid cursor");
        }
      }

      const rows = await deps.store.listSandboxes(projectId, limit + 1, before, {
        state,
        connectionId,
        q,
      });

      const page = rows.slice(0, limit);
      const last = page.at(-1);

      const pageDto = {
        items: await Promise.all(page.map((row) => sandboxDto(deps.store, row))),
        asOf: new Date().toISOString(),
      };

      if (rows.length > limit && last)
        Object.assign(pageDto, {
          nextCursor: Buffer.from(
            JSON.stringify({ createdAt: Number(last.created_at), id: last.id }),
          ).toString("base64url"),
        });

      return c.json(SandboxPage.parse(pageDto));
    }),
  );
  app.get(
    "/v1/projects/:projectId/sandboxes/:sandboxId",
    protect(deps, false, async (c) => {
      const row = await deps.store.getSandbox(idParam(c, "projectId"), idParam(c, "sandboxId"));

      if (!row) throw new StoreError("NOT_FOUND", "Sandbox not found");

      return c.json(await sandboxDto(deps.store, row));
    }),
  );
  app.post(
    "/v1/projects/:projectId/sandboxes/:sandboxId/executions",
    protect(deps, true, async (c) => {
      const projectId = idParam(c, "projectId"),
        sandboxId = idParam(c, "sandboxId"),
        key = InvocationKey.parse(c.req.header("idempotency-key"));

      const body = await parseBody(c, ExecRequest);

      const captureBytes =
        body.output?.capture === "none" ? 0 : (body.output?.maxBytes ?? 1_048_576);

      const encryptedRequest = await deps.secrets.seal(
        "execution-request",
        `${sandboxId}:${key}`,
        JSON.stringify(body),
      );

      const admitted = await deps.store.admitExec({
        projectId,
        sandboxId,
        endpoint: `POST /sandboxes/${sandboxId}/executions`,
        key,
        intentHash: await intentSha256(body),
        encryptedRequest,
        output: body.output,
        captureBytes,
        providerAvailable: (provider) => providerAvailable(deps, provider),
      });

      return accepted(c, admitted.operation, await executionDto(deps, admitted.execution!));
    }),
  );
  app.get(
    "/v1/projects/:projectId/executions/:executionId",
    protect(deps, false, async (c) => {
      const row = await deps.store.getExecution(idParam(c, "projectId"), idParam(c, "executionId"));

      if (!row) throw new StoreError("NOT_FOUND", "Execution not found");

      return c.json(await executionDto(deps, row));
    }),
  );
  app.delete(
    "/v1/projects/:projectId/sandboxes/:sandboxId",
    protect(deps, true, async (c) => {
      const projectId = idParam(c, "projectId"),
        sandboxId = idParam(c, "sandboxId"),
        key = InvocationKey.parse(c.req.header("idempotency-key"));

      const admitted = await deps.store.admitDestroy({
        projectId,
        sandboxId,
        endpoint: `DELETE /sandboxes/${sandboxId}`,
        key,
        intentHash: await intentSha256({ sandboxId }),
        providerAvailable: (provider) => providerAvailable(deps, provider),
      });

      return accepted(c, admitted.operation);
    }),
  );
  app.get(
    "/v1/projects/:projectId/operations/:operationId",
    protect(deps, false, async (c) => {
      const row = await deps.store.getOperation(idParam(c, "projectId"), idParam(c, "operationId"));

      if (!row) throw new StoreError("NOT_FOUND", "Operation not found");

      return c.json(opDto(row));
    }),
  );
  app.get(
    "/v1/projects/:projectId/invocations/:invocationKey",
    protect(deps, false, async (c) => {
      const projectId = idParam(c, "projectId"),
        key = InvocationKey.parse(c.req.param("invocationKey"));

      const params = new URL(c.req.url).searchParams;

      for (const key of params.keys())
        if (!["kind", "sandboxId"].includes(key) || params.getAll(key).length !== 1)
          throw new SyntaxError("Invalid invocation query");

      const kind = params.get("kind"),
        sandboxIdValue = params.get("sandboxId");

      if (!kind || !["create", "exec", "destroy", "file_write", "image_build"].includes(kind))
        throw new SyntaxError("Invalid invocation kind");

      if (
        ((kind === "create" || kind === "image_build") && sandboxIdValue !== null) ||
        (kind !== "create" && kind !== "image_build" && sandboxIdValue === null)
      )
        throw new SyntaxError("Invalid invocation sandbox");
      const sandboxId = sandboxIdValue === null ? undefined : Id.parse(sandboxIdValue);

      let endpoint: string;

      switch (kind) {
        case "create":
          endpoint = "POST /sandboxes";
          break;
        case "image_build":
          endpoint = "POST /images/builds";
          break;
        case "exec":
          endpoint = `POST /sandboxes/${sandboxId}/executions`;
          break;
        case "destroy":
          endpoint = `DELETE /sandboxes/${sandboxId}`;
          break;
        default:
          endpoint = `PUT /sandboxes/${sandboxId}/files`;
      }

      const row = await deps.store.lookupInvocation(projectId, endpoint, key);

      if (!row) throw new StoreError("NOT_FOUND", "Invocation not found");

      return c.json(opDto(row));
    }),
  );
  app.post(
    "/v1/projects/:projectId/operations/:operationId/reconcile",
    protect(deps, true, async (c) =>
      c.json(
        opDto(
          await deps.store.requestReconcile(idParam(c, "projectId"), idParam(c, "operationId")),
        ),
      ),
    ),
  );

  app.get(
    "/v1/projects/:projectId/sandboxes/:sandboxId/files",
    protect(deps, false, async (c) => {
      const params = new URL(c.req.url).searchParams;

      for (const key of params.keys())
        if (key !== "path" || params.getAll(key).length !== 1)
          throw new SyntaxError("Invalid file query");

      const projectId = idParam(c, "projectId"),
        box = await deps.store.getSandbox(projectId, idParam(c, "sandboxId"));

      if (!box) throw new StoreError("NOT_FOUND", "Sandbox not found");
      const connection = await deps.store.getConnection(projectId, box.connection_id);

      if (!connection) throw new StoreError("NOT_FOUND", "Connection not found");

      return withProvider(deps, connection, async ({ driver, scope }) => {
        const bytes = await driver.readFile({ sandbox: nativeRef(box, scope), path: filePath(c) });

        if (bytes.length > 1_048_576)
          throw new StoreError("CAPACITY", "File exceeds buffered read limit");

        return new Response(Buffer.from(bytes), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.length),
            "Cache-Control": "no-store",
          },
        });
      });
    }),
  );
  app.put(
    "/v1/projects/:projectId/sandboxes/:sandboxId/files",
    protect(deps, true, async (c) => {
      const projectId = idParam(c, "projectId"),
        sandboxId = idParam(c, "sandboxId"),
        key = InvocationKey.parse(c.req.header("idempotency-key"));

      const { path, overwrite } = fileWriteQuery(c);
      const box = await deps.store.getSandbox(projectId, sandboxId);

      if (!box) throw new StoreError("NOT_FOUND", "Sandbox not found");
      const connection = await deps.store.getConnection(projectId, box.connection_id);

      if (!connection) throw new StoreError("NOT_FOUND", "Connection not found");
      const bytes = await boundedBody(c, 1_048_576);
      const base64 = Buffer.from(bytes).toString("base64");
      const intentHash = await intentSha256({ path, overwrite, bytesBase64: base64 });

      const encryptedBytes = await deps.secrets.seal(
        "file-write-input",
        `${sandboxId}:${key}`,
        base64,
      );

      const admitted = await deps.store.admitFileWrite({
        projectId,
        sandboxId,
        endpoint: `PUT /sandboxes/${sandboxId}/files`,
        key,
        intentHash,
        path,
        overwrite,
        encryptedBytes,
        bytes: bytes.length,
        providerAvailable: (provider) => providerAvailable(deps, provider),
      });

      if (!admitted.repeated && deps.runner) await deps.runner.tick();
      const current = (await deps.store.getOperation(projectId, admitted.operation.id))!;
      const dto = opDto(current);

      if (dto.status === "succeeded" && dto.result?.kind === "file_write")
        return c.json(FileReceipt.parse(dto.result.receipt));

      return accepted(c, current);
    }),
  );
}
