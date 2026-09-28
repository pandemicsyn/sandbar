import { readFileSync, statSync } from "node:fs";
import { createApp } from "./app";
import { registerDomainRoutes } from "./routes/domain";
import {
  ControlStore,
  bundledMigration,
  migrate,
  openMysqlBackend,
  openSqliteBackend,
} from "@sandbar/store";
import {
  DurableRunner,
  ProviderRegistry,
  SecretBox,
  type InstalledAdapter,
} from "@sandbar/service-runtime";
import { createFakeAdapter } from "@sandbar/provider-fake";
import { createDaytonaAdapter, type DaytonaEndpointPair } from "@sandbar/provider-daytona";
import {
  createModalAdapter,
  type ModalProviderOptions,
  type ModalTransport,
} from "@sandbar/provider-modal";
import { createE2BAdapter, type E2BTransport } from "sandbar-sdk/e2b";

export interface RuntimeConfig {
  databaseUrl: string;
  keyFile: string;
  setupTokenFile: string;
  fakeProviderUrl?: string;
  fakeProviderToken?: string;
  adapters?: readonly InstalledAdapter[];
  daytonaFetch?: typeof fetch;
  daytonaTrustedEndpoints?: DaytonaEndpointPair[];
  modalTransportFactory?: (options: ModalProviderOptions) => ModalTransport;
  e2bTransportFactory?: (options: { apiKey: string }) => E2BTransport;
  publicOrigin?: string;
  webDist?: string;
  startRunner?: boolean;
}

export async function openDomainRuntime(config: RuntimeConfig) {
  if (!config.databaseUrl || !config.keyFile || !config.setupTokenFile)
    throw new Error("Database, key and setup token are required");

  if (!!config.fakeProviderUrl !== !!config.fakeProviderToken)
    throw new Error("Fake provider URL and transport token must be configured together");

  if (config.fakeProviderUrl) {
    const fakeEndpoint = new URL(config.fakeProviderUrl);

    if (
      !(
        ["http:", "https:"].includes(fakeEndpoint.protocol) &&
        ["127.0.0.1", "[::1]"].includes(fakeEndpoint.hostname) &&
        !fakeEndpoint.username &&
        !fakeEndpoint.password
      )
    )
      throw new Error("Fake provider must use a loopback HTTP endpoint");
  }

  if (config.publicOrigin) {
    const origin = new URL(config.publicOrigin);

    if (
      origin.origin !== config.publicOrigin ||
      (origin.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    )
      throw new Error("Public origin must be an HTTPS origin, or local loopback for development");
  }

  if (/^mysqls:\/\//i.test(config.databaseUrl))
    throw new Error("mysqls:// is unsupported; a MySQL URI scheme does not configure TLS");

  const backend = /^mysql:\/\//i.test(config.databaseUrl)
    ? await openMysqlBackend(config.databaseUrl)
    : openSqliteBackend(
        config.databaseUrl.startsWith("sqlite:") ? config.databaseUrl.slice(7) : config.databaseUrl,
      );

  try {
    await migrate(backend, bundledMigration(backend.dialect));
    const secrets = await SecretBox.fromFile(config.keyFile);

    if ((statSync(config.setupTokenFile).mode & 0o077) !== 0)
      throw new Error("Setup token file must not be accessible to group or others");
    const setupToken = readFileSync(config.setupTokenFile, "utf8").trim();

    if (setupToken.length < 24)
      throw new Error("Setup token file must contain at least 24 characters");
    const store = new ControlStore(backend);

    const fakeAdapter =
      config.fakeProviderUrl && config.fakeProviderToken
        ? createFakeAdapter({ url: config.fakeProviderUrl, token: config.fakeProviderToken })
        : undefined;

    const registry = new ProviderRegistry(store, secrets, [
      createDaytonaAdapter(config.daytonaFetch, config.daytonaTrustedEndpoints),
      createModalAdapter(config.modalTransportFactory),
      createE2BAdapter(config.e2bTransportFactory),
      ...(fakeAdapter ? [fakeAdapter] : []),
      ...(config.adapters ?? []),
    ]);

    const runner = new DurableRunner({ store, registry, secrets });

    const app = createApp({
      webDist: config.webDist,
      registerRoutes: (app) =>
        registerDomainRoutes(app, {
          store,
          registry,
          secrets,
          setupToken,
          runner,
          publicOrigin: config.publicOrigin,
        }),
    });

    if (config.startRunner !== false) runner.start();

    return {
      app,
      store,
      registry,
      runner,
      close: async () => {
        runner.stop();
        await store.close();
      },
    };
  } catch (error) {
    await backend.close();
    throw error;
  }
}
