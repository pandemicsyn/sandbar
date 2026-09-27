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
import { DurableRunner, SecretBox } from "@sandbar/core";
import { FakeProviderDriver } from "@sandbar/provider-fake";

export interface RuntimeConfig {
  databaseUrl: string;
  keyFile: string;
  setupTokenFile: string;
  fakeProviderUrl: string;
  fakeProviderToken: string;
  publicOrigin?: string;
  startRunner?: boolean;
}

export async function openDomainRuntime(config: RuntimeConfig) {
  if (
    !config.databaseUrl ||
    !config.keyFile ||
    !config.setupTokenFile ||
    !config.fakeProviderUrl ||
    !config.fakeProviderToken
  )
    throw new Error(
      "Database, key, setup token, fake provider URL and fake transport token are required",
    );
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

  if (config.publicOrigin) {
    const origin = new URL(config.publicOrigin);

    if (
      origin.origin !== config.publicOrigin ||
      (origin.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    )
      throw new Error("Public origin must be an HTTPS origin, or local loopback for development");
  }

  const backend =
    config.databaseUrl.startsWith("mysql://") || config.databaseUrl.startsWith("mysqls://")
      ? await openMysqlBackend(config.databaseUrl)
      : openSqliteBackend(
          config.databaseUrl.startsWith("sqlite:")
            ? config.databaseUrl.slice(7)
            : config.databaseUrl,
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

    const driver = new FakeProviderDriver({
      baseUrl: config.fakeProviderUrl,
      token: config.fakeProviderToken,
    });

    const runner = new DurableRunner({ store, driver, secrets });

    const app = createApp({
      registerRoutes: (app) =>
        registerDomainRoutes(app, {
          store,
          driver,
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
      driver,
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
