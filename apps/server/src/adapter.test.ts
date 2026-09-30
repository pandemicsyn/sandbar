import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { defineAdapter } from "sandbar-adapter";
import { ProviderConfigurationError, SecretBox } from "@sandbar/service-runtime";
import { Sandbar } from "../../../packages/sdk/src/index";
import { Operation } from "./http-contracts";
import { openDomainRuntime } from "./runtime";

async function exerciseAdapterCheckpoint(mode: "pending" | "lost-ack" | "checkpoint-failure") {
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
  let endpoint = "cluster-a";
  const nativeImage = `image:${"i".repeat(506)}`;
  const nativeAuthority = `account:${"a".repeat(504)}`;

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
          authority: { kind: "account", id: nativeAuthority },
          partition: { region: config.region, endpoint },
        },
        supports: { images: ["prepared"], network: ["blocked"] },
        imageBuild: {
          async submit() {
            return {
              preparedId: nativeImage,
              retainedResources: [
                {
                  kind: "image",
                  id: nativeImage,
                  ownership: "unknown" as const,
                  cleanup: "manual" as const,
                },
              ],
            };
          },
        },
        create: {
          recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
          async submit(input, ctx) {
            expect(input.networkPolicy).toBe("blocked");
            expect(input.image.value).toBe(nativeImage);
            await ctx.checkpoint({ jobId: "job-1" });

            const checkpoint = await runtime.store.backend.row<{
              adapter_token_ciphertext: string;
              lease_owner: string;
              status: string;
            }>(
              sql`SELECT adapter_token_ciphertext,lease_owner,status FROM operations WHERE id=${ctx.operationId}`,
            );

            expect(checkpoint?.adapter_token_ciphertext).toBeTruthy();
            expect(checkpoint?.adapter_token_ciphertext).not.toContain("job-1");
            expect(checkpoint?.lease_owner).toBeTruthy();
            expect(checkpoint?.status).toBe("running");
            submissions++;

            if (mode === "lost-ack") throw Error("Create acknowledgement lost");

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

  const direct = await Sandbar.connect({
    adapter,
    config: { region: "us", flags: { privateOnly: true } },
    credentials: { token: "secret-credential" },
  });

  expect(direct.scope.partition.endpoint).toBe("cluster-a");
  await direct.close();

  const config = {
    databaseUrl,
    keyFile,
    setupTokenFile,
    startRunner: false,
    adapters: [adapter],
  };

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

    const build = await request(
      `/v1/projects/${projectId}/images/builds`,
      "POST",
      {
        source: { kind: "oci", value: "fixture/image:1" },
        connectionId,
      },
      Bun.randomUUIDv7(),
    );

    expect(build.status).toBe(202);
    const buildId = z.object({ id: z.string() }).parse(build.body.operation).id;

    expect(await runtime.runner.tick()).toBe(true);
    const buildOutcome = await request(`/v1/projects/${projectId}/operations/${buildId}`);
    const buildResult = Operation.parse(buildOutcome.body);

    if (buildResult.kind !== "image_build" || !buildResult.result)
      throw new Error("Missing image build result");
    const image = buildResult.result;

    expect(image.prepared.value).toBe(nativeImage);
    expect(image.prepared.scope.authority.id).toBe(nativeAuthority);
    expect(image.retainedResources[0]?.id).toBe(nativeImage);

    const create = await request(
      `/v1/projects/${projectId}/sandboxes`,
      "POST",
      {
        environment: { kind: "prepared", imageId: image.prepared.value },
        network: { policy: "blocked" },
        connectionId,
        preparedBinding: {
          provider: image.prepared.provider,
          scope: image.prepared.scope,
          connectionId,
        },
      },
      Bun.randomUUIDv7(),
    );

    expect(create.status).toBe(202);

    const operation = z
      .object({ id: z.string(), sandboxId: z.string().optional() })
      .parse(create.body.operation);

    if (mode === "checkpoint-failure")
      await runtime.store.backend.run(
        sql`CREATE TRIGGER fail_adapter_checkpoint BEFORE UPDATE OF adapter_token_ciphertext ON operations WHEN NEW.adapter_token_ciphertext IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END`,
      );

    expect(await runtime.runner.tick()).toBe(true);

    if (mode === "checkpoint-failure") {
      expect(submissions).toBe(0);
      const failed = await runtime.store.getOperation(projectId, String(operation.id));
      expect(failed?.status).toBe("unknown");
      expect(failed?.adapter_token_ciphertext).toBeNull();

      return;
    }

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

    endpoint = "cluster-b";
    const changedEndpoint = await runtime.store.getConnection(projectId, connectionId);

    await expect(runtime.registry.connect(changedEndpoint!)).rejects.toThrow(
      "Verified native scope or endpoint changed",
    );
    expect(submissions).toBe(1);
    endpoint = "cluster-a";

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
}

test.each(["pending", "lost-ack", "checkpoint-failure"] as const)(
  "custom adapter encrypted checkpoints and restart observation: %s",
  exerciseAdapterCheckpoint,
);

test("transformed adapter inputs remain raw in encrypted service connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-transform-connection-"));
  const keyFile = join(directory, "key");
  const setupTokenFile = join(directory, "setup");
  const databaseUrl = join(directory, "control.sqlite");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-transform-connection-setup-token");
  await chmod(setupTokenFile, 0o600);
  let connects = 0;

  const adapter = defineAdapter({
    name: "example.transformed",
    config: z.strictObject({ region: z.string() }).transform(({ region }) => region),
    credentials: z.strictObject({ token: z.string() }).transform(({ token }) => token),
    async connect({ config, credentials }) {
      connects++;
      expect(config).toBe("us");
      expect(credentials).toBe("secret-credential");

      return {
        scope: { authority: { kind: "account", id: "one" }, partition: { region: config } },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const direct = await Sandbar.connect({
    adapter,
    config: { region: "us" },
    credentials: { token: "secret-credential" },
  });

  expect(direct.scope.partition.region).toBe("us");
  await direct.close();
  expect(connects).toBe(1);

  const options = { databaseUrl, keyFile, setupTokenFile, startRunner: false, adapters: [adapter] };
  let runtime = await openDomainRuntime(options);
  let bearer = "";

  const request = async (path: string, body: z.infer<ReturnType<typeof z.json>>) => {
    const headers = new Headers({ "Content-Type": "application/json" });

    if (bearer) headers.set("Authorization", `Bearer ${bearer}`);

    const response = await runtime.app.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    return { status: response.status, body: await response.json() };
  };

  try {
    const setup = await request("/v1/setup", {
      setupToken: "long-transform-connection-setup-token",
    });

    bearer = setup.body.token;

    const project = await request("/v1/projects", { name: "Transformed" });
    const projectId = String(project.body.id);

    const created = await request(`/v1/projects/${projectId}/provider-connections`, {
      provider: "example.transformed",
      name: "Transformed",
      configuration: { region: "us" },
      credentials: { token: "secret-credential" },
    });

    expect(created.status).toBe(201);
    expect(connects).toBe(1);

    const connectionId = String(created.body.id);
    const stored = await runtime.store.getConnection(projectId, connectionId);

    expect(stored?.encrypted_credentials).not.toContain("secret-credential");
    expect((await readFile(databaseUrl)).toString()).not.toContain("secret-credential");

    const secrets = await SecretBox.fromFile(keyFile);

    const plaintext = await secrets.open(
      "provider-connection",
      connectionId,
      stored!.encrypted_credentials,
    );

    expect(JSON.parse(plaintext)).toEqual({
      credentials: { token: "secret-credential" },
      configuration: { region: "us" },
    });

    await runtime.close();
    runtime = await openDomainRuntime(options);

    const verified = await request(
      `/v1/projects/${projectId}/provider-connections/${connectionId}/verify`,
      {},
    );

    expect(verified.status).toBe(200);
    expect(connects).toBe(2);

    const invalid = await secrets.seal(
      "provider-connection",
      connectionId,
      JSON.stringify({ credentials: { token: "secret-credential" }, configuration: {} }),
    );

    await runtime.store.backend.run(
      sql`UPDATE provider_connections SET encrypted_credentials=${invalid} WHERE id=${connectionId}`,
    );

    const corrupted = await runtime.store.getConnection(projectId, connectionId);

    await expect(runtime.registry.connect(corrupted!)).rejects.toBeInstanceOf(
      ProviderConfigurationError,
    );
    expect(connects).toBe(2);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("service accepts scalar, array, and explicit null adapter inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-json-connection-"));
  const keyFile = join(directory, "key");
  const setupTokenFile = join(directory, "setup");
  const databaseUrl = join(directory, "control.sqlite");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-json-connection-setup-token");
  await chmod(setupTokenFile, 0o600);

  const seen: [string | string[] | null, string | string[] | null][] = [];

  const values: [string | string[] | null, string | string[] | null][] = [
    ["us", "secret"],
    [["us"], ["secret"]],
    [null, null],
  ];

  const inputSchema = z.union([z.string(), z.array(z.string()), z.null()]);

  const adapter = defineAdapter({
    name: "example.json-values",
    config: inputSchema,
    credentials: inputSchema,
    async connect({ config, credentials }) {
      seen.push([config, credentials]);

      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  for (const [config, credentials] of values) {
    const client = await Sandbar.connect({ adapter, config, credentials });

    await client.close();
  }

  expect(seen).toEqual(values);

  const options = { databaseUrl, keyFile, setupTokenFile, startRunner: false, adapters: [adapter] };
  let runtime = await openDomainRuntime(options);
  let bearer = "";

  const request = async (path: string, body: z.infer<ReturnType<typeof z.json>>) => {
    const headers = new Headers({ "Content-Type": "application/json" });

    if (bearer) headers.set("Authorization", `Bearer ${bearer}`);

    const response = await runtime.app.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    return { status: response.status, body: await response.json() };
  };

  try {
    const setup = await request("/v1/setup", { setupToken: "long-json-connection-setup-token" });

    bearer = setup.body.token;

    const project = await request("/v1/projects", { name: "JSON Values" });
    const projectId = String(project.body.id);
    const connectionIds: string[] = [];

    for (const [configuration, credentials] of values) {
      const created = await request(`/v1/projects/${projectId}/provider-connections`, {
        provider: "example.json-values",
        name: "JSON Values",
        configuration,
        credentials,
      });

      expect(created.status).toBe(201);
      connectionIds.push(String(created.body.id));
    }

    const invalid = await request(`/v1/projects/${projectId}/provider-connections`, {
      provider: "example.json-values",
      name: "Invalid",
      configuration: 42,
      credentials: "secret",
    });

    expect(invalid.status).toBe(400);
    expect(seen).toHaveLength(3);

    await runtime.close();
    runtime = await openDomainRuntime(options);

    for (const connectionId of connectionIds) {
      const verified = await request(
        `/v1/projects/${projectId}/provider-connections/${connectionId}/verify`,
        {},
      );

      expect(verified.status).toBe(200);
    }

    expect(seen.slice(3)).toEqual(values);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
