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
import { ExecRequest, type ExecCommand } from "sandbar-adapter/portable";
import type { ImageBuildValue } from "sandbar-adapter";

type ImageBuildObservation =
  | { status: "completed"; value: ImageBuildValue }
  | { status: "pending"; snapshotId: string }
  | { status: "unknown"; reason: string; snapshotId?: string };

type ImageBuildResult = ImageBuildObservation | { status: "rejected"; reason: string };

function fixedImage(image: string): boolean {
  return (
    image.length <= 512 &&
    /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image) &&
    (/@sha256:[0-9a-fA-F]{64}$/.test(image) ||
      (/:[A-Za-z0-9._-]+$/.test(image) && !image.includes("@"))) &&
    !/:(latest|lts|stable)$/i.test(image)
  );
}

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
  general: z.boolean().default(false),
  id: z.string().min(1),
  name: z.string().optional(),
  imageName: z.string().optional(),
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
  volumes: z
    .array(
      z.object({
        volumeId: z.string(),
        mountPath: z.string(),
        subpath: z.string().optional(),
      }),
    )
    .optional(),
});

const ListedSandbox = NativeSandbox.omit({ networkBlockAll: true, public: true });

const ListResponse = z.object({
  items: z.array(ListedSandbox),
  nextCursor: z.string().nullable().optional(),
});

const CommandResponse = z.object({ result: z.string(), exitCode: z.number().int().optional() });

const UploadResponse = z.object({ path: z.string(), name: z.string(), type: z.string() });

const WriteReceipt = z.strictObject({
  v: z.literal(1),
  submissionId: z.string().min(1).max(128),
  path: z.string().min(1).max(4096),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  bytesWritten: z.number().int().nonnegative().max(1_048_576),
});

