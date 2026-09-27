import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "./app";

test("health and API route composition", async () => {
  const app = createApp({ registerRoutes: (routes: Hono) => {
    routes.get("/v1/ping", (c) => c.json({ pong: true }));
    routes.post("/v1/ping", (c) => c.json({ created: true }, 201));
  } });
  expect(await (await app.request("http://localhost/healthz")).json()).toEqual({ status: "ok" });
  expect(await (await app.request("http://localhost/v1/ping")).json()).toEqual({ pong: true });
  const registeredPost = await app.request("http://localhost/v1/ping", { method: "POST" });
  expect(registeredPost.status).toBe(201);
  expect(await registeredPost.json()).toEqual({ created: true });

  for (const path of ["/v1", "/v1/", "/v1/missing"]) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const missing = await app.request(`http://localhost${path}`, { method });
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type")).toContain("application/json");
      expect(await missing.json()).toEqual({ error: "not_found" });
    }
  }
});

test("serves a prebuilt UI and preserves SPA routes", async () => {
  const directory = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/sandbar-web-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${directory}/index.html`, "<main>Sandbar</main>");
    const app = createApp({ webDist: directory });
    const response = await app.request("http://localhost/projects/example", { headers: { accept: "text/html" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sandbar");
    const root = await app.request("http://localhost/");
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("Sandbar");
  } finally {
    await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true, force: true }));
  }
});
