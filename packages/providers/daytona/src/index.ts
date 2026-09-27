import { z } from "zod";
import {
  DriverCapabilities,
  DriverResult,
  NativeScope,
  ProviderReadError,
  SandboxObservation,
  type InvocationIdentity,
  type NativeRef,
  type SandboxRef,
  type ProviderDriver,
} from "@sandbar/provider-spi";
import { ExecRequest, type ExecCommand } from "@sandbar/contracts";

// Daytona API and toolbox OpenAPI v0.218; see README for the pinned sources.
const CurrentKey = z.object({ organizationId: z.string().min(1) });

const Organization = z.object({
  id: z.string().min(1),
  sandboxLimitedNetworkEgress: z.boolean(),
});

const Region = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  regionType: z.enum(["shared", "dedicated", "custom"]),
  organizationId: z.string().nullable().optional(),
});

const Snapshot = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  state: z.string(),
  regionIds: z.array(z.string()).optional(),
  sandboxClass: z.string().optional(),
});

const NativeSandbox = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  organizationId: z.string().min(1),
  target: z.string().min(1),
  state: z.string(),
  networkBlockAll: z.boolean(),
  public: z.boolean(),
  toolboxProxyUrl: z.url().optional(),
  snapshot: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

const ListedSandbox = NativeSandbox.omit({ networkBlockAll: true, public: true });

const ListResponse = z.object({
  items: z.array(ListedSandbox),
  nextCursor: z.string().nullable().optional(),
});

const CommandResponse = z.object({ result: z.string(), exitCode: z.number().int().optional() });

const UploadResponse = z.object({ path: z.string(), name: z.string(), type: z.string() });

const Input = z.strictObject({
  credentials: z.strictObject({ apiKey: z.string().min(1) }),
  configuration: z.strictObject({
    apiUrl: z.url().default("https://app.daytona.io/api"),
    toolboxOrigin: z.url().default("https://proxy.app.daytona.io"),
    target: z.string().min(1),
    ttlMinutes: z.coerce.number().int().min(1).max(1440).default(60),
  }),
});

export type DaytonaEndpointPair = { apiUrl: string; toolboxOrigin: string };

export type DaytonaInput = {
  apiKey: string;
  apiUrl?: string;
  toolboxOrigin?: string;
  target: string;
  ttlMinutes?: number;
  fetch?: typeof fetch;
  trustedEndpoints?: DaytonaEndpointPair[];
};

type Config = z.infer<typeof Input>;

type Sandbox = z.infer<typeof NativeSandbox>;

type DaytonaInventoryPage = Awaited<ReturnType<ProviderDriver["inventory"]>>;

function endpointConfigurationError(field: "apiUrl" | "toolboxOrigin"): z.ZodError {
  return new z.ZodError([
    {
      code: "custom",
      path: ["configuration", field],
      message: "Invalid Daytona endpoint configuration",
    },
  ]);
}

function canonicalUrl(value: string, field?: "apiUrl" | "toolboxOrigin"): string {
  const url = new URL(value);

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol)
  )
    throw field ? endpointConfigurationError(field) : new Error("Invalid Daytona endpoint");

  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw field ? endpointConfigurationError(field) : new Error("Daytona endpoint must use HTTPS");

  return url.href.replace(/\/$/, "");
}

function trustedPair(pair: DaytonaEndpointPair): DaytonaEndpointPair {
  const apiUrl = canonicalUrl(pair.apiUrl, "apiUrl");
  const toolboxOrigin = canonicalUrl(pair.toolboxOrigin, "toolboxOrigin");

  if (new URL(toolboxOrigin).origin !== toolboxOrigin)
    throw endpointConfigurationError("toolboxOrigin");

  return { apiUrl, toolboxOrigin };
}

const officialEndpoints = trustedPair({
  apiUrl: "https://app.daytona.io/api",
  toolboxOrigin: "https://proxy.app.daytona.io",
});

function requireTrustedEndpoints(config: Config, extra: DaytonaEndpointPair[]): void {
  const requested = trustedPair(config.configuration);
  const trusted = [officialEndpoints, ...extra.map(trustedPair)];

  if (
    !trusted.some(
      (pair) => pair.apiUrl === requested.apiUrl && pair.toolboxOrigin === requested.toolboxOrigin,
    )
  )
    throw new z.ZodError([
      {
        code: "custom",
        path: ["configuration", "apiUrl"],
        message: "Daytona API and toolbox endpoints are not trusted by this host",
      },
    ]);
}

