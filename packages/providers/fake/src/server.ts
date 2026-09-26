import { FakeProviderEngine } from "./engine";
import { FakeAction, validFakePath } from "./protocol";

export type FakeServerOptions = { hostname: "127.0.0.1" | "::1"; port: number; statePath: string; token: string; testMode: boolean };

export async function startFakeProviderServer(options: FakeServerOptions) {
  if (!options.token || options.token.length < 16) throw new Error("Fake provider requires a transport token of at least 16 characters");
  const engine = new FakeProviderEngine(options.statePath, options.testMode);
  await engine.load();
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "X-Sandbar-Fake-Provider": "simulation" } });
  return Bun.serve({ hostname: options.hostname, port: options.port, async fetch(request) {
    if (request.headers.get("Authorization") !== `Bearer ${options.token}`) return json({ error: "unauthorized" }, 401);
    const path = new URL(request.url).pathname;
    if (path.startsWith("/_test/") && !options.testMode) return json({ error: "not_found" }, 404);
    if (request.method === "GET" && path === "/_test/state") return json(engine.snapshot());
    if (request.method !== "POST") return json({ error: "not_found" }, 404);
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > 2 * 1024 * 1024) return json({ error: "too_large" }, 413);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) return json({ error: "too_large" }, 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return json({ error: "invalid_json" }, 400); }
    try {
      if (path === "/_test/reset") { await engine.reset(); return json({ ok: true }); }
      if (path === "/_test/seed") { await engine.seed(body); return json({ ok: true }); }
      if (path === "/_test/profile") { await engine.setProfile(body); return json({ ok: true }); }
      if (path === "/_test/events/seed") { await engine.seedEvents(body); return json({ ok: true }); }
      if (path !== "/v1/action") return json({ error: "not_found" }, 404);
      const action = FakeAction.parse(body);
      switch (action.kind) {
        case "capabilities": return json({ provider: "fake", nativeIdempotency: engine.profile().nativeIdempotency, discoveryBySubmission: engine.profile().discoveryBySubmission, supports: { argv: true, shell: true, fileBytes: true, inventory: true }, maxFileBytes: 1048576, maxOutputBytes: 1048576, networkPolicies: ["blocked"] });
        case "create": {
          if (action.scope.provider !== "fake" || action.image !== "fake-starter" || action.networkPolicy !== "blocked") return json({ status: "rejected", effect: "none", error: { code: "unsupported", message: "Fake provider supports fake-starter with blocked network only", effect: "none", retry: "never" } });
          const outcome = await engine.create(action); return outcome.loseResponse ? json({ error: "response_lost" }, 504) : json(outcome.result);
        }
        case "inspect": return json(engine.inspect(action.ref));
        case "inventory": return json(engine.inventory(action.scope, action.cursor, action.limit));
        case "exec": { const outcome = await engine.exec(action); return outcome.loseResponse ? json({ error: "response_lost" }, 504) : json(outcome.result); }
        case "readFile": return validFakePath(action.path) ? json({ bytesBase64: engine.readFile(action.sandbox, action.path) }) : json({ error: "invalid_path" }, 400);
        case "writeFile": {
          if (!validFakePath(action.path)) return json({ error: "invalid_path" }, 400);
          const outcome = await engine.writeFile(action);
          return outcome.loseResponse ? json({ error: "response_lost" }, 504) : json(outcome.result);
        }
        case "destroy": { const outcome = await engine.destroy(action); return outcome.loseResponse ? json({ error: "response_lost" }, 504) : json(outcome.result); }
        case "observe": return json(await engine.observe(action.scope, action.submissionId));
        case "events": return json(engine.events(action.scope));
      }
    } catch { return json({ error: "invalid_request" }, 400); }
  } });
}

if (import.meta.main) {
  if (process.env.SANDBAR_ENABLE_FAKE_PROVIDER !== "1") throw new Error("Set SANDBAR_ENABLE_FAKE_PROVIDER=1 to run the clearly simulated fake provider");
  const statePath = process.env.SANDBAR_FAKE_STATE_PATH;
  const token = process.env.SANDBAR_FAKE_TOKEN;
  if (!statePath || !token) throw new Error("SANDBAR_FAKE_STATE_PATH and SANDBAR_FAKE_TOKEN are required");
  const server = await startFakeProviderServer({ hostname: "127.0.0.1", port: Number(process.env.SANDBAR_FAKE_PORT ?? 8789), statePath, token, testMode: process.env.SANDBAR_FAKE_TEST_MODE === "1" });
  console.log(`FAKE SANDBOX PROVIDER (simulation) listening on ${server.url}`);
}