const Input = z.strictObject({
  credentials: z.strictObject({ apiKey: z.string().min(1) }),
  configuration: z.strictObject({
    apiUrl: z.url().default("https://app.daytona.io/api"),
    toolboxOrigin: z.url().default("https://proxy.app.daytona.io"),
    target: z.string().min(1),
    networkPolicy: z.enum(["blocked", "daytona-default"]).default("blocked"),
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
  networkPolicy?: "blocked" | "daytona-default";
  fetch?: typeof fetch;
  trustedEndpoints?: DaytonaEndpointPair[];
};

type Config = z.infer<typeof Input>;

type Sandbox = z.infer<typeof NativeSandbox>;

type DaytonaCreateResult = DriverResult & {
  nativeSandbox?: Sandbox;
  acknowledgedSandbox?: { id: string; labels: Record<string, string> };
};

function volumeContains(native: Sandbox, path: string): boolean {
  const normalized = path.replace(/\/+/g, "/");

  return (native.volumes ?? []).some((mount) => {
    const root = mount.mountPath.replace(/\/+/g, "/").replace(/\/$/, "");

    return normalized === root || normalized.startsWith(root + "/");
  });
}

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

async function receiptPath(kind: "exec" | "write", submissionId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(submissionId));

  return `/tmp/.sandbar-${kind}-${Buffer.from(digest).toString("hex")}/receipt`;
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

function observed(
  scope: NativeScope,
  sandbox: Sandbox,
  networkPolicy: "blocked" | "daytona-default",
): SandboxObservation {
  if (
    sandbox.organizationId !== scope.accountId ||
    sandbox.target !== scope.region ||
    sandbox.networkBlockAll !== (networkPolicy === "blocked") ||
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

export async function boundedBytes(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const length = response.headers.get("content-length");

  if (length && Number(length) > limit) throw new Error("Daytona response exceeds bound");

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  const cancel = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      /* Native reader cancellation is best effort. */
    } finally {
      reader.releaseLock();
    }
  };

  signal?.addEventListener("abort", cancel, { once: true });

  try {
    if (signal?.aborted) {
      cancel();
      signal.throwIfAborted();
    }

    for (;;) {
      const part = await reader.read();

      signal?.throwIfAborted();

      if (part.done) break;
      size += part.value.length;

      if (size > limit) {
        if (signal) cancel();
        else await reader.cancel();
        throw new Error("Daytona response exceeds bound");
      }

      chunks.push(part.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
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
  | string
  | number
  | boolean
  | Record<string, string>
  | { volumeId: string; mountPath: string; subpath?: string }[]
  | undefined
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
    signal?: AbortSignal,
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
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
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
  private async sandboxDetail(id: string): Promise<Sandbox | null> {
    const response = await this.request("GET", `/sandbox/${encodeURIComponent(id)}`);

    if (response.status === 404) return null;

    if (!response.ok) throw new Error(`Daytona HTTP ${response.status}`);
    const sandbox = await boundedJson(response, NativeSandbox);

    if (
      sandbox.id !== id ||
      sandbox.organizationId !== this.scope.accountId ||
      sandbox.target !== this.scope.region
    )
      throw new Error("Daytona sandbox identity or scope mismatch");

    return sandbox;
  }
  private async matchesSnapshot(
    reported: string | undefined,
    expectedId: string,
  ): Promise<boolean> {
    if (!reported) return false;

    if (reported === expectedId) return true;

    // Daytona creates from the immutable ID but reports the native snapshot name.
    // Resolve that returned name and positively compare its ID; replacement names never match.
    const response = await this.request("GET", `/snapshots/${encodeURIComponent(reported)}`);

    if (!response.ok) return false;
    const snapshot = await boundedJson(response, Snapshot);

    return (
      snapshot.id === expectedId &&
      snapshot.name === reported &&
      (snapshot.general || snapshot.organizationId === this.scope.accountId)
    );
  }
  private async sandbox(id: string): Promise<Sandbox | null> {
    const sandbox = await this.sandboxDetail(id);

    if (sandbox) observed(this.scope, sandbox, this.config.configuration.networkPolicy);

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
    const networkPolicy = this.config.configuration.networkPolicy;
    const blockedEgress = networkPolicy === "blocked" && (await this.supportsBlockedEgress());

    return DriverCapabilities.parse({
      provider: "daytona",
      nativeIdempotency: { create: false, exec: false, destroy: false, writeFile: false },
      discoveryBySubmission: true,
      supports: { argv: true, shell: true, fileBytes: true, inventory: true },
      maxFileBytes: 1_048_576,
      maxOutputBytes: 1_048_576,
      networkPolicies:
        networkPolicy === "daytona-default"
          ? ["daytona-default"]
          : blockedEgress
            ? ["blocked"]
            : [],
    });
  }
  async prepare(input: {
    scope: NativeScope;
    image: { kind: "prepared" | "oci"; value: string };
    networkPolicy: string;
    region?: string;
  }) {
    this.sameScope(input.scope);

    if (input.networkPolicy !== this.config.configuration.networkPolicy)
      return {
        supported: false,
        reason: "Requested network policy differs from the Daytona connection policy",
      };

    if (input.region && input.region !== this.scope.region)
      return {
        supported: false,
        reason: "Daytona connection target differs from requested region",
      };

    if (input.networkPolicy === "blocked" && !(await this.supportsBlockedEgress()))
      return {
        supported: false,
        reason: "Verified Daytona organization does not support strict blocked egress",
      };

    if (input.image.kind === "oci") {
      const image = input.image.value;

      if (!fixedImage(image))
        return { supported: false, reason: "OCI image needs a fixed tag or digest" };

      // Building a snapshot is a paid mutation and belongs to submit, never prepare.
      return { supported: true, effectiveImage: image };
    }

    const response = await this.request(
      "GET",
      `/snapshots/${encodeURIComponent(input.image.value)}`,
    );

    if (response.status === 404) return { supported: false, reason: "Daytona snapshot not found" };

    if (!response.ok) throw new Error(`Daytona snapshot check HTTP ${response.status}`);
    const snapshot = await boundedJson(response, Snapshot);

    if (
      (snapshot.id !== input.image.value && snapshot.name !== input.image.value) ||
      (snapshot.organizationId !== this.scope.accountId && !snapshot.general) ||
      snapshot.state !== "active" ||
      !snapshot.regionIds?.includes(this.scope.region!)
    )
      return {
        supported: false,
        reason: "Snapshot is not active and available to the verified organization and region",
      };

    if (!["linux-vm", "container"].includes(snapshot.sandboxClass ?? ""))
      return {
        supported: false,
        reason: "POSIX Linux snapshot required for binary command capture",
      };

    return { supported: true, effectiveImage: snapshot.name ?? snapshot.id };
  }
  prepareImage(image: string): boolean {
    return fixedImage(image);
  }
  async imageBuildCandidate(submissionId: string): Promise<string | null> {
    const name = `sandbar-image-${submissionId}`;
    const response = await this.request("GET", `/snapshots/${encodeURIComponent(name)}`);

    if (!response.ok) return null;

    const snapshot = await boundedJson(response, Snapshot);

    return snapshot.name === name &&
      snapshot.organizationId === this.scope.accountId &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(snapshot.id)
      ? snapshot.id
      : null;
  }
  private imageBuildResult(
    snapshot: z.infer<typeof Snapshot>,
    name: string,
    allowMissingName = false,
  ): ImageBuildObservation | null {
    if (
      (snapshot.name !== name && !(allowMissingName && snapshot.name === undefined)) ||
      snapshot.organizationId !== this.scope.accountId ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(snapshot.id)
    )
      return null;

    if (["building", "pending", "pulling"].includes(snapshot.state))
      return { status: "pending", snapshotId: snapshot.id };

    if (
      snapshot.state !== "active" ||
      !snapshot.regionIds?.includes(this.scope.region!) ||
      !["container", "linux-vm"].includes(snapshot.sandboxClass ?? "")
    )
      return {
        status: "unknown",
        reason: `Daytona snapshot ${snapshot.id} is not confirmed ready`,
        snapshotId: snapshot.id,
      };

    return {
      status: "completed",
      value: {
        preparedId: snapshot.id,
        retainedResources: [
          { kind: "daytona-snapshot", id: snapshot.id, ownership: "unknown", cleanup: "manual" },
        ],
      },
    };
  }
  async observeImageBuild(
    submissionId: string,
    image: string,
    snapshotId?: string,
  ): Promise<ImageBuildObservation | null> {
    const name = `sandbar-image-${submissionId}`;

    const response = await this.request(
      "GET",
      `/snapshots/${encodeURIComponent(snapshotId ?? name)}`,
    );

    if (!response.ok) return null;

    const snapshot = await boundedJson(response, Snapshot);

    if ((snapshotId && snapshot.id !== snapshotId) || snapshot.imageName !== image)
      return { status: "unknown", reason: "Daytona image build source mismatched" };

    return (
      this.imageBuildResult(snapshot, name, snapshotId !== undefined) ?? {
        status: "unknown",
        reason: "Daytona image build scope or name mismatched",
      }
    );
  }
  async buildImage(input: {
    submissionId: string;
    image: string;
    signal: AbortSignal;
    onSubmit?: () => void;
  }): Promise<ImageBuildResult> {
    const name = `sandbar-image-${input.submissionId}`;
    let snapshotId: string | undefined;

    try {
      const prior = await this.request("GET", `/snapshots/${encodeURIComponent(name)}`);

      if (prior.status !== 404 || input.signal.aborted)
        return {
          status: "rejected",
          reason: "Daytona image build preflight did not permit submission",
        };
    } catch {
      return { status: "rejected", reason: "Daytona image build preflight unavailable" };
    }

    try {
      input.onSubmit?.();

      const snapshot = await this.json("POST", "/snapshots", Snapshot, {
        name,
        imageName: input.image,
        regionId: this.scope.region,
        sandboxClass: "container",
      });

      if (
        snapshot.organizationId !== this.scope.accountId ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(snapshot.id)
      )
        return { status: "unknown", reason: "Daytona image build response mismatched" };

      snapshotId = snapshot.id;

      if (snapshot.name !== name || snapshot.imageName !== input.image)
        return {
          status: "unknown",
          reason: "Daytona image build response metadata mismatched or unavailable",
          snapshotId,
        };

      if (input.signal.aborted)
        return {
          status: "unknown",
          reason: "Daytona image build wait ended; observe only",
          snapshotId,
        };

      // The returned native ID remains authoritative even while the name index is stale.
      const response = await this.request("GET", `/snapshots/${encodeURIComponent(snapshot.id)}`);

      if (!response.ok)
        return {
          status: "unknown",
          reason: "Daytona image build could not be read by ID",
          snapshotId,
        };

      const current = await boundedJson(response, Snapshot);

      if (current.id !== snapshot.id || current.imageName !== input.image)
        return { status: "unknown", reason: "Daytona image build identity mismatched", snapshotId };

      return (
        this.imageBuildResult(current, name, true) ?? {
          status: "unknown",
          reason: "Daytona image build scope mismatched",
          snapshotId,
        }
      );
    } catch {
      // Native build submission is never replayed after an unavailable response.
    }

    return {
      status: "unknown",
      reason: "Daytona image build outcome unavailable; observe only",
      snapshotId,
    };
  }
  async create(input: {
    scope: NativeScope;
    identity: InvocationIdentity;
    image: string;
    imageKind?: "prepared" | "oci";
    requireSnapshotIdentity?: boolean;
    networkPolicy: string;
    labels?: Record<string, string>;
    mounts?: import("sandbar-adapter").MountSpec[];
    signal?: AbortSignal;
  }): Promise<DaytonaCreateResult> {
    this.sameScope(input.scope);

    if ("sandbar.imageSnapshot" in (input.labels ?? {}))
      return {
        status: "rejected",
        effect: "none",
        error: {
          code: "invalid",
          message: "Reserved Daytona snapshot label",
          effect: "none",
          retry: "never",
        },
      };

    if (input.networkPolicy !== this.config.configuration.networkPolicy)
      return {
        status: "rejected",
        effect: "none",
        error: {
          code: "unsupported",
          message: "Requested network policy differs from the Daytona connection policy",
          effect: "none",
          retry: "never",
        },
      };

    // A stable name lets an unknown OCI build be found without repeating the build.
    const name = `sandbar-${input.identity.submissionId}`;
    let snapshotId = input.image;
    let retainedSnapshotId: string | undefined;
    let acknowledged: { id: string; labels: Record<string, string> } | undefined;

    const uncertain = (reason: string): DaytonaCreateResult => ({
      ...unknown(
        input.identity.submissionId,
        retainedSnapshotId ? `${reason}; snapshot ${retainedSnapshotId} may be retained` : reason,
      ),
      acknowledgedSandbox: acknowledged,
    });

    if (input.imageKind === "oci") {
      const snapshotName = `sandbar-image-${input.identity.submissionId}`;
      let buildSubmitted = false;

      try {
        const prior = await this.request("GET", `/snapshots/${encodeURIComponent(snapshotName)}`);

        if (prior.status !== 404) throw new Error("Daytona build preflight unavailable");

        if (input.signal?.aborted) throw new Error("Daytona build preflight aborted");

        buildSubmitted = true;

        const snapshot = await this.json("POST", "/snapshots", Snapshot, {
          name: snapshotName,
          imageName: input.image,
          regionId: this.scope.region,
          sandboxClass: "container",
        });

        if (
          snapshot.organizationId !== this.scope.accountId ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(snapshot.id)
        )
          return uncertain("Daytona snapshot build response mismatched");

        snapshotId = snapshot.id;
        retainedSnapshotId = snapshot.id;

        if (snapshot.name !== snapshotName || snapshot.imageName !== input.image)
          return uncertain("Daytona snapshot build metadata is unverified");

        let current = snapshot;

        if (current.state !== "active") {
          const response = await this.request(
            "GET",
            `/snapshots/${encodeURIComponent(snapshotId)}`,
          );

          if (!response.ok) return uncertain("Daytona snapshot build unreadable");
          current = await boundedJson(response, Snapshot);

          if (
            current.id !== snapshotId ||
            current.organizationId !== this.scope.accountId ||
            current.imageName !== input.image
          )
            return uncertain("Daytona snapshot build identity mismatched");
        }

        if (current.state !== "active")
          return uncertain(
            "Daytona snapshot is not ready; use images.build or account for retained resources",
          );

        if (
          !current.regionIds?.includes(this.scope.region!) ||
          !["container", "linux-vm"].includes(current.sandboxClass ?? "")
        )
          return uncertain("Daytona snapshot unavailable in target region");
      } catch {
        if (!buildSubmitted)
          return {
            status: "rejected",
            effect: "none",
            error: {
              code: "unavailable",
              message: "Daytona image build preflight did not permit submission",
              effect: "none",
              retry: "never",
            },
          };

        return uncertain("Daytona snapshot build response unavailable; do not replay");
      }
    }

    const labels = {
      ...input.labels,
      "sandbar.submission": input.identity.submissionId,
      "sandbar.operation": input.identity.operationId,
    };

    if (input.imageKind === "oci") Object.assign(labels, { "sandbar.imageSnapshot": snapshotId });

    if (input.signal?.aborted) return uncertain("Daytona creation wait was aborted");

    try {
      const body = {
        name,
        snapshot: snapshotId,
        networkBlockAll: input.networkPolicy === "blocked" ? true : undefined,
        target: this.scope.region,
        public: false,
        labels,
        volumes: input.mounts?.map((mount) => ({
          volumeId: mount.volume.nativeId,
          mountPath: mount.path,
          subpath: mount.subpath,
        })),
        ttlMinutes: this.config.configuration.ttlMinutes,
      };

      const response = await this.request(
        "POST",
        "/sandbox",
        JSON.stringify(body),
        "application/json",
      );

      if (!response.ok) throw new Error("Daytona create rejected");
      const raw = await boundedJson(response, z.unknown());

      const receipt = NativeSandbox.pick({
        id: true,
        name: true,
        organizationId: true,
        target: true,
        labels: true,
      }).safeParse(raw);

      if (
        receipt.success &&
        receipt.data.organizationId === this.scope.accountId &&
        receipt.data.target === this.scope.region &&
        receipt.data.name === name &&
        receipt.data.labels?.["sandbar.submission"] === input.identity.submissionId &&
        receipt.data.labels?.["sandbar.operation"] === input.identity.operationId
      )
        acknowledged = { id: receipt.data.id, labels: receipt.data.labels };
      const value = NativeSandbox.parse(raw);

      if (value.name !== name) return uncertain("Daytona returned a different sandbox name");

      if (
        (input.requireSnapshotIdentity || value.snapshot !== undefined) &&
        !(await this.matchesSnapshot(value.snapshot, snapshotId))
      )
        return uncertain("Daytona sandbox snapshot identity is unconfirmed");

      let mountDetail: Sandbox | null = null;

      if (input.mounts?.length || input.requireSnapshotIdentity) {
        const expectedMounts = input.mounts ?? [];
        mountDetail = await this.sandbox(value.id);

        if (
          !mountDetail ||
          mountDetail.name !== name ||
          mountDetail.labels?.["sandbar.submission"] !== input.identity.submissionId ||
          mountDetail.labels?.["sandbar.operation"] !== input.identity.operationId ||
          mountDetail.volumes?.length !== expectedMounts.length ||
          mountDetail.networkBlockAll !== (input.networkPolicy === "blocked") ||
          mountDetail.public !== false ||
          (input.requireSnapshotIdentity &&
            !(await this.matchesSnapshot(mountDetail.snapshot, snapshotId))) ||
          expectedMounts.some(
            (mount) =>
              !mountDetail!.volumes?.some(
                (attached) =>
                  attached.volumeId === mount.volume.nativeId &&
                  attached.mountPath === mount.path &&
                  attached.subpath === mount.subpath,
              ),
          )
        )
          return uncertain("Native mount readiness/identity is unconfirmed");
      }

      const nativeSandbox = mountDetail ?? value;

      const observation = observed(
        this.scope,
        nativeSandbox,
        this.config.configuration.networkPolicy,
      );

      if (["destroyed", "error", "build_failed"].includes(nativeSandbox.state))
        return uncertain("Daytona sandbox did not reach running state");

      if (["stopped", "paused", "archived"].includes(nativeSandbox.state))
        return {
          status: "completed",
          effect: "applied",
          submissionId: input.identity.submissionId,
          value: { kind: "sandbox", observation },
          nativeSandbox,
        };

      if (observation.state !== "running")
        return {
          status: "pending",
          effect: "possible",
          submissionId: input.identity.submissionId,
          observeAfterMs: 1000,
          nativeSandbox,
        };

      return {
        status: "completed",
        effect: "applied",
        submissionId: input.identity.submissionId,
        value: { kind: "sandbox", observation },
        nativeSandbox,
      };
    } catch {
      return uncertain("Daytona create response unavailable; observe without replay");
    }
  }
  async inspect(value: SandboxRef): Promise<(SandboxObservation & { nativeState: string }) | null> {
    this.sameScope(value);
    const sandbox = await this.sandbox(value.nativeId);

    return sandbox
      ? {
          ...observed(this.scope, sandbox, this.config.configuration.networkPolicy),
          nativeState: sandbox.state,
        }
      : null;
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
        result.items.push(observed(this.scope, detail, this.config.configuration.networkPolicy));
    }

    if (page.nextCursor) result.nextCursor = page.nextCursor;

    return result;
  }
  async observe(input: {
    scope: NativeScope;
    submissionId: string;
    operationId?: string;
    expectedSnapshotId?: string;
  }): Promise<DaytonaCreateResult | null> {
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

    if (matches.length !== 1) {
      // An OCI build may have materialized before its response was lost. This
      // is evidence of a scoped image candidate, never authority to create a sandbox.
      try {
        const imageName = `sandbar-image-${input.submissionId}`;
        const response = await this.request("GET", `/snapshots/${encodeURIComponent(imageName)}`);

        if (response.status === 404) return null;

        if (!response.ok) return null;
        const image = await boundedJson(response, Snapshot);

        if (image.name !== imageName || image.organizationId !== this.scope.accountId) return null;

        const reference = /^[a-zA-Z0-9._:-]{1,128}$/.test(image.id)
          ? `daytona:snapshot:${image.id}`
          : imageName;

        const state = ["active", "building", "pending", "error", "build_failed"].includes(
          image.state,
        )
          ? image.state
          : "unverified";

        return unknown(
          input.submissionId,
          `Scoped Daytona snapshot candidate ${reference} is ${state}; no sandbox creation is confirmed`,
        );
      } catch {
        return null;
      }
    }

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

    if (
      input.expectedSnapshotId !== undefined &&
      !(await this.matchesSnapshot(detail.snapshot, input.expectedSnapshotId))
    )
      return {
        ...unknown(input.submissionId, "Daytona sandbox snapshot identity is unconfirmed"),
        nativeSandbox: detail,
      };

    const observation = observed(this.scope, detail, this.config.configuration.networkPolicy);

    if (["destroyed", "error", "build_failed"].includes(detail.state))
      return {
        ...unknown(input.submissionId, "Daytona sandbox did not reach running state"),
        nativeSandbox: detail,
      };

    if (["stopped", "paused", "archived"].includes(detail.state))
      return {
        status: "completed",
        effect: "applied",
        submissionId: input.submissionId,
        value: { kind: "sandbox", observation },
        nativeSandbox: detail,
      };

    if (observation.state !== "running")
      return {
        status: "pending",
        effect: "possible",
        submissionId: input.submissionId,
        observeAfterMs: 1000,
        nativeSandbox: detail,
      };

    return {
      status: "completed",
      effect: "applied",
      submissionId: input.submissionId,
      value: { kind: "sandbox", observation },
      nativeSandbox: detail,
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
    signal?: AbortSignal;
    onSubmit?: () => void;
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
    const capture = `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH; d=$(mktemp -d) || exit 125; trap 'rm -rf "$d"' EXIT; mkfifo "$d/fo" "$d/fe" || exit 125; (exec 3<"$d/fo"; head -c ${max + 1} <&3 >"$d/o"; cat <&3 >/dev/null) & p1=$!; (exec 3<"$d/fe"; head -c ${max + 1} <&3 >"$d/e"; cat <&3 >/dev/null) & p2=$!; (${exports} ${command}) >"$d/fo" 2>"$d/fe"; rc=$?; wait "$p1"; wait "$p2"; o=$(wc -c <"$d/o"); e=$(wc -c <"$d/e"); o=$((o)); e=$((e)); a=$((o<${max}?o:${max})); b=$((e<${max}-a?e:${max}-a)); printf 'SANDBAR-EXEC-V1\\n%s\\n%s\\n%s\\n' "$rc" "$o" "$e"; if [ "$a" -gt 0 ]; then head -c "$a" "$d/o" | od -An -tx1 -v; fi; printf 'SANDBAR-STDERR\\n'; if [ "$b" -gt 0 ]; then head -c "$b" "$d/e" | od -An -tx1 -v; fi; printf 'SANDBAR-END\\n'`;
    const framePath = await receiptPath("exec", input.identity.submissionId);
    const receiptDirectory = framePath.slice(0, framePath.lastIndexOf("/"));
    const script = `mkdir -m 700 -- ${quote(receiptDirectory)} || exit 126; { ${capture}; } > ${quote(framePath)}; cat ${quote(framePath)}`;

    if (input.signal?.aborted)
      return unknown(input.identity.submissionId, "Daytona execution wait was aborted");

    try {
      input.onSubmit?.();

      const response = await this.json(
        "POST",
        `/process/execute`,
        CommandResponse,
        { command: script, cwd: input.cwd, timeout: input.deadlineSeconds },
        native,
        (input.deadlineSeconds + 10) * 1000,
      );

      if (response.exitCode === 126)
        return {
          status: "rejected",
          effect: "none",
          error: {
            code: "unavailable",
            message: "Daytona private execution receipt directory could not be reserved",
            effect: "none",
            retry: "never",
          },
        };

      if (response.exitCode !== 0)
        return unknown(input.identity.submissionId, "Daytona capture wrapper failed");

      return this.parseExecFrame(input.sandbox, input.identity.submissionId, max, response.result);
    } catch {
      return unknown(
        input.identity.submissionId,
        "Daytona execution response unavailable; do not replay",
      );
    }
  }
  private parseExecFrame(
    sandbox: SandboxRef,
    submissionId: string,
    max: number | undefined,
    result: string,
  ): DriverResult {
    const match =
      /^SANDBAR-EXEC-V1\n(-?\d+)\n(\d+)\n(\d+)\n([\da-f\s]*)SANDBAR-STDERR\n([\da-f\s]*)SANDBAR-END\n?$/.exec(
        result,
      );

    if (!match) return unknown(submissionId, "Daytona command response malformed");

    const decode = (hex: string): Uint8Array | null => {
      const trimmed = hex.trim();
      const tokens = trimmed ? trimmed.split(/\s+/) : [];

      if (tokens.some((token) => !/^[0-9a-f]{2}$/.test(token))) return null;

      return Uint8Array.from(tokens.map((token) => Number.parseInt(token, 16)));
    };

    const stdout = decode(match[4]!),
      stderr = decode(match[5]!);

    if (!stdout || !stderr) return unknown(submissionId, "Daytona capture output inconsistent");

    const stdoutCount = Number(match[2]),
      stderrCount = Number(match[3]);

    const bound = max ?? stdout.length + stderr.length;

    if (
      !stdout ||
      !stderr ||
      !Number.isSafeInteger(stdoutCount) ||
      !Number.isSafeInteger(stderrCount) ||
      stdoutCount < 0 ||
      stderrCount < 0 ||
      stdoutCount > bound + 1 ||
      stderrCount > bound + 1 ||
      stdout.length !== Math.min(stdoutCount, bound) ||
      stderr.length !== Math.min(stderrCount, bound - stdout.length) ||
      stdout.length + stderr.length > bound ||
      bound > 1_048_576
    )
      return unknown(submissionId, "Daytona capture output inconsistent");

    const observation = {
      ref: {
        scope: this.scope,
        nativeId: submissionId,
        kind: "execution" as const,
      },
      sandbox: sandbox,
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
      submissionId: submissionId,
      value: { kind: "execution", observation },
    });
  }
  async observeExec(input: {
    sandbox: SandboxRef;
    submissionId: string;
    maxOutputBytes?: number;
  }): Promise<DriverResult | null> {
    this.sameScope(input.sandbox);
    const native = await this.toolbox(input.sandbox);
    const path = await receiptPath("exec", input.submissionId);

    const response = await this.request(
      "GET",
      `/files/download?path=${encodeURIComponent(path)}`,
      undefined,
      undefined,
      native,
    );

    if (response.status === 404) return null;

    if (!response.ok) return null;

    try {
      const frame = new TextDecoder("utf-8", { fatal: true }).decode(
        await boundedBytes(response, 4_194_304),
      );

      if (!frame.includes("SANDBAR-END"))
        return {
          status: "pending",
          effect: "possible",
          submissionId: input.submissionId,
          observeAfterMs: 500,
        };

      return this.parseExecFrame(
        input.sandbox,
        input.submissionId,
        input.maxOutputBytes === undefined ? undefined : Math.min(input.maxOutputBytes, 1_048_576),
        frame,
      );
    } catch {
      return null;
    }
  }
  async readFile(input: {
    sandbox: SandboxRef;
    path: string;
    signal?: AbortSignal;
  }): Promise<Uint8Array> {
    validPath(input.path);
    const native = await this.toolbox(input.sandbox);

    input.signal?.throwIfAborted();

    const response = await this.request(
      "GET",
      `/files/download?path=${encodeURIComponent(input.path)}`,
      undefined,
      undefined,
      native,
      30_000,
      input.signal,
    );

    if (response.status === 404) throw new ProviderReadError("NOT_FOUND", "Daytona file not found");

    if (!response.ok)
      throw new ProviderReadError("INVALID_RESPONSE", "Daytona file download failed");

    try {
      return await boundedBytes(response, 1_048_576, input.signal);
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
    signal?: AbortSignal;
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

    const mounted = volumeContains(native, input.path);

    if (mounted && !input.overwrite)
      return {
        status: "rejected",
        effect: "none",
        error: {
          code: "unsupported",
          message: "Daytona mounted volumes cannot enforce atomic no-clobber writes",
          effect: "none",
          retry: "never",
        },
      };

    // Object-backed mounts cannot chmod a private stage; overwrite commits do not require a same-filesystem link.
    const stageParent = mounted ? "/tmp/" : input.path.slice(0, input.path.lastIndexOf("/") + 1);

    const stageDirectory = `${stageParent}.sandbar-${Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.identity.submissionId)),
    )
      .toString("hex")
      .slice(0, 32)}`;

    const temporaryPath = `${stageDirectory}/payload`;

    if (temporaryPath.length > 4096)
      return {
        status: "rejected",
        effect: "none",
        error: {
          code: "invalid",
          message: "Daytona staging path exceeds limit",
          effect: "none",
          retry: "never",
        },
      };
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(input.bytes)]), "blob");

    if (input.signal?.aborted)
      return unknown(input.identity.submissionId, "Daytona file write wait was aborted");

    try {
      const markerPath = await receiptPath("write", input.identity.submissionId);
      const receiptDirectory = markerPath.slice(0, markerPath.lastIndexOf("/"));

      if (volumeContains(native, stageDirectory) || volumeContains(native, receiptDirectory))
        return {
          status: "rejected",
          effect: "none",
          error: {
            code: "unsupported",
            message: "Daytona mounted volume covers private file staging or receipt storage",
            effect: "none",
            retry: "never",
          },
        };

      const reserved = await this.json(
        "POST",
        "/process/execute",
        CommandResponse,
        {
          command: `mkdir -m 700 -- ${quote(stageDirectory)} || exit 126; mkdir -m 700 -- ${quote(receiptDirectory)} || { rmdir -- ${quote(stageDirectory)}; exit 126; }`,
          timeout: 30,
        },
        native,
      );

      if (reserved.exitCode !== 0)
        return {
          status: "rejected",
          effect: "none",
          error: {
            code: "unavailable",
            message: "Daytona private staging directory could not be reserved",
            effect: "none",
            retry: "never",
          },
        };

      if (input.signal?.aborted)
        return unknown(input.identity.submissionId, "Daytona file write wait was aborted");

      let response: Response | null = null;

      try {
        response = await this.request(
          "POST",
          `/files/upload-v2?path=${encodeURIComponent(temporaryPath)}`,
          form,
          undefined,
          native,
        );
      } catch {
        // A lost upload response may still have written the unique stage.
        // The subsequent read, never another upload, decides whether to commit.
      }

      if (response && !response.ok)
        return unknown(input.identity.submissionId, "Daytona upload response unavailable");

      if (response) {
        const receipt = await boundedJson(response, UploadResponse, 16_384);

        if (receipt.path !== temporaryPath)
          return unknown(input.identity.submissionId, "Daytona upload path mismatch");
      }

      const actual = await this.readFile({ sandbox: input.sandbox, path: temporaryPath });

      if (
        actual.length !== input.bytes.length ||
        !actual.every((byte, i) => byte === input.bytes[i])
      )
        return unknown(input.identity.submissionId, "Daytona upload bytes could not be verified");

      if (input.signal?.aborted)
        return unknown(input.identity.submissionId, "Daytona file write wait was aborted");

      // Root no-clobber stages share the destination directory for atomic link(2).
      // Overwrite copies verified private bytes and checks the completed destination.
      const action = input.overwrite
        ? `cat ${quote(temporaryPath)} > ${quote(input.path)}`
        : `ln -T -- ${quote(temporaryPath)} ${quote(input.path)}`;

      const digest = Buffer.from(
        await crypto.subtle.digest("SHA-256", new Uint8Array(input.bytes)),
      ).toString("hex");

      const marker = JSON.stringify({
        v: 1,
        submissionId: input.identity.submissionId,
        path: input.path,
        digest,
        bytesWritten: input.bytes.length,
      });

      const markerStage = `${markerPath}.tmp`;
      const command = `${action}; rc=$?; if [ "$rc" -eq 0 ]; then (printf '%s' ${quote(marker)} > ${quote(markerStage)} && mv -f -- ${quote(markerStage)} ${quote(markerPath)}) || rc=125; fi; rm -f ${quote(temporaryPath)} ${quote(markerStage)} || rc=125; rmdir -- ${quote(stageDirectory)} || rc=125; exit "$rc"`;

      const committed = await this.json(
        "POST",
        "/process/execute",
        CommandResponse,
        { command, timeout: 30 },
        native,
      );

      if (committed.exitCode !== 0) {
        if (!input.overwrite && committed.exitCode !== undefined && committed.exitCode !== 125) {
          try {
            await this.readFile({ sandbox: input.sandbox, path: input.path });

            return {
              status: "rejected",
              effect: "none",
              error: {
                code: "conflict",
                message: "Daytona destination already exists",
                effect: "none",
                retry: "never",
              },
            };
          } catch {
            return unknown(
              input.identity.submissionId,
              "Daytona atomic link failed without a confirmed conflict",
            );
          }
        }

        return unknown(input.identity.submissionId, "Daytona file commit failed");
      }

      const finalBytes = await this.readFile({ sandbox: input.sandbox, path: input.path });

      if (
        finalBytes.length !== input.bytes.length ||
        !finalBytes.every((byte, i) => byte === input.bytes[i])
      )
        return unknown(
          input.identity.submissionId,
          "Daytona file commit bytes could not be verified",
        );

      return {
        status: "completed",
        effect: "applied",
        submissionId: input.identity.submissionId,
        value: {
          kind: "file_write",
          observation: {
            sandbox: input.sandbox,
            path: input.path,
            bytesWritten: finalBytes.length,
            complete: true,
          },
        },
      };
    } catch {
      return unknown(input.identity.submissionId, "Daytona upload outcome unknown; do not replay");
    }
  }
  async observeWrite(input: {
    sandbox: SandboxRef;
    submissionId: string;
    path?: string;
    digest?: string;
  }): Promise<DriverResult | null> {
    this.sameScope(input.sandbox);
    const native = await this.toolbox(input.sandbox);
    const markerPath = await receiptPath("write", input.submissionId);

    const response = await this.request(
      "GET",
      `/files/download?path=${encodeURIComponent(markerPath)}`,
      undefined,
      undefined,
      native,
    );

    if (response.status === 404) return null;

    if (!response.ok) return null;
    let receipt: z.infer<typeof WriteReceipt>;

    try {
      receipt = WriteReceipt.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(response, 16_384)),
        ),
      );
    } catch {
      return null;
    }

    if (
      receipt.submissionId !== input.submissionId ||
      (input.path && receipt.path !== input.path) ||
      (input.digest && receipt.digest !== input.digest)
    )
      return null;
    const actual = await this.readFile({ sandbox: input.sandbox, path: receipt.path });

    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", new Uint8Array(actual)),
    ).toString("hex");

    if (actual.length !== receipt.bytesWritten || digest !== receipt.digest)
      return unknown(input.submissionId, "Daytona write receipt and file disagree");

    return {
      status: "completed",
      effect: "applied",
      submissionId: input.submissionId,
      value: {
        kind: "file_write",
        observation: {
          sandbox: input.sandbox,
          path: receipt.path,
          bytesWritten: actual.length,
          complete: true,
        },
      },
    };
  }
  async destroyRetainedResources(sandbox: SandboxRef): Promise<string[] | undefined> {
    this.sameScope(sandbox);
    const value = await this.sandboxDetail(sandbox.nativeId);

    if (!value?.labels) return undefined;

    const snapshotId = value?.labels?.["sandbar.imageSnapshot"];

    return snapshotId ? [`daytona:snapshot:${snapshotId}`] : [];
  }
  async destroy(input: {
    sandbox: SandboxRef;
    identity: InvocationIdentity;
    signal?: AbortSignal;
    retainedResources?: string[];
  }): Promise<DriverResult & { deletionAccepted?: boolean }> {
    this.sameScope(input.sandbox);

    if (input.signal?.aborted)
      return {
        status: "rejected",
        effect: "none",
        error: {
          code: "unavailable",
          message: "Daytona deletion cancelled before dispatch",
          effect: "none",
          retry: "never",
        },
      };

    let retainedResources: string[] | undefined;

    try {
      retainedResources =
        "retainedResources" in input
          ? input.retainedResources
          : await this.destroyRetainedResources(input.sandbox);
    } catch {
      return {
        status: "rejected",
        effect: "none",
        error: {
          code: "unavailable",
          message: "Daytona inspection failed before deletion",
          effect: "none",
          retry: "never",
        },
      };
    }

    try {
      if (input.signal?.aborted)
        return {
          status: "rejected",
          effect: "none",
          error: {
            code: "unavailable",
            message: "Daytona deletion cancelled before dispatch",
            effect: "none",
            retry: "never",
          },
        };

      const response = await this.request(
        "DELETE",
        `/sandbox/${encodeURIComponent(input.sandbox.nativeId)}`,
      );

      if (!response.ok) throw new Error(`Daytona HTTP ${response.status}`);

      // Native deletion acknowledges dispatch before asynchronous termination.
      // Persist this acknowledgment; a lost response must never gain this authority.
      const pending = () => ({
        status: "pending" as const,
        effect: "possible" as const,
        submissionId: input.identity.submissionId,
        observeAfterMs: 500,
        deletionAccepted: true,
      });

      let value: Sandbox;

      try {
        value = await boundedJson(response, NativeSandbox);
      } catch {
        return pending();
      }

      if (
        value.id !== input.sandbox.nativeId ||
        value.organizationId !== this.scope.accountId ||
        value.target !== this.scope.region
      )
        return unknown(input.identity.submissionId, "Daytona deletion identity mismatched");

      if (value.state !== "destroyed") return pending();

      if (retainedResources === undefined && value.labels) {
        const snapshotId = value.labels["sandbar.imageSnapshot"];

        retainedResources = snapshotId ? [`daytona:snapshot:${snapshotId}`] : [];
      }

      if (retainedResources === undefined)
        return unknown(
          input.identity.submissionId,
          "Daytona compute is stopped but retained resource evidence is unavailable",
        );

      return {
        status: "completed",
        effect: "applied",
        submissionId: input.identity.submissionId,
        value: {
          kind: "destroy",
          observation: {
            sandbox: input.sandbox,
            computeStopped: true,
            retainedResources,
          },
        },
      };
    } catch {
      return unknown(
        input.identity.submissionId,
        "Daytona deletion outcome unknown; do not replay",
      );
    }
  }
  async observeDestroy(
    sandbox: SandboxRef,
    submissionId: string,
    retainedResources?: string[],
    deletionMayHaveDispatched = false,
  ): Promise<DriverResult | null> {
    this.sameScope(sandbox);
    const value = await this.sandboxDetail(sandbox.nativeId);

    if (!value) {
      if (!deletionMayHaveDispatched || retainedResources === undefined) return null;

      return {
        status: "completed",
        effect: "applied",
        submissionId,
        value: {
          kind: "destroy",
          observation: {
            sandbox,
            computeStopped: true,
            retainedResources,
          },
        },
      };
    }

    if (value.state === "destroying")
      return { status: "pending", effect: "possible", submissionId, observeAfterMs: 500 };

    if (value.state !== "destroyed") return null;

    if (retainedResources === undefined && value.labels === undefined)
      return unknown(
        submissionId,
        "Daytona compute is stopped but retained resource evidence is unavailable",
      );

    return {
      status: "completed",
      effect: "applied",
      submissionId,
      value: {
        kind: "destroy",
        observation: {
          sandbox,
          computeStopped: true,
          retainedResources:
            retainedResources ??
            (value.labels?.["sandbar.imageSnapshot"]
              ? [`daytona:snapshot:${value.labels["sandbar.imageSnapshot"]}`]
              : []),
        },
      },
    };
  }
}

export function daytonaRegistration(
  fetchImpl?: typeof fetch,
  trustedEndpoints: DaytonaEndpointPair[] = [],
) {
  return {
    provider: "daytona" as const,
    catalog: {
      displayName: "Daytona",
      configurationSchema: z.toJSONSchema(Input.shape.configuration, {
        io: "input",
        unrepresentable: "any",
      }),
      credentialsSchema: z.toJSONSchema(Input.shape.credentials),
    },
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
      networkPolicy: input.networkPolicy ?? "blocked",
      ttlMinutes: String(input.ttlMinutes ?? 60),
    },
  });

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${config.configuration.apiUrl}|${config.configuration.target}|${config.configuration.toolboxOrigin}${config.configuration.networkPolicy === "daytona-default" ? "|daytona-default" : ""}`,
    ),
  );

  const connectionId = `daytona_${Buffer.from(digest).toString("hex")}`;

  return daytonaRegistration(input.fetch, input.trustedEndpoints).connect({
    credentials: config.credentials,
    configuration: { ...config.configuration, ttlMinutes: String(config.configuration.ttlMinutes) },
    connectionId,
  });
}

export { daytonaAdapter, createDaytonaAdapter } from "./adapter";
