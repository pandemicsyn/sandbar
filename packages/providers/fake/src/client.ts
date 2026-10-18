import {
  DriverCapabilities,
  DriverResult,
  SandboxObservation,
  NativeScope,
  ProviderReadError,
  type ProviderDriver,
  type SandboxRef,
  type InvocationIdentity,
} from "@sandbar/provider-spi";
import type { ExecCommand } from "@sandbar-sdk/adapter/portable";
import { z } from "zod";
import {
  FAKE_STARTER_IMAGE,
  FakeAction,
  FakeInventoryCursor,
  FakeEvent,
  FakeFileBytesBase64,
  FakeImage,
  FakeImageDeleteResult,
} from "./protocol";

const InventoryResponse = z.strictObject({
  items: z.array(SandboxObservation),
  nextCursor: FakeInventoryCursor.optional(),
});

const FakeHttpJson = z.json();

type MutationAction = Extract<FakeAction, { kind: "create" | "exec" | "writeFile" | "destroy" }>;

const sameScope = (left: NativeScope, right: NativeScope) =>
  left.provider === right.provider &&
  left.connectionId === right.connectionId &&
  left.accountId === right.accountId &&
  left.region === right.region;

const sameSandbox = (left: SandboxRef, right: SandboxRef) =>
  left.nativeId === right.nativeId && sameScope(left.scope, right.scope);

const completedMatchesAction = (action: MutationAction, result: DriverResult) => {
  if (result.status !== "completed") return true;
  const value = result.value;

  switch (action.kind) {
    case "create":
      return value.kind === "sandbox" && sameScope(value.observation.ref.scope, action.scope);
    case "exec":
      return value.kind === "execution" && sameSandbox(value.observation.sandbox, action.sandbox);
    case "writeFile": {
      if (value.kind !== "file_write" || !sameSandbox(value.observation.sandbox, action.sandbox))
        return false;
      const receipt = value.observation;
      const requestedBytes = Buffer.from(action.bytesBase64, "base64").length;

      return (
        receipt.path === action.path &&
        receipt.bytesWritten <= requestedBytes &&
        (!receipt.complete || receipt.bytesWritten === requestedBytes)
      );
    }

    case "destroy":
      return value.kind === "destroy" && sameSandbox(value.observation.sandbox, action.sandbox);
  }
};

const completedMatchesScope = (scope: NativeScope, result: DriverResult) => {
  if (result.status !== "completed") return true;
  const value = result.value;

  const effectScope =
    value.kind === "sandbox" ? value.observation.ref.scope : value.observation.sandbox.scope;

  return sameScope(effectScope, scope);
};

export class FakeProviderDriver implements ProviderDriver {
  readonly name = "fake";
  private readonly endpoint: string;
  readonly #token: string;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: {
    baseUrl: string;
    token: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    const endpoint = new URL(options.baseUrl);

