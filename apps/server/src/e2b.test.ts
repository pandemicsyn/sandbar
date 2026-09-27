import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { E2BTransport } from "sandbar-sdk/e2b";
import { openDomainRuntime } from "./runtime";

type FixtureJson =
  | null
  | boolean
  | number
  | string
  | FixtureJson[]
  | { [key: string]: FixtureJson };

test("service persists E2B credentials and observes lost creation after restart without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-e2b-service-"));
  const keyFile = join(directory, "key");
  const setupTokenFile = join(directory, "setup");
  const databaseUrl = join(directory, "control.sqlite");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "e2b-fixture-setup-token-long-enough");
  await chmod(setupTokenFile, 0o600);

  let creates = 0;
  let closed = 0;
  let record: Awaited<ReturnType<E2BTransport["get"]>> = null;

  const transport: E2BTransport = {
    async verifyTeam(id) {
      if (id !== "team_one") throw new Error("wrong team");
    },
    async verifyTemplate(team, template) {
      if (team !== "team_one" || template !== "template_one") throw new Error("wrong template");
    },
    async buildImage() {
      return { templateId: "template_one", buildId: "build_one" };
    },
    async findBuild() {
      return null;
    },
    async create(input) {
      creates++;
      record = {
        id: "sb_one",
        templateId: input.templateId,
        metadata: input.metadata,
        state: "running",
      };
      throw new Error("response lost after one native create effect");
    },
    async get(id) {
      return id === record?.id ? record : null;
    },
    async list(metadata) {
      return {
        items:
          record &&
          Object.entries(metadata).every(([key, value]) => record?.metadata[key] === value)
            ? [record]
            : [],
      };
    },
    async kill() {
      record = null;

      return true;
    },
    async run() {
      return "";
    },
    async read() {
      return { bytes: new Uint8Array(), truncated: false };
    },
    async write() {},
    async remove() {},
    close() {
      closed++;
    },
  };

  const options = {
    databaseUrl,
    keyFile,
    setupTokenFile,
    startRunner: false,
    e2bTransportFactory: ({ apiKey }: { apiKey: string }) => {
      expect(apiKey).toBe("e2b-private-key");

      return transport;
    },
  };

  let runtime = await openDomainRuntime(options);

  const request = async (
    path: string,
    method: string,
    token?: string,
    body?: FixtureJson,
    key?: string,
  ) => {
    const headers: Record<string, string> = {};

    if (token) headers.Authorization = `Bearer ${token}`;

    if (body !== undefined) headers["Content-Type"] = "application/json";

    if (key) headers["Idempotency-Key"] = key;

    const response = await runtime.app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return { status: response.status, value: await response.json() };
  };

  try {
    const setup = await request("/v1/setup", "POST", undefined, {
      setupToken: "e2b-fixture-setup-token-long-enough",
    });

    const token = z.object({ token: z.string() }).parse(setup.value).token;
    const project = await request("/v1/projects", "POST", token, { name: "E2B fixture" });
    const projectId = z.object({ id: z.string() }).parse(project.value).id;
    const path = `/v1/projects/${projectId}`;

    const connection = await request(`${path}/provider-connections`, "POST", token, {
      provider: "e2b",
      name: "E2B team",
      configuration: { teamId: "team_one", templateId: "template_one" },
      credentials: { apiKey: "e2b-private-key" },
    });

    expect(connection.status).toBe(201);
    expect(JSON.stringify(connection.value)).not.toContain("e2b-private-key");
    const connectionId = z.object({ id: z.string() }).parse(connection.value).id;
    expect(
      (await runtime.store.getConnection(projectId, connectionId))?.encrypted_credentials,
    ).not.toContain("e2b-private-key");

    const verified = await request(
      `${path}/provider-connections/${connectionId}/verify`,
      "POST",
      token,
      {},
    );

    expect(verified.status).toBe(200);
    expect(verified.value).toMatchObject({
      nativeScope: {
        adapterScope: {
          authority: { kind: "team", id: "team_one" },
          partition: { template: "template_one" },
        },
      },
    });

    const admitted = await request(
      `${path}/sandboxes`,
      "POST",
      token,
      {
        connectionId,
        environment: { kind: "prepared", imageId: "template_one" },
        network: { policy: "blocked" },
      },
      Bun.randomUUIDv7(),
    );

    expect(admitted.status).toBe(202);

    const operationId = z.object({ operation: z.object({ id: z.string() }) }).parse(admitted.value)
      .operation.id;

    await runtime.runner.tick();
    expect(creates).toBe(1);
    await runtime.close();
    runtime = await openDomainRuntime(options);
    await request(`${path}/operations/${operationId}/reconcile`, "POST", token, {});
    await runtime.runner.tick();
    const outcome = await request(`${path}/operations/${operationId}`, "GET", token);
    expect(outcome.value).toMatchObject({ status: "succeeded" });
    expect(creates).toBe(1);
    expect(closed).toBeGreaterThan(0);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
