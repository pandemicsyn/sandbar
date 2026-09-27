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
import type { ExecCommand } from "@sandbar/contracts";
import { z } from "zod";
import { FakeAction } from "./protocol";
import { FakeEvent, FakeFileBytesBase64 } from "./engine";

const InventoryResponse = z.strictObject({
  items: z.array(SandboxObservation),
  nextCursor: z.string().optional(),
});

const FakeHttpJson = z.json();

export class FakeProviderDriver implements ProviderDriver {
  readonly name = "fake";
  private readonly endpoint: string;
  private readonly token: string;
  private readonly transport: typeof fetch;
  constructor(options: { baseUrl: string; token: string; fetch?: typeof fetch }) {
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
    this.token = options.token;
    this.transport = options.fetch ?? fetch;
  }

  private async call(action: FakeAction): Promise<z.infer<typeof FakeHttpJson>> {
    const response = await this.transport(this.endpoint, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(action),
    });

    if (!response.ok) throw new FakeTransportError(response.status);

    return FakeHttpJson.parse(await response.json());
  }
  private async mutation(action: FakeAction, submissionId: string): Promise<DriverResult> {
    try {
      return DriverResult.parse(await this.call(action));
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
    return DriverCapabilities.parse(await this.call({ kind: "capabilities", scope }));
  }
  async prepare(input: {
    scope: NativeScope;
    image: { kind: "prepared" | "oci"; value: string };
    networkPolicy: string;
    region?: string;
  }) {
    const cap = await this.capabilities(input.scope);

    const supported =
      input.image.kind === "prepared" &&
      input.image.value === "fake-starter" &&
      input.networkPolicy === "blocked" &&
      (!input.region || input.region === "local") &&
      cap.networkPolicies.includes("blocked");

    return supported
      ? { supported: true, effectiveImage: "fake-starter" }
      : {
          supported: false,
          reason:
            "Fake provider only supports prepared fake-starter, local region, blocked network",
        };
  }
  async create(input: {
    scope: NativeScope;
    identity: InvocationIdentity;
    image: string;
    networkPolicy: string;
    labels?: Record<string, string>;
  }) {
    return this.mutation(
      {
        kind: "create",
        scope: input.scope,
        identity: input.identity,
        image: input.image,
        networkPolicy: input.networkPolicy,
        labels: input.labels,
      },
      input.identity.submissionId,
    );
  }
  async inspect(ref: SandboxRef) {
    const value = await this.call({ kind: "inspect", ref });

    return value === null ? null : SandboxObservation.parse(value);
  }
  async inventory(input: { scope: NativeScope; cursor?: string; limit: number }) {
    return InventoryResponse.parse(await this.call({ kind: "inventory", ...input }));
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
      .safeParse(await this.call({ kind: "readFile", ...input }));

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
  async observe(input: { scope: NativeScope; submissionId: string }) {
    const value = await this.call({ kind: "observe", ...input });

    return value === null ? null : DriverResult.parse(value);
  }
  async events(scope: NativeScope) {
    const value = await this.call({ kind: "events", scope });

    return FakeEvent.array().parse(value);
  }
}

export { FakeScenario, FakeProfile, FakeEvent } from "./engine";

export { startFakeProviderServer } from "./server";

class FakeTransportError extends Error {
  constructor(readonly status: number) {
    super(`Fake provider transport status ${status}`);
  }
}