    if (
      (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
      (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "[::1]") ||
      endpoint.username ||
      endpoint.password
    ) {
      throw new Error("Fake provider driver requires a loopback HTTP endpoint");
    }

    this.endpoint = new URL("/v1/action", endpoint).href;
    this.#token = options.token;
    this.transport = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;

    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0)
      throw new Error("Fake provider request timeout must be a positive integer in milliseconds");
  }

  private async call(action: FakeAction): Promise<z.infer<typeof FakeHttpJson>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.transport(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        body: JSON.stringify(action),
        signal: controller.signal,
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new FakeTransportError(response.status);
      }

      return FakeHttpJson.parse(await response.json());
    } finally {
      clearTimeout(timer);
    }
  }
  private async readCall(action: FakeAction): Promise<z.infer<typeof FakeHttpJson>> {
    try {
      return await this.call(action);
    } catch (error) {
      if (error instanceof FakeTransportError && (error.status === 401 || error.status === 403))
        throw new ProviderReadError("UNAUTHENTICATED", "Fake provider authentication failed");
      throw error;
    }
  }
  private async mutation(action: MutationAction, submissionId: string): Promise<DriverResult> {
    try {
      const result = DriverResult.parse(await this.call(action));

      if (
        ((result.status === "pending" || result.status === "unknown") &&
          result.submissionId !== submissionId) ||
        (result.status === "completed" &&
          result.submissionId !== undefined &&
          result.submissionId !== submissionId) ||
        !completedMatchesAction(action, result)
      ) {
        throw new Error("Fake provider returned a result for a different mutation");
      }

      return result;
    } catch (error) {
      if (error instanceof FakeTransportError && [400, 401, 403, 404, 413].includes(error.status)) {
        const code =
          error.status === 401 || error.status === 403
            ? "unauthorized"
            : error.status === 404
              ? "not_found"
              : error.status === 413
                ? "capacity"
                : "invalid";

        return {
          status: "rejected",
          effect: "none",
          error: {
            code,
            message: `Fake provider rejected request before dispatch (${error.status})`,
            effect: "none",
            retry: "never",
          },
        };
      }

      return {
        status: "unknown",
        effect: "possible",
        submissionId,
        reason: "Fake provider submission response unavailable or invalid; observe without replay",
      };
    }
  }
  async capabilities(scope: NativeScope) {
    const capabilities = DriverCapabilities.parse(
      await this.readCall({ kind: "capabilities", scope }),
    );

    if (capabilities.provider !== this.name) {
      throw new ProviderReadError("INVALID_RESPONSE", "Fake capabilities named another provider");
    }

    return capabilities;
  }
  async prepare(input: {
    scope: NativeScope;
    image: { kind: "prepared" | "oci"; value: string };
    networkPolicy: string;
    region?: string;
  }) {
    const cap = await this.capabilities(input.scope);

    const known =
      input.image.kind === "prepared" &&
      (input.image.value === FAKE_STARTER_IMAGE ||
        (FakeImage.shape.id.safeParse(input.image.value).success &&
          (await this.inspectImage(input.scope, { imageId: input.image.value })) !== null));

    const supported =
      known &&
      input.networkPolicy === "blocked" &&
      (!input.region || input.region === "local") &&
      cap.networkPolicies.includes("blocked");

    return supported
      ? { supported: true, effectiveImage: input.image.value }
      : {
          supported: false,
          reason:
            "Fake provider only supports prepared fake-starter or a built image, local region, blocked network",
        };
  }
  async create(input: {
    scope: NativeScope;
    identity: InvocationIdentity;
    image: string;
    networkPolicy: string;
    labels?: Record<string, string>;
    env?: Record<string, string>;
  }) {
    return this.mutation(
      {
        kind: "create",
        scope: input.scope,
        identity: input.identity,
        image: input.image,
        networkPolicy: input.networkPolicy,
        labels: input.labels,
        env: input.env,
      },
      input.identity.submissionId,
    );
  }
  async inspect(ref: SandboxRef) {
    const value = await this.readCall({ kind: "inspect", ref });

    if (value === null) return null;
    const observation = SandboxObservation.parse(value);

    if (!sameSandbox(observation.ref, ref)) {
      throw new ProviderReadError("INVALID_RESPONSE", "Fake inspect returned another sandbox");
    }

    return observation;
  }
  async inventory(input: { scope: NativeScope; cursor?: string; limit: number }) {
    const parsed = InventoryResponse.safeParse(
      await this.readCall({ kind: "inventory", ...input }),
    );

    if (!parsed.success) {
      throw new ProviderReadError("INVALID_RESPONSE", "Fake inventory response is invalid");
    }

    const response = parsed.data;

    if (response.items.some((item) => !sameScope(item.ref.scope, input.scope))) {
      throw new ProviderReadError("INVALID_RESPONSE", "Fake inventory returned a foreign scope");
    }

    return response;
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
    return this.mutation(
      {
        kind: "exec",
        sandbox: input.sandbox,
        identity: input.identity,
        command: input.command,
        cwd: input.cwd,
        env: input.env,
        deadlineSeconds: input.deadlineSeconds,
        maxOutputBytes: input.maxOutputBytes,
      },
      input.identity.submissionId,
    );
  }
  async readFile(input: { sandbox: SandboxRef; path: string }): Promise<Uint8Array> {
    const parsed = z
      .strictObject({ bytesBase64: FakeFileBytesBase64.nullable() })
      .safeParse(await this.readCall({ kind: "readFile", ...input }));

    if (!parsed.success)
      throw new ProviderReadError("INVALID_RESPONSE", "Fake provider returned invalid file data");

    if (parsed.data.bytesBase64 === null)
      throw new ProviderReadError("NOT_FOUND", "Fake file not found");

    return Uint8Array.from(Buffer.from(parsed.data.bytesBase64, "base64"));
  }
  async writeFile(input: {
    sandbox: SandboxRef;
    identity: InvocationIdentity;
    path: string;
    bytes: Uint8Array;
    overwrite: boolean;
  }): Promise<DriverResult> {
    return this.mutation(
      {
        kind: "writeFile",
        sandbox: input.sandbox,
        identity: input.identity,
        path: input.path,
        bytesBase64: Buffer.from(input.bytes).toString("base64"),
        overwrite: input.overwrite,
      },
      input.identity.submissionId,
    );
  }
  async destroy(input: { sandbox: SandboxRef; identity: InvocationIdentity }) {
    return this.mutation({ kind: "destroy", ...input }, input.identity.submissionId);
  }
  async observe(input: { scope: NativeScope; submissionId: string; operationId?: string }) {
    const value = await this.readCall({
      kind: "observe",
      scope: input.scope,
      submissionId: input.submissionId,
    });

    if (value === null) return null;
    const result = DriverResult.parse(value);

    if (
      ((result.status === "pending" || result.status === "unknown") &&
        result.submissionId !== input.submissionId) ||
      (result.status === "completed" && result.submissionId !== input.submissionId) ||
      !completedMatchesScope(input.scope, result)
    ) {
      throw new ProviderReadError("INVALID_RESPONSE", "Fake observation mismatches its request");
    }

    return result;
  }
  /** Submit one build; a lost or invalid response is unknown and is never resubmitted. */
  async buildImage(input: { scope: NativeScope; identity: InvocationIdentity; source: string }) {
    let value: z.infer<typeof FakeHttpJson>;

    try {
      value = await this.call({ kind: "imageBuild", ...input });
    } catch (error) {
      if (error instanceof FakeTransportError && [400, 401, 403, 413].includes(error.status))
        return {
          status: "rejected" as const,
          reason: `Fake image build rejected (${error.status})`,
        };

      return { status: "unknown" as const, reason: "Fake image build response unavailable" };
    }

    const parsed = z
      .strictObject({ image: FakeImage.nullable(), created: z.boolean() })
      .safeParse(value);

    if (!parsed.success)
      return { status: "unknown" as const, reason: "Fake image build response is invalid" };

    if (!parsed.data.image)
      return { status: "rejected" as const, reason: "Fake image build was not accepted" };

    if (
      parsed.data.image.submissionId !== input.identity.submissionId ||
      parsed.data.image.source !== input.source
    )
      return { status: "unknown" as const, reason: "Fake image build returned another image" };

    return {
      status: "completed" as const,
      image: parsed.data.image,
      created: parsed.data.created,
    };
  }
  async inspectImage(scope: NativeScope, query: { imageId?: string; submissionId?: string }) {
    const value = await this.readCall({ kind: "imageInspect", scope, ...query });

    if (value === null) return null;
    const image = FakeImage.safeParse(value);

    if (
      !image.success ||
      (query.imageId !== undefined && image.data.id !== query.imageId) ||
      (query.submissionId !== undefined && image.data.submissionId !== query.submissionId)
    )
      throw new ProviderReadError(
        "INVALID_RESPONSE",
        "Fake image inspection returned another image",
      );

    return image.data;
  }
  async listImages(input: { scope: NativeScope; cursor?: string; limit: number }) {
    const parsed = z
      .strictObject({
        items: z.array(FakeImage).max(input.limit),
        nextCursor: FakeInventoryCursor.optional(),
      })
      .safeParse(await this.readCall({ kind: "imageList", ...input }));

    if (!parsed.success)
      throw new ProviderReadError("INVALID_RESPONSE", "Fake image inventory response is invalid");

    return parsed.data;
  }
  /** Submit one delete; a lost or invalid response is unknown and is never resubmitted. */
  async deleteImage(input: { scope: NativeScope; identity: InvocationIdentity; imageId: string }) {
    let value: z.infer<typeof FakeHttpJson>;

    try {
      value = await this.call({ kind: "imageDelete", ...input });
    } catch (error) {
      if (error instanceof FakeTransportError && [400, 401, 403, 413].includes(error.status))
        return { status: "transport_rejected" as const, httpStatus: error.status };

      return { status: "unknown" as const };
    }

    const parsed = FakeImageDeleteResult.safeParse(value);

    return parsed.success && parsed.data.imageId === input.imageId
      ? parsed.data
      : { status: "unknown" as const };
  }
  async events(scope: NativeScope) {
    const value = await this.readCall({ kind: "events", scope });
    const events = FakeEvent.array().parse(value);

    if (events.some((event) => !sameScope(event.ref.scope, scope))) {
      throw new ProviderReadError("INVALID_RESPONSE", "Fake events returned a foreign scope");
    }

    return events;
  }
}

/** Fixture-only scope: binds recovery to this exact fake endpoint without exposing its token. */
export async function fakeProvider(options: {
  url: string;
  token: string;
  fetch?: typeof fetch;
}): Promise<{ driver: FakeProviderDriver; scope: NativeScope }> {
  const endpoint = new URL(options.url);

  const driver = new FakeProviderDriver({
    baseUrl: endpoint.href,
    token: options.token,
    fetch: options.fetch,
  });

  // The driver always sends to /v1/action, so path, query, and fragment are not endpoint identity.
  const canonical = endpoint.origin;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const connectionId = `fake_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

  const scope = NativeScope.parse({
    provider: "fake",
    connectionId,
    accountId: "fake-local",
    region: "local",
  });

  const caps = await driver.capabilities(scope);

  if (caps.provider !== "fake") throw new Error("Fake provider identity mismatch");

  return { driver, scope };
}

class FakeTransportError extends Error {
  constructor(readonly status: number) {
    super(`Fake provider transport status ${status}`);
  }
}