function validate(input: {
  credentials: Record<string, string>;
  configuration: Record<string, string>;
}): Config {
  const parsed = Input.parse(input);

  return {
    credentials: parsed.credentials,
    configuration: {
      ...parsed.configuration,
      apiUrl: canonicalUrl(parsed.configuration.apiUrl, "apiUrl"),
      toolboxOrigin: canonicalUrl(parsed.configuration.toolboxOrigin, "toolboxOrigin"),
    },
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function validPath(path: string): void {
  if (
    !path.startsWith("/") ||
    path.length > 4096 ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Invalid Daytona file path");
}

function ref(scope: NativeScope, id: string): SandboxRef {
  return { scope, nativeId: id, kind: "sandbox" };
}

function observed(scope: NativeScope, sandbox: Sandbox): SandboxObservation {
  if (
    sandbox.organizationId !== scope.accountId ||
    sandbox.target !== scope.region ||
    !sandbox.networkBlockAll ||
    sandbox.public
  )
    throw new Error(
      "Daytona sandbox scope, outbound network policy or preview visibility mismatch",
    );

  return SandboxObservation.parse({
    ref: ref(scope, sandbox.id),
    state:
      sandbox.state === "started"
        ? "running"
        : sandbox.state === "destroyed"
          ? "destroyed"
          : "unknown",
    observedAt: new Date().toISOString(),
  });
}

function unknown(submissionId: string, reason: string): DriverResult {
  return { status: "unknown", effect: "possible", submissionId, reason };
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");

  if (length && Number(length) > limit) throw new Error("Daytona response exceeds bound");

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const part = await reader.read();

      if (part.done) break;
      size += part.value.length;

      if (size > limit) {
        await reader.cancel();
        throw new Error("Daytona response exceeds bound");
      }

      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

async function boundedJson<T extends z.ZodType>(
  response: Response,
  schema: T,
  limit = 4_194_304,
): Promise<z.output<T>> {
  return schema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(response, limit)),
    ),
  );
}

type DaytonaRequestBody = Record<
  string,
  string | number | boolean | Record<string, string> | undefined
>;

/** One HTTP attempt per request. No upstream SDK retry middleware is in the mutation path. */
export class DaytonaDriver implements ProviderDriver {
  readonly name = "daytona";
  private readonly apiUrl: string;
  private readonly toolboxOrigin: string;
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly config: Config,
    readonly scope: NativeScope,
    fetchImpl?: typeof fetch,
  ) {
    this.apiUrl = config.configuration.apiUrl;
    this.toolboxOrigin = new URL(config.configuration.toolboxOrigin).origin;
    this.fetchImpl = fetchImpl ?? fetch;
  }
  private async request(
    method: string,
    path: string,
    body?: BodyInit,
    contentType?: string,
    toolbox?: Sandbox,
    timeoutMs = 30_000,
  ): Promise<Response> {
    const base = toolbox?.toolboxProxyUrl ? canonicalUrl(toolbox.toolboxProxyUrl) : this.apiUrl;

    if (toolbox && new URL(base).origin !== this.toolboxOrigin)
      throw new Error("Unexpected Daytona toolbox origin");
    const url = toolbox ? `${base}/${encodeURIComponent(toolbox.id)}${path}` : `${base}${path}`;

    const headers = new Headers({
      Authorization: `Bearer ${this.config.credentials.apiKey}`,
    });

    if (contentType) headers.set("Content-Type", contentType);

    return this.fetchImpl(url, {
      method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  private async json<T extends z.ZodType>(
    method: string,
    path: string,
    schema: T,
    body?: DaytonaRequestBody,
    toolbox?: Sandbox,
    timeoutMs?: number,
  ): Promise<z.output<T>> {
    const response = await this.request(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? undefined : "application/json",
      toolbox,
      timeoutMs,
    );

    if (!response.ok) throw new Error(`Daytona HTTP ${response.status}`);

    return boundedJson(response, schema);
  }
  private async sandbox(id: string): Promise<Sandbox | null> {
    const response = await this.request("GET", `/sandbox/${encodeURIComponent(id)}`);

    if (response.status === 404) return null;

    if (!response.ok) throw new Error(`Daytona HTTP ${response.status}`);
    const sandbox = await boundedJson(response, NativeSandbox);

    if (sandbox.id !== id) throw new Error("Daytona returned another sandbox ID");
    observed(this.scope, sandbox);

    return sandbox;
  }
  private async toolbox(sandbox: SandboxRef, requireStarted = false): Promise<Sandbox> {
    this.sameScope(sandbox);
    const value = await this.sandbox(sandbox.nativeId);

    if (!value || !value.toolboxProxyUrl)
      throw new ProviderReadError("NOT_FOUND", "Daytona sandbox or toolbox unavailable");

    if (requireStarted && value.state !== "started")
      throw new ProviderReadError("INVALID_RESPONSE", "Daytona sandbox is not started");

    return value;
  }
  private sameScope(value: NativeRef | NativeScope): void {
    const scope = "scope" in value ? value.scope : value;

    if (
      scope.provider !== "daytona" ||
      scope.connectionId !== this.scope.connectionId ||
      scope.accountId !== this.scope.accountId ||
      scope.region !== this.scope.region ||
      scope.endpoint !== this.scope.endpoint
    )
      throw new Error("Daytona scope mismatch");
  }
  private async supportsBlockedEgress(): Promise<boolean> {
    const accountId = this.scope.accountId;

    if (!accountId) return false;

    try {
      const response = await this.request(
        "GET",
        `/organizations/${encodeURIComponent(accountId)}`,
        undefined,
        undefined,
        undefined,
        15_000,
      );

      if (!response.ok) return false;
      const organization = await boundedJson(response, Organization, 16_384);

      return organization.id === accountId && organization.sandboxLimitedNetworkEgress === false;
    } catch {
      return false;
    }
  }
  async capabilities(scope: NativeScope) {
    this.sameScope(scope);
    const blockedEgress = await this.supportsBlockedEgress();

    return DriverCapabilities.parse({
      provider: "daytona",
      nativeIdempotency: { create: false, exec: false, destroy: false, writeFile: false },
      discoveryBySubmission: true,
      supports: { argv: true, shell: true, fileBytes: true, inventory: true },
      maxFileBytes: 1_048_576,
      maxOutputBytes: 1_048_576,
      networkPolicies: blockedEgress ? ["blocked"] : [],
    });
  }
  async prepare(input: {
    scope: NativeScope;
    image: { kind: "prepared" | "oci"; value: string };
    networkPolicy: string;
    region?: string;
  }) {
    this.sameScope(input.scope);

    if (input.networkPolicy !== "blocked")
      return { supported: false, reason: "Daytona adapter currently enforces only blocked egress" };

    if (input.region && input.region !== this.scope.region)
      return {
        supported: false,
        reason: "Daytona connection target differs from requested region",
      };

    if (input.image.kind !== "prepared")
      return {
        supported: false,
        reason:
          "OCI source would trigger a paid implicit Daytona snapshot build; use an existing snapshot ID",
      };

    if (!(await this.supportsBlockedEgress()))
      return {
        supported: false,
        reason: "Verified Daytona organization does not support strict blocked egress",
      };

    const response = await this.request(
      "GET",
      `/snapshots/${encodeURIComponent(input.image.value)}`,
    );

    if (response.status === 404) return { supported: false, reason: "Daytona snapshot not found" };

    if (!response.ok) throw new Error(`Daytona snapshot check HTTP ${response.status}`);
    const snapshot = await boundedJson(response, Snapshot);

    if (
      snapshot.id !== input.image.value ||
      snapshot.organizationId !== this.scope.accountId ||
      snapshot.state !== "active" ||
      !snapshot.regionIds?.includes(this.scope.region!)
    )
      return {
        supported: false,
        reason: "Snapshot is not active in the verified organization and region",
      };

    if (!["linux-vm", "container"].includes(snapshot.sandboxClass ?? ""))
      return {
        supported: false,
        reason: "POSIX Linux snapshot required for binary command capture",
      };

    return { supported: true, effectiveImage: snapshot.id };
  }
  async create(input: {
    scope: NativeScope;
    identity: InvocationIdentity;
    image: string;
    networkPolicy: string;
    labels?: Record<string, string>;
  }): Promise<DriverResult> {
    this.sameScope(input.scope);

    if (input.networkPolicy !== "blocked")
      return {
        status: "rejected",
        effect: "none",
        error: {
          code: "unsupported",
          message: "Only blocked network policy is supported",
          effect: "none",
          retry: "never",
        },
      };

    // The caller prepares this effective snapshot before recording submission.
    const name = `sandbar-${input.identity.submissionId}`;

    try {
      const value = await this.json("POST", "/sandbox", NativeSandbox, {
        name,
        snapshot: input.image,
        target: this.scope.region,
        networkBlockAll: true,
        public: false,
        labels: {
          ...input.labels,
          "sandbar.submission": input.identity.submissionId,
          "sandbar.operation": input.identity.operationId,
        },
        ttlMinutes: this.config.configuration.ttlMinutes,
      });

      if (value.name !== name)
        return unknown(input.identity.submissionId, "Daytona returned a different sandbox name");

      if (value.snapshot && value.snapshot !== input.image)
        return unknown(input.identity.submissionId, "Daytona returned a different snapshot");
      const observation = observed(this.scope, value);

      if (["destroyed", "error", "build_failed"].includes(value.state))
        return unknown(input.identity.submissionId, "Daytona sandbox did not reach running state");

      if (["stopped", "paused", "archived"].includes(value.state))
        return {
          status: "completed",
          effect: "applied",
          submissionId: input.identity.submissionId,
          value: { kind: "sandbox", observation },
        };

      if (observation.state !== "running")
        return {
          status: "pending",
          effect: "possible",
          submissionId: input.identity.submissionId,
          observeAfterMs: 1000,
        };

      return {
        status: "completed",
        effect: "applied",
        submissionId: input.identity.submissionId,
        value: { kind: "sandbox", observation },
      };
    } catch {
      return unknown(
        input.identity.submissionId,
        "Daytona create response unavailable; observe without replay",
      );
    }
  }
  async inspect(value: SandboxRef): Promise<SandboxObservation | null> {
    this.sameScope(value);
    const sandbox = await this.sandbox(value.nativeId);

    return sandbox ? observed(this.scope, sandbox) : null;
  }
  async inventory(input: { scope: NativeScope; cursor?: string; limit: number }) {
    this.sameScope(input.scope);
    const query = new URLSearchParams({ limit: String(input.limit) });

    if (input.cursor) query.set("cursor", input.cursor);
    const page = await this.json("GET", `/sandbox?${query}`, ListResponse);

    const result: DaytonaInventoryPage = { items: [] };

    for (const listed of page.items) {
      if (
        !listed.labels?.["sandbar.submission"] ||
        listed.organizationId !== this.scope.accountId ||
        listed.target !== this.scope.region
      )
        continue;

      const detail = await this.sandbox(listed.id);

      if (
        detail &&
        detail.labels?.["sandbar.submission"] === listed.labels["sandbar.submission"] &&
        detail.labels?.["sandbar.operation"] === listed.labels["sandbar.operation"]
      )
        result.items.push(observed(this.scope, detail));
    }

    if (page.nextCursor) result.nextCursor = page.nextCursor;

    return result;
  }
  async observe(input: {
    scope: NativeScope;
    submissionId: string;
    operationId?: string;
  }): Promise<DriverResult | null> {
    this.sameScope(input.scope);
    const name = `sandbar-${input.submissionId}`;

    const page = await this.json(
      "GET",
      `/sandbox?name=${encodeURIComponent(name)}&limit=2&includeErroredDeleted=true`,
      ListResponse,
    );

    const matches = page.items.filter(
      (value) =>
        value.name === name &&
        value.organizationId === this.scope.accountId &&
        value.target === this.scope.region &&
        value.labels?.["sandbar.submission"] === input.submissionId &&
        (!input.operationId || value.labels["sandbar.operation"] === input.operationId),
    );

    if (matches.length !== 1) return null;
    let detail: Sandbox | null;

    try {
      detail = await this.sandbox(matches[0]!.id);
    } catch {
      return null;
    }

    if (
      !detail ||
      detail.name !== name ||
      detail.labels?.["sandbar.submission"] !== input.submissionId ||
      (input.operationId && detail.labels?.["sandbar.operation"] !== input.operationId)
    )
      return null;

    const observation = observed(this.scope, detail);

    if (["destroyed", "error", "build_failed"].includes(detail.state))
      return unknown(input.submissionId, "Daytona sandbox did not reach running state");

    if (["stopped", "paused", "archived"].includes(detail.state))
      return {
        status: "completed",
        effect: "applied",
        submissionId: input.submissionId,
        value: { kind: "sandbox", observation },
      };

    if (observation.state !== "running")
      return {
        status: "pending",
        effect: "possible",
        submissionId: input.submissionId,
        observeAfterMs: 1000,
      };

    return {
      status: "completed",
      effect: "applied",
      submissionId: input.submissionId,
      value: { kind: "sandbox", observation },
    };
  }
  async exec(input: {
    sandbox: SandboxRef;
    identity: InvocationIdentity;
    command: ExecCommand;
    cwd?: string;
    env?: Record<string, string>;
    deadlineSeconds: number;
    maxOutputBytes: number;
  }): Promise<DriverResult> {
    let native: Sandbox;

    try {
      native = await this.toolbox(input.sandbox, true);
    } catch (error) {
      return {
        status: "rejected",
        effect: "none",
        error: {
          code:
            error instanceof ProviderReadError && error.code === "NOT_FOUND"
              ? "not_found"
              : "unavailable",
          message: "Daytona sandbox inspection failed before execution",
          effect: "none",
          retry: "never",
        },
      };
    }

    const requestedEnv = ExecRequest.shape.env.parse(input.env) ?? {};

    if (Object.values(requestedEnv).some((value) => value.includes("\0")))
      return {
        status: "rejected",
        effect: "none",
        error: {
          code: "invalid",
          message: "Daytona command environment contains an unsupported NUL byte",
          effect: "none",
          retry: "never",
        },
      };

    const exports = Object.entries(requestedEnv)
      .map(([name, value]) => `${name}=${quote(value)}; export ${name};`)
      .join(" ");

    const command =
      input.command.kind === "shell"
        ? `/bin/sh -c ${quote(input.command.script)}`
        : `exec ${input.command.argv.map(quote).join(" ")}`;

    const max = Math.min(input.maxOutputBytes, 1_048_576);
    const script = `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH; d=$(mktemp -d) || exit 125; trap 'rm -rf "$d"' EXIT; mkfifo "$d/fo" "$d/fe" || exit 125; (exec 3<"$d/fo"; head -c ${max + 1} <&3 >"$d/o"; cat <&3 >/dev/null) & p1=$!; (exec 3<"$d/fe"; head -c ${max + 1} <&3 >"$d/e"; cat <&3 >/dev/null) & p2=$!; (${exports} ${command}) >"$d/fo" 2>"$d/fe"; rc=$?; wait "$p1"; wait "$p2"; o=$(wc -c <"$d/o"); e=$(wc -c <"$d/e"); o=$((o)); e=$((e)); a=$((o<${max}?o:${max})); b=$((e<${max}-a?e:${max}-a)); printf 'SANDBAR-EXEC-V1\\n%s\\n%s\\n%s\\n' "$rc" "$o" "$e"; if [ "$a" -gt 0 ]; then head -c "$a" "$d/o" | od -An -tx1 -v; fi; printf 'SANDBAR-STDERR\\n'; if [ "$b" -gt 0 ]; then head -c "$b" "$d/e" | od -An -tx1 -v; fi; printf 'SANDBAR-END\\n'`;

    try {
      const response = await this.json(
        "POST",
        `/process/execute`,
        CommandResponse,
        { command: script, cwd: input.cwd, timeout: input.deadlineSeconds },
        native,
        (input.deadlineSeconds + 10) * 1000,
      );

      if (response.exitCode !== 0)
        return unknown(input.identity.submissionId, "Daytona capture wrapper failed");

      const match =
        /^SANDBAR-EXEC-V1\n(-?\d+)\n(\d+)\n(\d+)\n([\da-f\s]*)SANDBAR-STDERR\n([\da-f\s]*)SANDBAR-END\n?$/.exec(
          response.result,
        );

      if (!match) return unknown(input.identity.submissionId, "Daytona command response malformed");

      const decode = (hex: string): Uint8Array | null => {
        const trimmed = hex.trim();
        const tokens = trimmed ? trimmed.split(/\s+/) : [];

        if (tokens.some((token) => !/^[0-9a-f]{2}$/.test(token))) return null;

        return Uint8Array.from(tokens.map((token) => Number.parseInt(token, 16)));
      };

      const stdout = decode(match[4]!),
        stderr = decode(match[5]!);

      const stdoutCount = Number(match[2]),
        stderrCount = Number(match[3]);

      if (
        !stdout ||
        !stderr ||
        !Number.isSafeInteger(stdoutCount) ||
        !Number.isSafeInteger(stderrCount) ||
        stdoutCount < 0 ||
        stderrCount < 0 ||
        stdoutCount > max + 1 ||
        stderrCount > max + 1 ||
        stdout.length !== Math.min(stdoutCount, max) ||
        stderr.length !== Math.min(stderrCount, max - stdout.length) ||
        stdout.length + stderr.length > max
      )
        return unknown(input.identity.submissionId, "Daytona capture output inconsistent");

      const observation = {
        ref: {
          scope: this.scope,
          nativeId: input.identity.submissionId,
          kind: "execution" as const,
        },
        sandbox: input.sandbox,
        completed: true,
        exitCode: Number(match[1]),
        stdoutBase64: Buffer.from(stdout).toString("base64"),
        stderrBase64: Buffer.from(stderr).toString("base64"),
        truncated: stdoutCount + stderrCount > stdout.length + stderr.length,
        observedAt: new Date().toISOString(),
      };

      return DriverResult.parse({
        status: "completed",
        effect: "applied",
        submissionId: input.identity.submissionId,
        value: { kind: "execution", observation },
      });
    } catch {
      return unknown(
        input.identity.submissionId,
        "Daytona execution response unavailable; do not replay",
      );
    }
  }
  async readFile(input: { sandbox: SandboxRef; path: string }): Promise<Uint8Array> {
    validPath(input.path);
    const native = await this.toolbox(input.sandbox);

    const response = await this.request(
      "GET",
      `/files/download?path=${encodeURIComponent(input.path)}`,
      undefined,
      undefined,
      native,
    );

    if (response.status === 404) throw new ProviderReadError("NOT_FOUND", "Daytona file not found");

    if (!response.ok)
      throw new ProviderReadError("INVALID_RESPONSE", "Daytona file download failed");

    try {
      return await boundedBytes(response, 1_048_576);
    } catch {
      throw new ProviderReadError(
        "INVALID_RESPONSE",
        "Daytona file exceeds read bound or is incomplete",
      );
    }
  }
  async writeFile(input: {
    sandbox: SandboxRef;
    identity: InvocationIdentity;
    path: string;
    bytes: Uint8Array;
    overwrite: boolean;
  }): Promise<DriverResult> {
    validPath(input.path);

    if (input.bytes.length > 1_048_576)
      return {
        status: "rejected",
        effect: "none",
        error: {
          code: "capacity",
          message: "File exceeds Daytona adapter write bound",
          effect: "none",
          retry: "never",
        },
      };

    if (!input.overwrite)
      return {
        status: "rejected",
        effect: "none",
        error: {
          code: "unsupported",
          message: "Daytona upload cannot guarantee no-overwrite",
          effect: "none",
          retry: "never",
        },
      };
    let native: Sandbox;

    try {
      native = await this.toolbox(input.sandbox, true);
    } catch (error) {
      return {
        status: "rejected",
        effect: "none",
        error: {
          code:
            error instanceof ProviderReadError && error.code === "NOT_FOUND"
              ? "not_found"
              : "unavailable",
          message: "Daytona sandbox inspection failed before upload",
          effect: "none",
          retry: "never",
        },
      };
    }

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(input.bytes)]), "blob");

    try {
      const response = await this.request(
        "POST",
        `/files/upload-v2?path=${encodeURIComponent(input.path)}`,
        form,
        undefined,
        native,
      );

      if (!response.ok)
        return unknown(input.identity.submissionId, "Daytona upload response unavailable");
      const receipt = await boundedJson(response, UploadResponse, 16_384);

      if (receipt.path !== input.path)
        return unknown(input.identity.submissionId, "Daytona upload path mismatch");
      const actual = await this.readFile({ sandbox: input.sandbox, path: input.path });

      if (
        actual.length !== input.bytes.length ||
        !actual.every((byte, i) => byte === input.bytes[i])
      )
        return unknown(input.identity.submissionId, "Daytona upload bytes could not be verified");

      return {
        status: "completed",
        effect: "applied",
        submissionId: input.identity.submissionId,
        value: {
          kind: "file_write",
          observation: {
            sandbox: input.sandbox,
            path: input.path,
            bytesWritten: actual.length,
            complete: true,
          },
        },
      };
    } catch {
      return unknown(input.identity.submissionId, "Daytona upload outcome unknown; do not replay");
    }
  }
  async destroy(input: {
    sandbox: SandboxRef;
    identity: InvocationIdentity;
  }): Promise<DriverResult> {
    this.sameScope(input.sandbox);

    try {
      const value = await this.json(
        "DELETE",
        `/sandbox/${encodeURIComponent(input.sandbox.nativeId)}`,
        NativeSandbox,
      );

      if (
        value.id !== input.sandbox.nativeId ||
        value.organizationId !== this.scope.accountId ||
        value.target !== this.scope.region ||
        value.state !== "destroyed"
      )
        return unknown(input.identity.submissionId, "Daytona deletion not confirmed");

      return {
        status: "completed",
        effect: "applied",
        submissionId: input.identity.submissionId,
        value: {
          kind: "destroy",
          observation: { sandbox: input.sandbox, computeStopped: true, retainedResources: [] },
        },
      };
    } catch {
      return unknown(
        input.identity.submissionId,
        "Daytona deletion outcome unknown; do not replay",
      );
    }
  }
}

