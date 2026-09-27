import { openDomainRuntime } from "./runtime";
import { z } from "zod";

const daytonaTrustedEndpoints = z
  .array(z.object({ apiUrl: z.string(), toolboxOrigin: z.string() }))
  .parse(JSON.parse(Bun.env.SANDBAR_DAYTONA_TRUSTED_ENDPOINTS ?? "[]"));

const runtime = await openDomainRuntime({
  databaseUrl: Bun.env.SANDBAR_DB_URL ?? "",
  keyFile: Bun.env.SANDBAR_KEY_FILE ?? "",
  setupTokenFile: Bun.env.SANDBAR_SETUP_TOKEN_FILE ?? "",
  fakeProviderUrl: Bun.env.SANDBAR_FAKE_PROVIDER_URL ?? "",
  fakeProviderToken: Bun.env.SANDBAR_FAKE_PROVIDER_TOKEN ?? "",
  daytonaTrustedEndpoints,
  publicOrigin: Bun.env.SANDBAR_PUBLIC_ORIGIN,
});

const app = runtime.app;

const port = Number(Bun.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer from 0 to 65535");
}

const hostname = Bun.env.HOST ?? "127.0.0.1";

if (hostname !== "127.0.0.1" && hostname !== "::1" && !Bun.env.SANDBAR_PUBLIC_ORIGIN)
  throw new Error("SANDBAR_PUBLIC_ORIGIN is required when binding outside loopback");

export default { hostname, port, fetch: app.fetch };
