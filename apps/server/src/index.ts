import { openDomainRuntime } from "./runtime";

const runtime = await openDomainRuntime({
  databaseUrl: Bun.env.SANDBAR_DB_URL ?? "",
  keyFile: Bun.env.SANDBAR_KEY_FILE ?? "",
  setupTokenFile: Bun.env.SANDBAR_SETUP_TOKEN_FILE ?? "",
  fakeProviderUrl: Bun.env.SANDBAR_FAKE_PROVIDER_URL ?? "",
  fakeProviderToken: Bun.env.SANDBAR_FAKE_PROVIDER_TOKEN ?? "",
});
const app = runtime.app;
const port = Number(Bun.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer from 0 to 65535");
}

export default { port, fetch: app.fetch };