export function daytonaRegistration(
  fetchImpl?: typeof fetch,
  trustedEndpoints: DaytonaEndpointPair[] = [],
) {
  return {
    provider: "daytona" as const,
    validate(input: {
      credentials: Record<string, string>;
      configuration: Record<string, string>;
    }) {
      const parsed = validate(input);
      requireTrustedEndpoints(parsed, trustedEndpoints);

      return {
        credentials: parsed.credentials,
        configuration: {
          ...parsed.configuration,
          ttlMinutes: String(parsed.configuration.ttlMinutes),
        },
      };
    },
    async connect(input: {
      connectionId: string;
      credentials: Record<string, string>;
      configuration: Record<string, string>;
    }) {
      const config = validate({
        credentials: input.credentials,
        configuration: input.configuration,
      });

      requireTrustedEndpoints(config, trustedEndpoints);

      const response = await (fetchImpl ?? fetch)(
        `${config.configuration.apiUrl}/api-keys/current`,
        {
          headers: { Authorization: `Bearer ${config.credentials.apiKey}` },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );

      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);

        throw new ProviderReadError("UNAUTHENTICATED", "Daytona credential verification failed");
      }

      if (!response.ok) throw new Error("Daytona credential verification failed");
      const key = await boundedJson(response, CurrentKey, 16_384);

      const regionsResponse = await (fetchImpl ?? fetch)(`${config.configuration.apiUrl}/regions`, {
        headers: { Authorization: `Bearer ${config.credentials.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });

      if (regionsResponse.status === 401 || regionsResponse.status === 403) {
        await regionsResponse.body?.cancel().catch(() => undefined);

        throw new ProviderReadError("UNAUTHENTICATED", "Daytona credential verification failed");
      }

      if (!regionsResponse.ok) throw new Error("Daytona target verification failed");
      let regions: z.infer<typeof Region>[];

      try {
        regions = await boundedJson(regionsResponse, z.array(Region), 1_048_576);
      } catch {
        throw new Error("Daytona target verification failed");
      }

      const matches = regions.filter((region) => region.id === config.configuration.target);

      if (matches.length > 1) throw new Error("Daytona target verification failed");

      if (
        matches.length === 0 ||
        (matches[0]!.regionType !== "shared" && matches[0]!.organizationId !== key.organizationId)
      )
        throw new z.ZodError([
          {
            code: "custom",
            path: ["configuration", "target"],
            message: "Daytona target is unavailable for the verified organization",
          },
        ]);

      const scope = NativeScope.parse({
        provider: "daytona",
        connectionId: input.connectionId,
        accountId: key.organizationId,
        region: config.configuration.target,
        endpoint: config.configuration.apiUrl,
      });

      return { driver: new DaytonaDriver(config, scope, fetchImpl), scope };
    },
  };
}

export async function daytonaProvider(input: DaytonaInput) {
  const config = validate({
    credentials: { apiKey: input.apiKey },
    configuration: {
      apiUrl: input.apiUrl ?? "https://app.daytona.io/api",
      toolboxOrigin: input.toolboxOrigin ?? "https://proxy.app.daytona.io",
      target: input.target,
      ttlMinutes: String(input.ttlMinutes ?? 60),
    },
  });

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${config.configuration.apiUrl}|${config.configuration.target}|${config.configuration.toolboxOrigin}`,
    ),
  );

  const connectionId = `daytona_${Buffer.from(digest).toString("hex")}`;

  return daytonaRegistration(input.fetch, input.trustedEndpoints).connect({
    credentials: config.credentials,
    configuration: { ...config.configuration, ttlMinutes: String(config.configuration.ttlMinutes) },
    connectionId,
  });
}
