import { readFileSync } from "node:fs";
import { createApp } from "./app";
import { registerDomainRoutes } from "./routes/domain";
import { ControlStore, bundledMigration, migrate, openMysqlBackend, openSqliteBackend } from "@sandbar/store";
import { DurableRunner, SecretBox } from "@sandbar/core";
import { FakeProviderDriver } from "@sandbar/provider-fake";

export interface RuntimeConfig {
  databaseUrl: string;
  keyFile: string;
  setupTokenFile: string;
  fakeProviderUrl: string;
  fakeProviderToken: string;
  startRunner?: boolean;
}

export async function openDomainRuntime(config: RuntimeConfig) {
  if (!config.databaseUrl || !config.keyFile || !config.setupTokenFile || !config.fakeProviderUrl || !config.fakeProviderToken) throw new Error("Database, key, setup token, fake provider URL and fake transport token are required");
  const backend = config.databaseUrl.startsWith("mysql://") || config.databaseUrl.startsWith("mysqls://")
    ? await openMysqlBackend(config.databaseUrl)
    : openSqliteBackend(config.databaseUrl.startsWith("sqlite:") ? config.databaseUrl.slice(7) : config.databaseUrl);
  try {
    await migrate(backend, bundledMigration(backend.dialect));
    const secrets = await SecretBox.fromFile(config.keyFile);
    const setupToken = readFileSync(config.setupTokenFile, "utf8").trim();
    if (setupToken.length < 24) throw new Error("Setup token file must contain at least 24 characters");
    const store = new ControlStore(backend);
    const driver = new FakeProviderDriver({ baseUrl: config.fakeProviderUrl, token: config.fakeProviderToken });
    const runner = new DurableRunner({ store, driver, secrets });
    const app = createApp({ registerRoutes: app => registerDomainRoutes(app, { store, driver, secrets, setupToken }) });
    if (config.startRunner !== false) runner.start();
    return { app, store, driver, runner, close: async () => { runner.stop(); await store.close(); } };
  } catch (error) { await backend.close(); throw error; }
}
