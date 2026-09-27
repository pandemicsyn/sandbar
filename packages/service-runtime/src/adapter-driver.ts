import type { Scope } from "sandbar-adapter";
import { AdapterSandbox, type AdapterDirectClient } from "sandbar-sdk";
import { NativeScope, ProviderReadError, type SandboxRef } from "@sandbar/provider-spi";

export function adapterNativeScope(
  provider: string,
  connectionId: string,
  scope: Scope,
): NativeScope {
  return NativeScope.parse({
    provider,
    connectionId,
    accountId: `${scope.authority.kind}:${scope.authority.id}`,
    region: scope.partition.region,
    adapterScope: scope,
  });
}

export class AdapterProviderDriver {
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

    const result = await this.connection.operations.inventory({
      cursor: input.cursor,
      limit: input.limit,
    });

    return {
      items: result.items.map((item) => ({
        ref: { kind: "sandbox" as const, scope: this.scope, nativeId: item.id },
        state: item.state,
        observedAt: new Date().toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  }
  async readFile(input: { sandbox: SandboxRef; path: string }): Promise<Uint8Array> {
    if (input.sandbox.scope.connectionId !== this.scope.connectionId)
      throw new ProviderReadError("UNAUTHENTICATED", "Sandbox scope mismatch");

    return new AdapterSandbox(this.connection, input.sandbox.nativeId).readFile(input.path);
  }
}
