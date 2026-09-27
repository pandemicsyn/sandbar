import type { Scope } from "@sandbar/adapter";
import { AdapterSandbox, type AdapterDirectClient } from "sandbar-sdk/direct";
import {
  NativeScope,
  ProviderReadError,
  type DriverResult,
  type InvocationIdentity,
  type ProviderDriver,
  type SandboxRef,
} from "@sandbar/provider-spi";

export function adapterNativeScope(provider: string, connectionId: string, scope: Scope): NativeScope {
  return NativeScope.parse({
    provider,
    connectionId,
    accountId: `${scope.authority.kind}:${scope.authority.id}`,
    region: scope.partition.region,
    endpoint: scope.partition.endpoint,
    adapterScope: scope,
  });
}

export class AdapterProviderDriver implements ProviderDriver {
  constructor(
    readonly name: string,
    readonly scope: NativeScope,
    readonly connection: AdapterDirectClient,
  ) {}
  async capabilities() {
    const caps = this.connection.capabilities();
    return {
      provider: this.name,
      nativeIdempotency: { create: false, exec: false, destroy: false, writeFile: false },
      discoveryBySubmission: true,
      supports: {
        argv: caps.exec && caps.commands.includes("argv"),
        shell: caps.exec && caps.commands.includes("shell"),
        fileBytes: caps.readFile || caps.writeFile,
        inventory: caps.inventory,
      },
      maxFileBytes: caps.maxFileBytes,
      maxOutputBytes: caps.maxOutputBytes,
      networkPolicies: [...caps.network],
    };
  }
  async prepare(): Promise<never> { throw new Error("Adapter mutations use the normalized service operation path"); }
  async create(_input: { scope: NativeScope; identity: InvocationIdentity; image: string; networkPolicy: string; labels?: Record<string, string> }): Promise<DriverResult> {
    throw new Error("Adapter mutations use the normalized service operation path");
  }
  async inspect(ref: SandboxRef) {
    if (ref.scope.connectionId !== this.scope.connectionId)
      throw new ProviderReadError("UNAUTHENTICATED", "Sandbox scope mismatch");
    const sandbox = new AdapterSandbox(this.connection, ref.nativeId);
    const result = await sandbox.inspect();
    return { ref, state: result.state, observedAt: new Date().toISOString() };
  }
  async inventory(input: { scope: NativeScope; cursor?: string; limit: number }) {
    if (input.scope.connectionId !== this.scope.connectionId)
      throw new ProviderReadError("UNAUTHENTICATED", "Inventory scope mismatch");
    const result = await this.connection.operations.inventory({ cursor: input.cursor, limit: input.limit });
    return {
      items: result.items.map((item) => ({
        ref: { kind: "sandbox" as const, scope: this.scope, nativeId: item.id },
        state: item.state, observedAt: new Date().toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  }
  async exec(): Promise<DriverResult> { throw new Error("Adapter mutations use normalized service path"); }
  async readFile(input: { sandbox: SandboxRef; path: string }): Promise<Uint8Array> {
    if (input.sandbox.scope.connectionId !== this.scope.connectionId)
      throw new ProviderReadError("UNAUTHENTICATED", "Sandbox scope mismatch");
    return new AdapterSandbox(this.connection, input.sandbox.nativeId).readFile(input.path);
  }
  async writeFile(): Promise<DriverResult> { throw new Error("Adapter mutations use normalized service path"); }
  async destroy(): Promise<DriverResult> { throw new Error("Adapter mutations use normalized service path"); }
  async observe(): Promise<DriverResult | null> { throw new Error("Adapter observations use normalized service path"); }
}
