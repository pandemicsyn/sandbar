import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDomainRuntime } from "./runtime";

test("service encrypts Daytona credentials, verifies native scope and routes create; wrong-account rotation stops reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-daytona-"));
  const keyFile = join(directory, "key"), setupTokenFile = join(directory, "setup");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32))); await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-daytona-fixture-setup-token"); await chmod(setupTokenFile, 0o600);
  let account = "org-1", creates = 0;
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/api-keys/current") return Response.json({ organizationId: account });
    if (url.pathname === "/api/snapshots/snap-1") return Response.json({ id: "snap-1", organizationId: account, state: "active", regionIds: ["us"], sandboxClass: "linux-vm" });
    if (url.pathname === "/api/sandbox" && init?.method === "POST") {
      creates++;
      const body = JSON.parse(String(init.body)) as { name: string; networkBlockAll: boolean; snapshot: string };
      expect(body.networkBlockAll).toBe(true);
      expect(body.snapshot).toBe("snap-1");
      return Response.json({ id: "native-1", name: body.name, organizationId: account, target: "us", state: "started", networkBlockAll: true });
    }
    throw new Error(`Unexpected ${url.pathname}`);
  }) as typeof fetch;
  const runtime = await openDomainRuntime({ databaseUrl: join(directory, "control.sqlite"), keyFile, setupTokenFile, startRunner: false, daytonaFetch: fetchImpl });
  const request = async (path: string, method: string, body?: unknown, token?: string, key?: string) => {
    const response = await runtime.app.request(path, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { "Idempotency-Key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { response, value: await response.json() as Record<string, any> };
  };
  try {
    const setup = await request("/v1/setup", "POST", { setupToken: "long-daytona-fixture-setup-token" });
    const token = setup.value.token as string;
    const project = (await request("/v1/projects", "POST", { name: "Daytona" }, token)).value;
    const created = await request(`/v1/projects/${project.id}/provider-connections`, "POST", { provider: "daytona", name: "Native", credentials: { apiKey: "private-key" }, configuration: { apiUrl: "https://app.daytona.io/api", toolboxOrigin: "https://proxy.app.daytona.io", target: "us", ttlMinutes: "60" } }, token);
    expect(created.response.status).toBe(201);
    expect(JSON.stringify(created.value)).not.toContain("private-key");
    const row = await runtime.store.getConnection(project.id, created.value.id);
    expect(row?.encrypted_credentials).not.toContain("private-key");
    const verified = await request(`/v1/projects/${project.id}/provider-connections/${created.value.id}/verify`, "POST", {}, token);
    expect(verified.response.status).toBe(200);
    expect(verified.value.nativeScope.accountId).toBe("org-1");
    expect(verified.value.nativeScope.endpoint).toBe("https://app.daytona.io/api");
    const admission = await request(`/v1/projects/${project.id}/sandboxes`, "POST", { environment: { kind: "prepared", imageId: "snap-1" }, connectionId: created.value.id }, token, Bun.randomUUIDv7());
    expect(admission.response.status).toBe(202);
    await runtime.runner.tick();
    const operation = (await request(`/v1/projects/${project.id}/operations/${admission.value.operation.id}`, "GET", undefined, token)).value;
    expect(operation.status).toBe("succeeded");
    expect(creates).toBe(1);
    account = "org-2";
    const file = await runtime.app.request(`/v1/projects/${project.id}/sandboxes/${admission.value.operation.sandboxId}/files?path=%2Ffile`, { headers: { Authorization: `Bearer ${token}` } });
    expect(file.status).not.toBe(200);
    expect(calls.filter(call => call.startsWith("GET /toolbox"))).toHaveLength(0);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
