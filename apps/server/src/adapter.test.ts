import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { defineAdapter } from "sandbar-adapter";
import { openDomainRuntime } from "./runtime";

test("custom adapter catalog, encrypted structured connection, and pending restart observation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-adapter-http-"));
  const keyFile = join(directory, "key");
  const setupTokenFile = join(directory, "setup");
  const databaseUrl = join(directory, "control.sqlite");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-custom-adapter-fixture-setup-token");
  await chmod(setupTokenFile, 0o600);
  let submissions = 0;
  let observations = 0;
  let destroys = 0;

  const adapter = defineAdapter({
    name: "example.custom",
    config: z.strictObject({
      region: z.string().min(1),
      flags: z.strictObject({ privateOnly: z.boolean() }),
    }),
    credentials: z.strictObject({ token: z.string().min(1) }),
    async connect({ config, credentials }) {
      expect(credentials.token).toBe("secret-credential");

      return {
        scope: {
          authority: { kind: "account", id: "account-1" },
          partition: { region: config.region, endpoint: "https://example.invalid" },
        },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
          async submit(input, ctx) {
            expect(input.networkPolicy).toBe("blocked");
            submissions++;

            return ctx.pending({ jobId: "job-1" });
          },
          async observe(attempt, _ctx) {
            observations++;
            expect(z.strictObject({ jobId: z.string() }).parse(attempt.token).jobId).toBe("job-1");

            return { id: "native-box-1", state: "running" };
          },
        },
        async destroy(box, _ctx) {
          expect(box.id).toBe("native-box-1");
          destroys++;

          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const config = { databaseUrl, keyFile, setupTokenFile, startRunner: false, adapters: [adapter] };
  let runtime = await openDomainRuntime(config);
  let bearer = "";

  const request = async (
    path: string,
    method = "GET",
    body?: z.infer<ReturnType<typeof z.json>>,
    key?: string,
  ) => {
    const headers: Record<string, string> = {};

    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    if (body) headers["Content-Type"] = "application/json";

    if (key) headers["Idempotency-Key"] = key;

    const response = await runtime.app.request(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    return {
      status: response.status,
      body: z.record(z.string(), z.json()).parse(await response.json()),
    };
  };

  try {
    expect((await request("/v1/providers")).status).toBe(401);

    const setup = await request("/v1/setup", "POST", {
      setupToken: "long-custom-adapter-fixture-setup-token",
    });

    bearer = String(setup.body.token);
    const catalog = await request("/v1/providers");
    expect(catalog.status).toBe(200);
    expect(catalog.body.items).toContainEqual(expect.objectContaining({ name: "example.custom" }));
    expect(JSON.stringify(catalog.body)).not.toContain("secret-credential");
    const project = await request("/v1/projects", "POST", { name: "Custom" });
    const projectId = String(project.body.id);

    const createConnection = () =>
      request(`/v1/projects/${projectId}/provider-connections`, "POST", {
        provider: "example.custom",
        name: "Custom US",
        configuration: { region: "us", flags: { privateOnly: true } },
        credentials: { token: "secret-credential" },
      });

    const connection = await createConnection();
    expect(connection.status).toBe(201);
    const connectionId = String(connection.body.id);
    expect(JSON.stringify(connection.body)).not.toContain("secret-credential");
    const databaseBytes = await readFile(databaseUrl);
    expect(databaseBytes.toString()).not.toContain("secret-credential");

    const verified = await request(
      `/v1/projects/${projectId}/provider-connections/${connectionId}/verify`,
      "POST",
    );

    expect(verified.status).toBe(200);

    const create = await request(
      `/v1/projects/${projectId}/sandboxes`,
      "POST",
      {
        environment: { kind: "prepared", imageId: "image-1" },
        network: { policy: "blocked" },
        connectionId,
      },
      Bun.randomUUIDv7(),
    );

    expect(create.status).toBe(202);

    const operation = z
      .object({ id: z.string(), sandboxId: z.string().optional() })
      .parse(create.body.operation);

    expect(await runtime.runner.tick()).toBe(true);
    expect(submissions).toBe(1);
    const pending = await runtime.store.getOperation(projectId, String(operation.id));
    expect(pending?.adapter_token_ciphertext).toBeTruthy();
    expect(pending?.adapter_token_ciphertext).not.toContain("job-1");
    await runtime.close();
    runtime = await openDomainRuntime(config);
    await runtime.store.requestReconcile(projectId, String(operation.id));
    expect(await runtime.runner.tick()).toBe(true);
    expect(submissions).toBe(1);
    expect(observations).toBe(1);
    const completed = await runtime.store.getOperation(projectId, String(operation.id));
    expect(completed?.status).toBe("succeeded");
    const boxId = String(operation.sandboxId);

    const destroy = await request(
      `/v1/projects/${projectId}/sandboxes/${boxId}`,
      "DELETE",
      undefined,
      Bun.randomUUIDv7(),
    );

    expect(destroy.status).toBe(202);
    expect(await runtime.runner.tick()).toBe(true);
    expect(destroys).toBe(1);

    const otherProject = await request("/v1/projects", "POST", { name: "Other" });

    const foreign = await request(
      `/v1/projects/${String(otherProject.body.id)}/sandboxes`,
      "POST",
      {
        environment: { kind: "prepared", imageId: "image-1" },
        network: { policy: "blocked" },
        connectionId,
      },
      Bun.randomUUIDv7(),
    );

    expect(foreign.status).not.toBe(202);
    expect(submissions).toBe(1);

    await runtime.store.backend.run(
      sql`UPDATE provider_connections SET adapter_contract_version=99 WHERE id=${connectionId}`,
    );
    const stale = await runtime.store.getConnection(projectId, connectionId);
    await expect(runtime.registry.connect(stale!)).rejects.toThrow("stored contract version 99");
    expect(submissions).toBe(1);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
