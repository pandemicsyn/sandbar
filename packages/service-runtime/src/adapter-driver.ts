import {
  AdapterError,
  type AdapterConnection,
  type AdapterSession,
  type Scope,
} from "@sandbar/adapter";
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

async function collectFile(value: Uint8Array | ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  if (value instanceof Uint8Array) {
    if (value.length > limit) throw new AdapterError("CAPACITY", "File exceeds adapter limit");
    return Uint8Array.from(value);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = value.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || total + part.value.length > limit)
        throw new AdapterError("CAPACITY", "File exceeds adapter limit");
      chunks.push(Uint8Array.from(part.value));
      total += part.value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export class AdapterProviderDriver implements ProviderDriver {
  constructor(
    readonly name: string,
    readonly scope: NativeScope,
    readonly connection: AdapterConnection<AdapterSession>,
  ) {}
  private get session() { return this.connection.session; }
  async capabilities() {
    const session = this.session;
    return {
      provider: this.name,
      nativeIdempotency: { create: false, exec: false, destroy: false, writeFile: false },
      discoveryBySubmission: [session.create, session.destroy, session.exec, session.files?.write].some(
        (operation) => typeof operation === "object" && !!operation?.observe,
      ),
      supports: {
        argv: !!session.exec && !!session.supports.exec?.commands.includes("argv"),
        shell: !!session.exec && !!session.supports.exec?.commands.includes("shell"),
        fileBytes: !!session.files?.read || !!session.files?.write,
        inventory: !!session.inventory,
      },
      maxFileBytes: session.files?.maxBytes ?? 0,
      maxOutputBytes: session.supports.exec?.maxOutputBytes ?? 0,
      networkPolicies: [...session.supports.network],
    };
  }
  async prepare(): Promise<never> { throw new Error("Adapter mutations use the normalized service operation path"); }
  async create(_input: { scope: NativeScope; identity: InvocationIdentity; image: string; networkPolicy: string; labels?: Record<string, string> }): Promise<DriverResult> {
    throw new Error("Adapter mutations use the normalized service operation path");
  }
  async inspect(ref: SandboxRef) {
    if (!this.session.inspect) throw new AdapterError("UNSUPPORTED", "Inspection is unsupported");
    if (ref.scope.connectionId !== this.scope.connectionId)
      throw new ProviderReadError("UNAUTHENTICATED", "Sandbox scope mismatch");
    const result = await this.session.inspect({ id: ref.nativeId }, {
      signal: this.connection.signal, deadline: Date.now() + 30_000,
    });
    if (!result) return null;
    if (result.id !== ref.nativeId)
      throw new ProviderReadError("INVALID_RESPONSE", "Adapter inspection identity mismatch");
    return {
      ref, state: result.state, observedAt: new Date().toISOString(),
    };
  }
  async inventory(input: { scope: NativeScope; cursor?: string; limit: number }) {
    if (!this.session.inventory) throw new AdapterError("UNSUPPORTED", "Inventory is unsupported");
    const result = await this.session.inventory({ cursor: input.cursor, limit: input.limit }, {
      signal: this.connection.signal, deadline: Date.now() + 30_000,
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
  async exec(): Promise<DriverResult> { throw new Error("Adapter mutations use normalized service path"); }
  async readFile(input: { sandbox: SandboxRef; path: string }): Promise<Uint8Array> {
    if (!this.session.files?.read) throw new AdapterError("UNSUPPORTED", "File read is unsupported");
    const result = await this.session.files.read({ sandbox: { id: input.sandbox.nativeId }, path: input.path }, {
      signal: this.connection.signal, deadline: Date.now() + 30_000,
    });
    return collectFile(result, this.session.files.maxBytes);
  }
  async writeFile(): Promise<DriverResult> { throw new Error("Adapter mutations use normalized service path"); }
  async destroy(): Promise<DriverResult> { throw new Error("Adapter mutations use normalized service path"); }
  async observe(): Promise<DriverResult | null> { throw new Error("Adapter observations use normalized service path"); }
}
