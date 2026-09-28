import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { E2BTransport } from "sandbar-sdk/e2b";
import { Sandbar, Image } from "../../../packages/service/src/client";
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
  let builds = 0;
  let buildName = "";
  const files = new Map<string, Uint8Array>();
  const binary = Uint8Array.from([0, 255, 128]);

  const transport: E2BTransport = {
    async verifyTeam(id) {
      if (id !== "team_one") throw new Error("wrong team");
    },
    async verifyTemplate(team, template) {
      if (team !== "team_one" || !["template_one", "template_built"].includes(template))
        throw new Error("wrong template");
    },
    async buildImage(reference, name) {
      expect(reference).toBe("node:24");
      builds++;
      buildName = name;
      throw new Error("lost build response");
    },
    async findBuild(_team, name) {
      return name === buildName
        ? { templateId: "template_built", buildId: "build_one", status: "ready" }
        : null;
    },
    async create(input) {
      creates++;
      record = {
        id: `sb_${creates}`,
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
    async run(_id, script) {
      if (script.includes("ln -T --")) {
        const stage = [...files.keys()].find((path) => path.includes(".sandbar-write-"));

        if (!stage) throw new Error("missing staged file");

        if (files.has("/tmp/no-clobber.bin")) return "EXISTS";
        files.set("/tmp/no-clobber.bin", files.get(stage)!);

        return "CREATED";
      }

      if (script.includes(".status")) {
        const stdout = script.match(/\/tmp\/\.sandbar-[A-Za-z0-9_-]+\.stdout/)?.[0];

        if (!stdout) throw new Error("missing correlated output path");
        files.set(stdout, binary);
        files.set(stdout.replace(".stdout", ".stderr"), Uint8Array.of(254));
        files.set(stdout.replace(".stdout", ".status"), new TextEncoder().encode("0"));
      }

      return "";
    },
    async read(_id, path, max) {
      const bytes = files.get(path);

      if (!bytes) throw new Error("missing file");

      return { bytes: bytes.slice(0, max), truncated: bytes.length > max };
    },
    async write(_id, path, bytes) {
      files.set(path, bytes);
    },
    async remove(_id, path) {
      files.delete(path);
    },
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

    const client = Sandbar.connect({
      url: "http://127.0.0.1:12345",
      projectId,
      token,
      fetch: Object.assign(
        async (url: RequestInfo | URL, init?: RequestInit) =>
          runtime.app.request(String(url), init),
        { preconnect() {} },
      ),
    });

    const build = await client.images.submitBuild({ source: Image.oci("node:24") });

    await runtime.runner.tick();
    expect(builds).toBe(1);
    expect(creates).toBe(1);
    const persisted = await runtime.store.getOperation(projectId, build.reference.operationId!);

    expect(persisted?.sandbox_id).toBeNull();
    await runtime.close();
    runtime = await openDomainRuntime(options);
    await request(`${path}/operations/${build.reference.operationId}/reconcile`, "POST", token, {});
    await runtime.runner.tick();
    const image = await (await client.recover(JSON.parse(JSON.stringify(build.reference)))).wait();

    const built = z
      .object({
        prepared: z.object({
          kind: z.literal("prepared"),
          value: z.string(),
          provider: z.string(),
          scope: z.object({
            authority: z.object({ kind: z.string(), id: z.string() }),
            partition: z.record(z.string(), z.string()),
          }),
          connectionId: z.string(),
        }),
        retainedResources: z.array(
          z.object({ ownership: z.literal("unknown"), cleanup: z.literal("manual") }),
        ),
      })
      .parse(image);

    expect(built.prepared.value).toBe("template_built");
    expect(builds).toBe(1);
    await expect(
      client.sandboxes.submitCreate({
        environment: Image.prepared({ ...built.prepared, provider: "other" }),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(creates).toBe(1);

    const creation = await client.sandboxes.submitCreate({
      environment: Image.prepared(built.prepared),
    });

    await runtime.runner.tick();
    await request(
      `${path}/operations/${creation.reference.operationId}/reconcile`,
      "POST",
      token,
      {},
    );
    await runtime.runner.tick();
    const box = await creation.wait();

    expect(creates).toBe(2);
    runtime.runner.start();

    const output = await box.exec({
      command: { kind: "argv", argv: ["printf", "fixture"] },
      maxOutputBytes: 8,
    });

    expect(output.stdout).toEqual(binary);
    expect(output.stderr).toEqual(Uint8Array.of(254));
    await box.writeFile("/tmp/binary.bin", binary, { overwrite: true });
    await box.writeFile("/tmp/no-clobber.bin", binary, { overwrite: false });
    expect(await box.readFile("/tmp/binary.bin")).toEqual(binary);
    await expect(
      box.writeFile("/tmp/no-clobber.bin", Uint8Array.of(1), { overwrite: false }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await box.destroy();
    await client.close();
    expect(record).toBeNull();
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
