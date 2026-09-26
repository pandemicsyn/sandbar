import { resolve, sep } from "node:path";
import { Hono } from "hono";

export type RegisterRoutes = (app: Hono) => void;

export interface AppOptions {
  registerRoutes?: RegisterRoutes;
  webDist?: string;
}

/** Compose API routes before the production UI fallback. */
export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  const webDist = resolve(options.webDist ?? resolve(import.meta.dir, "../../web/dist"));

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  options.registerRoutes?.(app);

  app.get("*", async (c) => {
    const requestPath = new URL(c.req.url).pathname;
    if (requestPath.startsWith("/v1/") || requestPath === "/v1") {
      return c.json({ error: "not_found" }, 404);
    }

    const candidate = resolve(webDist, requestPath === "/" ? "index.html" : `.${requestPath}`);
    if (candidate !== webDist && !candidate.startsWith(webDist + sep)) {
      return c.notFound();
    }
    const asset = Bun.file(candidate);
    if (await asset.exists()) {
      return new Response(asset, { headers: { "Content-Type": asset.type } });
    }
    if (!c.req.header("accept")?.includes("text/html")) {
      return c.notFound();
    }
    const index = Bun.file(resolve(webDist, "index.html"));
    if (!(await index.exists())) return c.notFound();
    return new Response(index, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  });
  return app;
}
