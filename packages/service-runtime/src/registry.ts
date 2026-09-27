import {
  validateAdapterConfiguration,
  type Scope,
} from "@sandbar/adapter";
import { Sandbar, ADAPTER_CONTRACT_VERSION, type AdapterDirectClient } from "sandbar-sdk/direct";
import { NativeScope } from "@sandbar/provider-spi";
import { z } from "zod";
import { StoreError, type ConnectionRow, type ControlStore } from "@sandbar/store";
import { AdapterProviderDriver, adapterNativeScope } from "./adapter-driver";
import { SecretBox } from "./crypto";

export interface InstalledAdapter {
  readonly name: string;
  readonly displayName?: string;
  readonly config: z.ZodType;
  readonly credentials: z.ZodType;
  connect(input: { config: never; credentials: never; host: {
    readonly signal: AbortSignal;
    readonly policy: Readonly<unknown>;
    onClose(release: () => void | Promise<void>): void;
  } }): Promise<unknown>;
}

export interface AdapterProviderLease {
  driver: AdapterProviderDriver;
  scope: NativeScope;
  release(): Promise<void>;
  adapterConnection: AdapterDirectClient;
}

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

export class AdapterContractMismatchError extends Error {
  constructor(provider: string, stored: number) {
    super(`Adapter ${provider} stored contract version ${stored}; host supports ${ADAPTER_CONTRACT_VERSION}. Install a compatible adapter or create a new connection.`);
  }
}

export class ProviderConfigurationError extends Error {
  constructor() {
    super("Stored provider configuration is no longer valid");
  }
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, InstalledAdapter>();
  constructor(
    private readonly store: ControlStore,
    private readonly secrets: SecretBox,
    adapters: readonly InstalledAdapter[],
  ) {
    for (const entry of adapters) {
      if (this.adapters.has(entry.name))
        throw new Error(`Duplicate provider registration: ${entry.name}`);
      this.adapters.set(entry.name, entry);
    }
  }
  has(provider: string): boolean {
    return this.adapters.has(provider);
  }
  catalog() {
    const installed = [...this.adapters.values()].map((adapter) => ({
      name: adapter.name,
      displayName: adapter.displayName ?? adapter.name,
      configurationSchema: z.toJSONSchema(adapter.config, { unrepresentable: "any" }),
      credentialsSchema: z.toJSONSchema(adapter.credentials, { unrepresentable: "any" }),
    }));
    return installed.sort((a, b) => a.name.localeCompare(b.name));
  }
  validate(provider: string, input: { credentials: unknown; configuration: unknown }): {
    credentials: unknown;
    configuration: unknown;
  } {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new StoreError("CONFLICT", "Provider is not registered");
    return validateAdapterConfiguration(adapter, input);
  }
  async connect(row: ConnectionRow): Promise<AdapterProviderLease> {
    const adapter = this.adapters.get(row.provider);
    if (!adapter) throw new StoreError("CONFLICT", "Provider is not registered");

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

    if (row.adapter_contract_version !== ADAPTER_CONTRACT_VERSION)
      throw new AdapterContractMismatchError(row.provider, row.adapter_contract_version);
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
        driver, scope, release: () => connection.close(), adapterConnection: connection,
      };
    } catch (error) {
      await connection.close();
      throw error;
    }
  }
  async resolve(projectId: string, connectionId: string): Promise<AdapterProviderLease> {
    const row = await this.store.getConnection(projectId, connectionId);
    if (!row || row.status !== "verified" || !row.scope)
      throw new StoreError("CONFLICT", "Provider connection is unavailable");
    return this.connect(row);
  }
}
