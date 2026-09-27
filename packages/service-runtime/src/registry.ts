import { NativeScope, type ProviderLease } from "@sandbar/provider-spi";
import { z } from "zod";
import { StoreError, type ConnectionRow, type ControlStore } from "@sandbar/store";
import { SecretBox } from "./crypto";

export interface ProviderConfiguration {
  credentials: Record<string, string>;
  configuration: Record<string, string>;
}

export interface ProviderRegistration {
  readonly provider: string;
  /** Strict, synchronous validation before encrypting a new connection. */
  validate(input: ProviderConfiguration): ProviderConfiguration;
  /** Performs read-only native identity verification. It must not create resources. */
  connect(input: ProviderConfiguration & { connectionId: string }): Promise<ProviderLease>;
}

export function storedScope(scope: NativeScope): string {
  return JSON.stringify({
    accountId: scope.accountId,
    resourceScope: scope.resourceScope,
    region: scope.region,
    endpoint: scope.endpoint,
  });
}

export function publicScope(value: string): NativeScope {
  if (!value.startsWith("{"))
    return NativeScope.parse({
      provider: "stored",
      connectionId: "stored",
      accountId: value,
      region: "local",
    }); // First-wave fake rows.
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
  constructor(
    private readonly store: ControlStore,
    private readonly secrets: SecretBox,
    registrations: ProviderRegistration[],
  ) {
    for (const entry of registrations) {
      if (this.registrations.has(entry.provider))
        throw new Error(`Duplicate provider registration: ${entry.provider}`);
      this.registrations.set(entry.provider, entry);
    }
  }
  has(provider: string): boolean {
    return this.registrations.has(provider);
  }
  validate(provider: string, input: ProviderConfiguration): ProviderConfiguration {
    const registration = this.registrations.get(provider);

    if (!registration) throw new StoreError("CONFLICT", "Provider is not registered");

    return registration.validate(input);
  }
  async connect(row: ConnectionRow): Promise<ProviderLease> {
    const registration = this.registrations.get(row.provider);

    if (!registration) throw new StoreError("CONFLICT", "Provider is not registered");

    const plaintext = await this.secrets.open(
      "provider-connection",
      row.id,
      row.encrypted_credentials,
    );

    const decoded = z
      .object({
        credentials: z.record(z.string(), z.string()).default({}),
        configuration: z.record(z.string(), z.string()).default({}),
      })
      .parse(JSON.parse(plaintext));

    let config: ProviderConfiguration;

    try {
      config = registration.validate(decoded);
    } catch (error) {
      if (error instanceof z.ZodError) throw new ProviderConfigurationError();

      throw error;
    }

    const result = await registration.connect({
      ...config,
      connectionId: row.id,
    });

    try {
      const scope = NativeScope.parse(result.scope);

      if (
        scope.provider !== row.provider ||
        scope.connectionId !== row.id ||
        result.driver.name !== row.provider
      )
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
        try {
          await result.release();
        } catch {
          console.error("Provider transport release failed");
        }
      }

      throw error;
    }
  }
  async resolve(projectId: string, connectionId: string): Promise<ProviderLease> {
    const row = await this.store.getConnection(projectId, connectionId);

    if (!row || row.status !== "verified" || !row.scope)
      throw new StoreError("CONFLICT", "Provider connection is unavailable");

    return this.connect(row);
  }
}
