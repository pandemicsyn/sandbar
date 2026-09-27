import {
  validateAdapterConfiguration,
  type Scope,
} from "@sandbar/adapter";
import { Sandbar, type AdapterDirectClient } from "sandbar-sdk/direct";
import { NativeScope, type ProviderLease } from "@sandbar/provider-spi";
import { z } from "zod";
import { StoreError, type ConnectionRow, type ControlStore } from "@sandbar/store";
import { AdapterProviderDriver, adapterNativeScope } from "./adapter-driver";
import { SecretBox } from "./crypto";

export interface ProviderConfiguration {
  credentials: Record<string, string>;
  configuration: Record<string, string>;
}

export interface ProviderRegistration {
  readonly provider: string;
  validate(input: ProviderConfiguration): ProviderConfiguration;
  connect(input: ProviderConfiguration & { connectionId: string }): Promise<ProviderLease>;
  readonly catalog?: {
    displayName: string;
    configurationSchema: unknown;
    credentialsSchema: unknown;
  };
}

export interface InstalledAdapter {
  readonly name: string;
  readonly config: z.ZodType;
  readonly credentials: z.ZodType;
  connect(input: { config: never; credentials: never; host: {
    readonly signal: AbortSignal;
    readonly policy: Readonly<unknown>;
    onClose(release: () => void | Promise<void>): void;
  } }): Promise<unknown>;
}

export type AdapterProviderLease = ProviderLease & {
  adapterConnection: AdapterDirectClient;
};

export function storedScope(scope: NativeScope): string {
  return JSON.stringify({
    accountId: scope.accountId,
    resourceScope: scope.resourceScope,
    region: scope.region,
    endpoint: scope.endpoint,
    adapterScope: scope.adapterScope && {
      authority: scope.adapterScope.authority,
      partition: Object.fromEntries(Object.entries(scope.adapterScope.partition).sort(([a], [b]) => a.localeCompare(b))),
    },
  });
}

export function publicScope(value: string): NativeScope {
  if (!value.startsWith("{"))
    return NativeScope.parse({
      provider: "stored",
      connectionId: "stored",
      accountId: value,
      region: "local",
    });
  const parsed = JSON.parse(value);
  return NativeScope.parse({
    provider: "stored",
    connectionId: "stored",
    ...parsed,
  });
}

export class ProviderIdentityMismatchError extends StoreError {
  constructor(message: string) {
    super("CONFLICT", message);
  }
}

export class ProviderConfigurationError extends Error {
  constructor() {
    super("Stored provider configuration is no longer valid");
  }
}

export class ProviderRegistry {
  private readonly registrations = new Map<string, ProviderRegistration>();
  private readonly adapters = new Map<string, InstalledAdapter>();
  constructor(
    private readonly store: ControlStore,
    private readonly secrets: SecretBox,
    registrations: ProviderRegistration[],
    adapters: readonly InstalledAdapter[] = [],
  ) {
    for (const entry of registrations) {
      if (this.registrations.has(entry.provider))
        throw new Error(`Duplicate provider registration: ${entry.provider}`);
      this.registrations.set(entry.provider, entry);
    }
    for (const entry of adapters) {
      if (this.registrations.has(entry.name) || this.adapters.has(entry.name))
        throw new Error(`Duplicate provider registration: ${entry.name}`);
      this.adapters.set(entry.name, entry);
    }
  }
  has(provider: string): boolean {
    return this.registrations.has(provider) || this.adapters.has(provider);
  }
  catalog() {
    const legacy = [...this.registrations.values()]
      .filter((registration) => registration.catalog)
      .map((registration) => ({ name: registration.provider, ...registration.catalog! }));
    const installed = [...this.adapters.values()].map((adapter) => ({
      name: adapter.name,
      displayName: adapter.name,
      configurationSchema: z.toJSONSchema(adapter.config, { unrepresentable: "any" }),
      credentialsSchema: z.toJSONSchema(adapter.credentials, { unrepresentable: "any" }),
    }));
    return [...legacy, ...installed].sort((a, b) => a.name.localeCompare(b.name));
  }
  validate(provider: string, input: { credentials: unknown; configuration: unknown }): {
    credentials: unknown;
    configuration: unknown;
  } {
    const adapter = this.adapters.get(provider);
    if (adapter) return validateAdapterConfiguration(adapter, input);
    const registration = this.registrations.get(provider);
    if (!registration) throw new StoreError("CONFLICT", "Provider is not registered");
    const legacy = z.strictObject({
      credentials: z.record(z.string(), z.string()),
      configuration: z.record(z.string(), z.string()),
    }).parse(input);
    return registration.validate(legacy);
  }
  async connect(row: ConnectionRow): Promise<ProviderLease | AdapterProviderLease> {
    const adapter = this.adapters.get(row.provider);
    const registration = this.registrations.get(row.provider);
    if (!adapter && !registration) throw new StoreError("CONFLICT", "Provider is not registered");

    const plaintext = await this.secrets.open("provider-connection", row.id, row.encrypted_credentials);
    const decoded = z.strictObject({
      credentials: z.json(),
      configuration: z.json(),
    }).parse(JSON.parse(plaintext));

    let config: { credentials: unknown; configuration: unknown };
    try {
      config = this.validate(row.provider, decoded);
    } catch {
      throw new ProviderConfigurationError();
    }

    if (adapter) {
      const connection = await Sandbar.connect({
        adapter: adapter as never,
        config: config.configuration,
        credentials: config.credentials,
      });
      try {
        const scope = adapterNativeScope(row.provider, row.id, connection.scope);
        if (row.scope && storedScope(scope) !== row.scope)
          throw new ProviderIdentityMismatchError("Verified native scope or endpoint changed");
        const driver = new AdapterProviderDriver(row.provider, scope, connection);
        return {
          driver, scope, ownership: "owned", release: () => connection.close(),
          adapterConnection: connection,
        };
      } catch (error) {
        await connection.close();
        throw error;
      }
    }

    const legacy = z.strictObject({
      credentials: z.record(z.string(), z.string()),
      configuration: z.record(z.string(), z.string()),
    }).parse(config);
    const result = await registration!.connect({ ...legacy, connectionId: row.id });
    try {
      const scope = NativeScope.parse(result.scope);
      if (scope.provider !== row.provider || scope.connectionId !== row.id || result.driver.name !== row.provider)
        throw new ProviderIdentityMismatchError("Provider identity mismatch");
      if (
        row.scope &&
        storedScope(scope) !== row.scope &&
        !(row.provider === "fake" && row.scope === "fake-local" && scope.accountId === "fake-local")
      )
        throw new ProviderIdentityMismatchError("Verified native scope or endpoint changed");
      return { ...result, scope };
    } catch (error) {
      if (result.ownership === "owned") {
        try { await result.release(); } catch { console.error("Provider transport release failed"); }
      }
      throw error;
    }
  }
  async resolve(projectId: string, connectionId: string): Promise<ProviderLease | AdapterProviderLease> {
    const row = await this.store.getConnection(projectId, connectionId);
    if (!row || row.status !== "verified" || !row.scope)
      throw new StoreError("CONFLICT", "Provider connection is unavailable");
    return this.connect(row);
  }
}
