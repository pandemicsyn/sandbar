import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type ModalTransport } from "@sandbar/provider-modal";
import { openDomainRuntime } from "./runtime";

type FixtureJson =
  | null
  | boolean
  | number
  | string
  | FixtureJson[]
  | { [key: string]: FixtureJson };

test("service verifies Modal App scope, encrypts credentials and routes bounded resource operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-modal-service-"));
  const keyFile = join(directory, "key");
  const setupTokenFile = join(directory, "setup");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "modal-fixture-setup-token-long-enough");
  await chmod(setupTokenFile, 0o600);

  const records = new Map<string, { id: string; tags: Record<string, string>; running: boolean }>();
  let creates = 0;
  let terminates = 0;
  let closed = 0;
  let starts = 0;
  let loseExec = false;
  let loseWrite = false;
  let loseDestroy = false;

  const processes = new Map<
    string,
    { exitCode: number; stdout: Uint8Array; stderr: Uint8Array; truncated: boolean }
  >();

  const files = new Map<string, Uint8Array>();
  let writePath = "";

  const transport: ModalTransport = {
    async lookupApp(name, environment) {
      if (name !== "existing" || environment !== "main") throw new Error("Wrong App scope");

      return "ap-fixture";
    },
    async imageExists(id) {
      return id === "im-fixture";
    },
    async create(input) {
      expect(input).toMatchObject({
        appId: "ap-fixture",
        imageId: "im-fixture",
        timeoutMs: 300000,
        regions: ["us-east-1"],
      });
      creates++;
      records.set(input.name, { id: "sb-1", tags: input.tags, running: true });

      return "sb-1";
    },
    async findByName(_app, _environment, name) {
      return records.get(name) ?? null;
    },
    async *list(appId) {
      expect(appId).toBe("ap-fixture");

      for (const record of records.values()) if (record.running) yield record;
    },
    async terminate(id) {
      expect(id).toBe("sb-1");
      terminates++;

      for (const record of records.values()) record.running = false;

      if (loseDestroy) {
        loseDestroy = false;
        throw new Error("lost terminate response after native effect");
      }

      return true;
    },
    async poll() {
      return "stopped";
    },
    async readBytes(id, path, maxBytes) {
      expect(id).toBe("sb-1");
      expect(maxBytes).toBe(1_048_576);

      return files.get(path) ?? Uint8Array.from([0, 255, 128]);
    },
    async fileExists(_id, path) {
      return files.has(path);
    },
    async start(input) {
      starts++;

      if (input.command[0] === "/bin/sh" && input.command[2]?.includes("cat >")) {
        writePath = input.command.at(-1)!;
        processes.set(input.execId, {
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          truncated: false,
        });
      } else {
        expect(input.command).toEqual(["printf", "ready"]);
        processes.set(input.execId, {
          exitCode: 0,
          stdout: Uint8Array.from([0, 255, 128]),
          stderr: new Uint8Array(),
          truncated: false,
        });

        if (loseExec) {
          loseExec = false;
          throw new Error("lost exec start after native effect");
        }
      }
    },
    async stdin(_id, execId, bytes) {
      files.set(writePath, bytes.slice());
      processes.set(execId, {
        exitCode: 0,
        stdout: new TextEncoder().encode(`${bytes.length}\n`),
        stderr: new Uint8Array(),
        truncated: false,
      });

      if (loseWrite) {
        loseWrite = false;
        throw new Error("lost stdin acknowledgement after native effect");
      }
    },
    async result(_id, execId) {
      return processes.get(execId)!;
    },
    close() {
      closed++;
    },
  };

  const runtimeOptions = {
    databaseUrl: join(directory, "control.sqlite"),
    keyFile,
    setupTokenFile,
    startRunner: false,
    modalTransportFactory: () => transport,
  };

  let runtime = await openDomainRuntime(runtimeOptions);

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
      setupToken: "modal-fixture-setup-token-long-enough",
    });

    const token = z.object({ token: z.string() }).parse(setup.value).token;
    const project = await request("/v1/projects", "POST", token, { name: "Modal fixture" });
    const projectId = z.object({ id: z.string() }).parse(project.value).id;
    const path = `/v1/projects/${projectId}`;

    const invalid = await request(`${path}/provider-connections`, "POST", token, {
      provider: "modal",
      name: "Invalid timeout",
      credentials: { tokenId: "ak-secret", tokenSecret: "as-secret" },
      configuration: { appName: "existing", environment: "main", timeoutSeconds: "3601" },
    });

    expect(invalid.status).toBe(400);
    expect(creates).toBe(0);

    const connection = await request(`${path}/provider-connections`, "POST", token, {
      provider: "modal",
      name: "Existing App",
      credentials: { tokenId: "ak-secret", tokenSecret: "as-secret" },
      configuration: {
        appName: "existing",
        environment: "main",
        region: "us-east-1",
        timeoutSeconds: "300",
      },
    });

    expect(connection.status).toBe(201);
    expect(JSON.stringify(connection.value)).not.toContain("as-secret");
    const connectionId = z.object({ id: z.string() }).parse(connection.value).id;
    expect(
      (await runtime.store.getConnection(projectId, connectionId))?.encrypted_credentials,
    ).not.toContain("as-secret");

    const verified = await request(
      `${path}/provider-connections/${connectionId}/verify`,
      "POST",
      token,
      {},
    );

    expect(verified.status).toBe(200);
    expect(verified.value).toMatchObject({
      status: "verified",
      nativeScope: {
        adapterScope: {
          authority: { kind: "app", id: "ap-fixture" },
          partition: { environment: "main", endpoint: "https://api.modal.com:443" },
        },
        region: "us-east-1",
      },
    });

    const admitted = await request(
      `${path}/sandboxes`,
      "POST",
      token,
      {
        connectionId,
        environment: { kind: "prepared", imageId: "im-fixture" },
        network: { policy: "blocked" },
        region: "us-east-1",
      },
      Bun.randomUUIDv7(),
    );

    expect(admitted.status).toBe(202);

    const { operation } = z
      .object({ operation: z.object({ id: z.string(), sandboxId: z.string() }) })
      .parse(admitted.value);

    await runtime.runner.tick();
    const outcome = await request(`${path}/operations/${operation.id}`, "GET", token);
    expect(outcome.value).toMatchObject({ status: "succeeded" });
    expect(creates).toBe(1);

    const file = await runtime.app.request(
      `${path}/sandboxes/${operation.sandboxId}/files?path=%2Ffile`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(Uint8Array.from([0, 255, 128]));

    const execution = await request(
      `${path}/sandboxes/${operation.sandboxId}/executions`,
      "POST",
      token,
      { command: { kind: "argv", argv: ["printf", "ready"] } },
      Bun.randomUUIDv7(),
    );

    expect(execution.status).toBe(202);
    await runtime.runner.tick();

    const executionId = z.object({ execution: z.object({ id: z.string() }) }).parse(execution.value)
      .execution.id;

    const output = await request(`${path}/executions/${executionId}`, "GET", token);
    expect(output.value).toMatchObject({
      exitCode: 0,
      stdoutBase64: Buffer.from([0, 255, 128]).toString("base64"),
    });

    const written = await runtime.app.request(
      `${path}/sandboxes/${operation.sandboxId}/files?path=%2Fbinary&overwrite=true`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": Bun.randomUUIDv7() },
        body: Uint8Array.from([0, 255, 129]),
      },
    );

    expect(written.status).toBe(200);

    const roundtrip = await runtime.app.request(
      `${path}/sandboxes/${operation.sandboxId}/files?path=%2Fbinary`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(new Uint8Array(await roundtrip.arrayBuffer())).toEqual(Uint8Array.from([0, 255, 129]));
    expect(starts).toBe(2);

    loseExec = true;

    const uncertain = await request(
      `${path}/sandboxes/${operation.sandboxId}/executions`,
      "POST",
      token,
      { command: { kind: "argv", argv: ["printf", "ready"] } },
      Bun.randomUUIDv7(),
    );

    expect(uncertain.status).toBe(202);

    const uncertainOperation = z
      .object({ operation: z.object({ id: z.string() }), execution: z.object({ id: z.string() }) })
      .parse(uncertain.value);

    await runtime.runner.tick();
    const startsBeforeRestart = starts;
    await runtime.close();
    runtime = await openDomainRuntime(runtimeOptions);
    await request(
      `${path}/operations/${uncertainOperation.operation.id}/reconcile`,
      "POST",
      token,
      {},
    );
    await runtime.runner.tick();

    const recoveredOutput = await request(
      `${path}/executions/${uncertainOperation.execution.id}`,
      "GET",
      token,
    );

    expect(recoveredOutput.value).toMatchObject({
      exitCode: 0,
      stdoutBase64: Buffer.from([0, 255, 128]).toString("base64"),
    });
    expect(starts).toBe(startsBeforeRestart);

    loseWrite = true;

    const uncertainWrite = await runtime.app.request(
      `${path}/sandboxes/${operation.sandboxId}/files?path=%2Frecovered&overwrite=false`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": Bun.randomUUIDv7() },
        body: Uint8Array.from([0, 255, 129]),
      },
    );

    expect(uncertainWrite.status).toBe(202);

    const writeOperation = z
      .object({ operation: z.object({ id: z.string() }) })
      .parse(await uncertainWrite.json()).operation;

    const startsBeforeWriteRestart = starts;
    await runtime.close();
    runtime = await openDomainRuntime(runtimeOptions);
    await request(`${path}/operations/${writeOperation.id}/reconcile`, "POST", token, {});
    await runtime.runner.tick();
    const recoveredWrite = await request(`${path}/operations/${writeOperation.id}`, "GET", token);
    expect(recoveredWrite.value).toMatchObject({
      status: "succeeded",
      result: { receipt: { bytesWritten: 3 } },
    });
    expect(starts).toBe(startsBeforeWriteRestart);

    loseDestroy = true;

    const removal = await request(
      `${path}/sandboxes/${operation.sandboxId}`,
      "DELETE",
      token,
      undefined,
      Bun.randomUUIDv7(),
    );

    expect(removal.status).toBe(202);
    await runtime.runner.tick();
    expect(terminates).toBe(1);

    const removalId = z.object({ operation: z.object({ id: z.string() }) }).parse(removal.value)
      .operation.id;

    await runtime.close();
    runtime = await openDomainRuntime(runtimeOptions);
    await request(`${path}/operations/${removalId}/reconcile`, "POST", token, {});
    await runtime.runner.tick();
    expect((await request(`${path}/operations/${removalId}`, "GET", token)).value).toMatchObject({
      status: "succeeded",
    });
    expect(terminates).toBe(1);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }

  expect(closed).toBeGreaterThan(0);
});
