import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openDomainRuntime } from "./runtime";

type FixtureJson =
  | null
  | boolean
  | number
  | string
  | FixtureJson[]
  | { [key: string]: FixtureJson };

function fixtureFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect });
}

test("service encrypts Daytona credentials, verifies native scope and routes create; wrong-account rotation stops reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-daytona-"));

  const keyFile = join(directory, "key"),
    setupTokenFile = join(directory, "setup");

  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-daytona-fixture-setup-token");
  await chmod(setupTokenFile, 0o600);

  let account = "org-1",
    creates = 0;

  const calls: string[] = [];

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);

    if (url.pathname === "/api/api-keys/current") return Response.json({ organizationId: account });

    if (url.pathname === "/api/snapshots/snap-1")
      return Response.json({
        id: "snap-1",
        organizationId: account,
        state: "active",
        regionIds: ["us"],
        sandboxClass: "linux-vm",
      });

    if (url.pathname === "/api/sandbox" && init?.method === "POST") {
      creates++;

      const body = z
        .object({ name: z.string(), networkBlockAll: z.boolean(), snapshot: z.string() })
        .parse(JSON.parse(String(init.body)));

      expect(body.networkBlockAll).toBe(true);
      expect(body.snapshot).toBe("snap-1");

      return Response.json({
        id: "native-1",
        name: body.name,
        organizationId: account,
        target: "us",
        state: "started",
        networkBlockAll: true,
      });
    }

    throw new Error(`Unexpected ${url.pathname}`);
  });

  const runtime = await openDomainRuntime({
    databaseUrl: join(directory, "control.sqlite"),
    keyFile,
    setupTokenFile,
    startRunner: false,
    daytonaFetch: fetchImpl,
  });

  const request = async (
    path: string,
    method: string,
    body?: FixtureJson,
    token?: string,
    key?: string,
  ) => {
    const headers: Record<string, string> = {};

    if (body !== undefined) headers["Content-Type"] = "application/json";

    if (token) headers.Authorization = `Bearer ${token}`;

    if (key) headers["Idempotency-Key"] = key;

    const response = await runtime.app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return { response, value: await response.json() };
  };

  try {
    const setup = await request("/v1/setup", "POST", {
      setupToken: "long-daytona-fixture-setup-token",
    });

    const token = z.object({ token: z.string() }).parse(setup.value).token;

    const project = z
      .object({ id: z.string() })
      .parse((await request("/v1/projects", "POST", { name: "Daytona" }, token)).value);

    const untrusted = await request(
      `/v1/projects/${project.id}/provider-connections`,
      "POST",
      {
        provider: "daytona",
        name: "Untrusted",
        credentials: { apiKey: "private-key" },
        configuration: {
          apiUrl: "https://example.com/api",
          toolboxOrigin: "https://proxy.app.daytona.io",
          target: "us",
        },
      },
      token,
    );

    expect(untrusted.response.status).toBe(400);
    expect(calls).toHaveLength(0);

    const created = await request(
      `/v1/projects/${project.id}/provider-connections`,
      "POST",
      {
        provider: "daytona",
        name: "Native",
        credentials: { apiKey: "private-key" },
        configuration: {
          apiUrl: "https://app.daytona.io/api",
          toolboxOrigin: "https://proxy.app.daytona.io",
          target: "us",
          ttlMinutes: "60",
        },
      },
      token,
    );

    expect(created.response.status).toBe(201);
    expect(JSON.stringify(created.value)).not.toContain("private-key");
    const connection = z.object({ id: z.string() }).parse(created.value);
    const row = await runtime.store.getConnection(project.id, connection.id);
    expect(row?.encrypted_credentials).not.toContain("private-key");

    const verified = await request(
      `/v1/projects/${project.id}/provider-connections/${connection.id}/verify`,
      "POST",
      {},
      token,
    );

    expect(verified.response.status).toBe(200);

    const verifiedScope = z
      .object({ nativeScope: z.object({ accountId: z.string(), endpoint: z.string() }) })
      .parse(verified.value).nativeScope;

    expect(verifiedScope.accountId).toBe("org-1");
    expect(verifiedScope.endpoint).toBe("https://app.daytona.io/api");

    const admission = await request(
      `/v1/projects/${project.id}/sandboxes`,
      "POST",
      { environment: { kind: "prepared", imageId: "snap-1" }, connectionId: connection.id },
      token,
      Bun.randomUUIDv7(),
    );

    expect(admission.response.status).toBe(202);
    await runtime.runner.tick();

    const admitted = z
      .object({ operation: z.object({ id: z.string(), sandboxId: z.string() }) })
      .parse(admission.value);

    const operation = (
      await request(
        `/v1/projects/${project.id}/operations/${admitted.operation.id}`,
        "GET",
        undefined,
        token,
      )
    ).value;

    expect(z.object({ status: z.string() }).parse(operation).status).toBe("succeeded");
    expect(creates).toBe(1);
    account = "org-2";

    const file = await runtime.app.request(
      `/v1/projects/${project.id}/sandboxes/${admitted.operation.sandboxId}/files?path=%2Ffile`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(file.status).not.toBe(200);
    expect(calls.filter((call) => call.startsWith("GET /toolbox"))).toHaveLength(0);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
