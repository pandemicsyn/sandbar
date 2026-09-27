import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonRequestBody = { [key: string]: JsonValue };

import { sha256 } from "@sandbar/core";
import { startFakeProviderServer } from "@sandbar/provider-fake";
import { openDomainRuntime } from "./runtime";

const transportToken = "fake-transport-test-token";

let server: Awaited<ReturnType<typeof startFakeProviderServer>> | undefined;

let directory: string | undefined;

afterEach(async () => {
  server?.stop(true);
  server = undefined;

  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("persisted connections reject new work while their provider is unregistered", async () => {
  directory = await mkdtemp(join(tmpdir(), "sandbar-missing-provider-"));

  const keyFile = join(directory, "key"),
    setupTokenFile = join(directory, "setup"),
    databaseUrl = join(directory, "control.sqlite");

  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "test-setup-token-with-long-random-content");
  await chmod(setupTokenFile, 0o600);
  server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "fake.json"),
    token: transportToken,
    testMode: true,
  });

  const daytonaFetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;

      if (path === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

      if (path === "/api/regions")
        return Response.json([
          { id: "us", name: "US", regionType: "shared", organizationId: "org-1" },
        ]);

      if (path === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      throw new Error(`Unexpected Daytona fixture read: ${path}`);
    },
    { preconnect: fetch.preconnect },
  );

  const common = { databaseUrl, keyFile, setupTokenFile, daytonaFetch, startRunner: false };

  const withFake = {
    ...common,
    fakeProviderUrl: server.url.toString(),
    fakeProviderToken: transportToken,
  };

  let runtime = await openDomainRuntime(withFake);
  let bearer = "";

  const request = async (path: string, method: string, body?: JsonRequestBody, key?: string) => {
    const headers: Record<string, string> = {};

    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    if (body !== undefined) headers["Content-Type"] = "application/json";

    if (key) headers["Idempotency-Key"] = key;

    const response = await runtime.app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // SAFETY: This helper reads JSON emitted by the in-process API under test.
    return { response, value: (await response.json()) as any };
  };

  const counts = () => {
    const database = new Database(databaseUrl);

    try {
      return database
        .query(
          "SELECT (SELECT COUNT(*) FROM operations) AS operations,(SELECT COUNT(*) FROM invocation_keys) AS invocations,(SELECT COUNT(*) FROM reservations) AS reservations",
        )
        .get();
    } finally {
      database.close();
    }
  };

  try {
    const setup = await request("/v1/setup", "POST", {
      setupToken: "test-setup-token-with-long-random-content",
    });

    bearer = setup.value.token;
    const project = (await request("/v1/projects", "POST", { name: "Restart" })).value;

    const fake = (
      await request(`/v1/projects/${project.id}/provider-connections`, "POST", {
        provider: "fake",
        name: "Fake",
      })
    ).value;

    expect(
      (
        await request(
          `/v1/projects/${project.id}/provider-connections/${fake.id}/verify`,
          "POST",
          {},
        )
      ).response.status,
    ).toBe(200);

    const daytona = (
      await request(`/v1/projects/${project.id}/provider-connections`, "POST", {
        provider: "daytona",
        name: "Daytona fixture",
        credentials: { apiKey: "fixture-key" },
        configuration: { target: "us" },
      })
    ).value;

    expect(
      (
        await request(
          `/v1/projects/${project.id}/provider-connections/${daytona.id}/verify`,
          "POST",
          {},
        )
      ).response.status,
    ).toBe(200);

    const unsupportedKey = Bun.randomUUIDv7();

    const unsupported = await request(
      `/v1/projects/${project.id}/sandboxes`,
      "POST",
      { environment: { kind: "prepared", imageId: "unsupported-image" }, connectionId: fake.id },
      unsupportedKey,
    );

    expect(unsupported.response.status).toBe(202);
    expect(await runtime.runner.tick()).toBe(true);
    expect(
      (await runtime.store.getOperation(project.id, unsupported.value.operation.id))?.status,
    ).toBe("failed");

    const createKey = Bun.randomUUIDv7();

    const createBody = {
      environment: { kind: "prepared", imageId: "fake-starter" },
      connectionId: fake.id,
    };

    const queued = await request(
      `/v1/projects/${project.id}/sandboxes`,
      "POST",
      createBody,
      createKey,
    );

    expect(queued.response.status).toBe(202);
    await runtime.close();
    runtime = await openDomainRuntime(common);

    const repeated = await request(
      `/v1/projects/${project.id}/sandboxes`,
      "POST",
      createBody,
      createKey,
    );

    expect(repeated.response.status).toBe(202);
    expect(repeated.value.operation.id).toBe(queued.value.operation.id);

    const beforeRejectedCreate = await counts();

    const rejectedCreate = await request(
      `/v1/projects/${project.id}/sandboxes`,
      "POST",
      createBody,
      Bun.randomUUIDv7(),
    );

    expect(rejectedCreate.response.status).toBe(409);
    expect(await counts()).toEqual(beforeRejectedCreate);

    const fallback = await request(
      `/v1/projects/${project.id}/sandboxes`,
      "POST",
      { environment: { kind: "prepared", imageId: "fixture-snapshot" } },
      Bun.randomUUIDv7(),
    );

    expect(fallback.response.status).toBe(202);
    expect(
      (await runtime.store.getOperation(project.id, fallback.value.operation.id))?.connection_id,
    ).toBe(daytona.id);

    await runtime.close();
    runtime = await openDomainRuntime(withFake);
    expect(await runtime.runner.tick()).toBe(true);

    const running = await runtime.store.getSandbox(project.id, queued.value.operation.sandboxId);

    expect(running?.observed_state).toBe("running");
    expect((await runtime.store.getOperation(project.id, queued.value.operation.id))?.status).toBe(
      "succeeded",
    );

    const boxId = queued.value.operation.sandboxId;
    const executionKey = Bun.randomUUIDv7();
    const executionBody = { command: { kind: "shell", script: "printf ready" } };

    const priorExecution = await request(
      `/v1/projects/${project.id}/sandboxes/${boxId}/executions`,
      "POST",
      executionBody,
      executionKey,
    );

    expect(priorExecution.response.status).toBe(202);

    for (let attempt = 0; attempt < 3; attempt++) {
      if (
        (await runtime.store.getExecution(project.id, priorExecution.value.execution.id))
          ?.status === "completed"
      )
        break;

      expect(await runtime.runner.tick()).toBe(true);
    }

    expect(
      (await runtime.store.getExecution(project.id, priorExecution.value.execution.id))?.status,
    ).toBe("completed");

    await runtime.close();
    runtime = await openDomainRuntime(common);

    const repeatedExecution = await request(
      `/v1/projects/${project.id}/sandboxes/${boxId}/executions`,
      "POST",
      executionBody,
      executionKey,
    );

    expect(repeatedExecution.response.status).toBe(202);
    expect(repeatedExecution.value.operation.id).toBe(priorExecution.value.operation.id);
    const retained = new Database(databaseUrl);

    try {
      retained
        .query(
          "UPDATE executions SET output_ciphertext='retained-fixture',output_state='captured' WHERE id=?",
        )
        .run(priorExecution.value.execution.id);
      retained
        .query("UPDATE reservations SET amount=16777216 WHERE operation_id=? AND kind='output'")
        .run(priorExecution.value.operation.id);
    } finally {
      retained.close();
    }

    const priorExecutionRow = await runtime.store.getExecution(
      project.id,
      priorExecution.value.execution.id,
    );

    expect(priorExecutionRow?.output_ciphertext).toBe("retained-fixture");
    const beforeRejectedWork = await counts();

    const execute = await request(
      `/v1/projects/${project.id}/sandboxes/${boxId}/executions`,
      "POST",
      { command: { kind: "shell", script: "true" } },
      Bun.randomUUIDv7(),
    );

    const write = await runtime.app.request(
      `/v1/projects/${project.id}/sandboxes/${boxId}/files?path=%2Ffile&overwrite=true`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${bearer}`, "Idempotency-Key": Bun.randomUUIDv7() },
        body: new Uint8Array([1]),
      },
    );

    const destroy = await request(
      `/v1/projects/${project.id}/sandboxes/${boxId}`,
      "DELETE",
      undefined,
      Bun.randomUUIDv7(),
    );

    expect([execute.response.status, write.status, destroy.response.status]).toEqual([
      409, 409, 409,
    ]);
    expect(await counts()).toEqual(beforeRejectedWork);
    expect((await runtime.store.getSandbox(project.id, boxId))?.desired_state).toBe("running");
    expect(
      (await runtime.store.getExecution(project.id, priorExecution.value.execution.id))
        ?.output_ciphertext,
    ).toBe(priorExecutionRow?.output_ciphertext);

    const localBoxId = unsupported.value.operation.sandboxId;

    const localCleanup = await request(
      `/v1/projects/${project.id}/sandboxes/${localBoxId}`,
      "DELETE",
      undefined,
      Bun.randomUUIDv7(),
    );

    expect(localCleanup.response.status).toBe(202);
    expect((await runtime.store.getSandbox(project.id, localBoxId))?.observed_state).toBe(
      "destroyed",
    );
  } finally {
    await runtime.close();
  }
});

test("runtime rejects remote fake provider endpoints before opening storage", async () => {
  await expect(
    openDomainRuntime({
      databaseUrl: ":memory:",
      keyFile: "/missing",
      setupTokenFile: "/missing",
      fakeProviderUrl: "http://provider.example",
      fakeProviderToken: transportToken,
    }),
  ).rejects.toThrow("loopback");
});

test("runtime rejects mysqls before connecting or creating SQLite storage", async () => {
  const databaseUrl = "mysqls://operator:secret@127.0.0.1:1/control";

  await expect(
    openDomainRuntime({
      databaseUrl,
      keyFile: "/missing",
      setupTokenFile: "/missing",
      fakeProviderUrl: "http://127.0.0.1:8789",
      fakeProviderToken: transportToken,
    }),
  ).rejects.toThrow("mysqls:// is unsupported");
});

test("API persists ambiguous create and exec, then observes each once after restart", async () => {
  directory = await mkdtemp(join(tmpdir(), "sandbar-domain-"));

  const keyFile = join(directory, "key"),
    setupTokenFile = join(directory, "setup"),
    databaseUrl = join(directory, "control.sqlite");

  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "test-setup-token-with-long-random-content");
  await chmod(setupTokenFile, 0o600);
  server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "fake.json"),
    token: transportToken,
    testMode: true,
  });

  const config = {
    databaseUrl,
    keyFile,
    setupTokenFile,
    fakeProviderUrl: server.url.toString(),
    fakeProviderToken: transportToken,
    startRunner: false,
  };

  const ipv6Runtime = await openDomainRuntime({
    ...config,
    databaseUrl: ":memory:",
    publicOrigin: "http://[::1]:3000",
  });

  await ipv6Runtime.close();

  let runtime = await openDomainRuntime(config);

  const json = async (
    path: string,
    method = "GET",
    body?: JsonRequestBody,
    headers: Record<string, string> = {},
  ) => {
    const requestHeaders = { ...headers };

    if (body !== undefined && !("Content-Type" in requestHeaders))
      requestHeaders["Content-Type"] = "application/json";

    const response = await runtime.app.request(path, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // SAFETY: This helper reads JSON emitted by the in-process API under test.
    return { response, value: (await response.json()) as any };
  };

  const control = async (path: string, body?: JsonRequestBody) => {
    const response = await fetch(new URL(path, server!.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${transportToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    expect(response.ok).toBe(true);

    // SAFETY: The local fake-provider control endpoint returns JSON fixtures.
    return response.json() as Promise<any>;
  };

  try {
    const setup = await json("/v1/setup", "POST", {
      setupToken: "test-setup-token-with-long-random-content",
    });

    expect(setup.response.status).toBe(201);
    const bearer = { Authorization: `Bearer ${setup.value.token}` };
    expect(setup.response.headers.get("set-cookie")).toContain("HttpOnly");
    const project = (await json("/v1/projects", "POST", { name: "Demo" }, bearer)).value;

    const invalidFake = await json(
      `/v1/projects/${project.id}/provider-connections`,
      "POST",
      { provider: "fake", name: "Invalid", credentials: { apiKey: "not-a-fake-secret" } },
      bearer,
    );

    expect(invalidFake.response.status).toBe(400);
    expect(invalidFake.value.error.code).toBe("INVALID_ARGUMENT");

    for (const query of [
      "limit=NaN",
      "limit=1.5",
      "limit=0",
      "limit=101",
      "state=running&state=destroyed",
      "limt=1",
      `cursor=${Buffer.from("{}").toString("base64url")}`,
      `cursor=${Buffer.from(JSON.stringify({ createdAt: 1, id: 3 })).toString("base64url")}`,
    ]) {
      expect(
        (await json(`/v1/projects/${project.id}/sandboxes?${query}`, "GET", undefined, bearer))
          .response.status,
      ).toBe(400);
    }

    const connection = (
      await json(
        `/v1/projects/${project.id}/provider-connections`,
        "POST",
        { provider: "fake", name: "Local" },
        bearer,
      )
    ).value;

    expect(connection.encryptedCredentials).toBeUndefined();
    expect(
      (
        await json(
          `/v1/projects/${project.id}/provider-connections/${connection.id}/verify`,
          "POST",
          {},
          bearer,
        )
      ).value.status,
    ).toBe("verified");
    const createKey = Bun.randomUUIDv7();

    const create = await json(
      `/v1/projects/${project.id}/sandboxes`,
      "POST",
      { environment: { kind: "prepared", imageId: "fake-starter" }, connectionId: connection.id },
      { ...bearer, "Idempotency-Key": createKey },
    );

    expect(create.response.status).toBe(202);

    const opId = create.value.operation.id,
      boxId = create.value.operation.sandboxId;

    const createLookup = `/v1/projects/${project.id}/invocations/${createKey}?kind=create`;
    expect((await json(createLookup, "GET", undefined, bearer)).value.id).toBe(opId);
    expect((await json(createLookup)).response.status).toBe(401);

    for (const query of ["kind=create&kind=exec", "kind=create&extra=1"]) {
      const invalid = await json(
        `/v1/projects/${project.id}/invocations/${createKey}?${query}`,
        "GET",
        undefined,
        bearer,
      );

      expect(invalid.response.status).toBe(400);
      expect(invalid.value.error.code).toBe("INVALID_ARGUMENT");
    }

    expect(
      (
        await json(
          `/v1/projects/${project.id}/invocations/${createKey}?kind=exec&sandboxId=${boxId}`,
          "GET",
          undefined,
          bearer,
        )
      ).response.status,
    ).toBe(404);
    const otherProject = (await json("/v1/projects", "POST", { name: "Other" }, bearer)).value;
    expect(
      (
        await json(
          `/v1/projects/${otherProject.id}/invocations/${createKey}?kind=create`,
          "GET",
          undefined,
          bearer,
        )
      ).response.status,
    ).toBe(404);
    const op = await runtime.store.getOperation(project.id, opId);
    await control("/_test/seed", {
      submissionId: op!.provider_token,
      action: "create",
      behavior: "lost_after_effect",
    });
    await runtime.runner.tick();
    expect((await runtime.store.getOperation(project.id, opId))?.status).toBe("unknown");
    expect(
      (await json(`/v1/projects/${project.id}/operations/${opId}`, "GET", undefined, bearer)).value
        .recovery,
    ).toEqual(["check_again"]);
    await runtime.close();
    runtime = await openDomainRuntime(config);
    expect(
      (await json(`/v1/projects/${project.id}/operations/${opId}/reconcile`, "POST", {}, bearer))
        .response.status,
    ).toBe(200);
    await runtime.runner.tick();
    expect(
      (await json(`/v1/projects/${project.id}/operations/${opId}`, "GET", undefined, bearer)).value
        .status,
    ).toBe("succeeded");
    expect(
      (await json(`/v1/projects/${project.id}/sandboxes/${boxId}`, "GET", undefined, bearer)).value
        .observedState,
    ).toBe("running");

    const fleet = await json(
      `/v1/projects/${project.id}/sandboxes?state=running&q=${boxId}`,
      "GET",
      undefined,
      bearer,
    );

    expect(fleet.value.items).toHaveLength(1);

    const execKey = Bun.randomUUIDv7();

    const exec = await json(
      `/v1/projects/${project.id}/sandboxes/${boxId}/executions`,
      "POST",
      { command: { kind: "argv", argv: ["fixture", "hello"] } },
      { ...bearer, "Idempotency-Key": execKey },
    );

    expect(exec.response.status).toBe(202);
    expect(
      (
        await json(
          `/v1/projects/${project.id}/invocations/${execKey}?kind=exec&sandboxId=${boxId}`,
          "GET",
          undefined,
          bearer,
        )
      ).value.id,
    ).toBe(exec.value.operation.id);
    const execOp = await runtime.store.getOperation(project.id, exec.value.operation.id);
    expect(execOp!.request_json).toContain("encryptedRequest");
    expect(execOp!.request_json).not.toContain("fixture");
    await control("/_test/seed", {
      submissionId: execOp!.provider_token,
      action: "exec",
      behavior: "lost_after_effect",
      command: {
        command: { kind: "argv", argv: ["fixture", "hello"] },
        exitCode: 7,
        stdoutBase64: Buffer.from("hello from fake").toString("base64"),
      },
    });
    await runtime.runner.tick();
    expect((await runtime.store.getOperation(project.id, exec.value.operation.id))?.status).toBe(
      "unknown",
    );
    expect(
      (await runtime.store.getOperation(project.id, exec.value.operation.id))?.request_json,
    ).not.toContain("encryptedRequest");
    await json(
      `/v1/projects/${project.id}/operations/${exec.value.operation.id}/reconcile`,
      "POST",
      {},
      bearer,
    );
    await runtime.runner.tick();

    const execution = (
      await json(
        `/v1/projects/${project.id}/executions/${exec.value.execution.id}`,
        "GET",
        undefined,
        bearer,
      )
    ).value;

    expect(execution.exitCode).toBe(7);
    expect(execution.stdoutBase64).toBe(Buffer.from("hello from fake").toString("base64"));
    expect(execution.stdout).toBeUndefined();
    const binary = Buffer.from([0xff, 0x00, 0x80]);

    const binaryExec = await json(
      `/v1/projects/${project.id}/sandboxes/${boxId}/executions`,
      "POST",
      { command: { kind: "argv", argv: ["fixture", "binary"] } },
      { ...bearer, "Idempotency-Key": Bun.randomUUIDv7() },
    );

    const binaryOp = await runtime.store.getOperation(project.id, binaryExec.value.operation.id);
    await control("/_test/seed", {
      submissionId: binaryOp!.provider_token,
      action: "exec",
      behavior: "normal",
      command: {
        command: { kind: "argv", argv: ["fixture", "binary"] },
        exitCode: 0,
        stdoutBase64: binary.toString("base64"),
      },
    });
    await runtime.runner.tick();

    const binaryResult = (
      await json(
        `/v1/projects/${project.id}/executions/${binaryExec.value.execution.id}`,
        "GET",
        undefined,
        bearer,
      )
    ).value;

    expect(Buffer.from(binaryResult.stdoutBase64, "base64")).toEqual(binary);
    expect(
      (await runtime.store.getOperation(project.id, exec.value.operation.id))?.result_json,
    ).not.toContain("hello from fake");
    const bytes = Uint8Array.from([0, 255, 1]);

    for (const query of [
      "overwrite=1",
      "overwrite=True",
      "overwrite=true&overwrite=false",
      "overwrite=true&extra=1",
    ]) {
      const invalid = await runtime.app.request(
        `/v1/projects/${project.id}/sandboxes/${boxId}/files?path=/data/invalid&${query}`,
        {
          method: "PUT",
          headers: { ...bearer, "Idempotency-Key": Bun.randomUUIDv7() },
          body: bytes,
        },
      );

      expect(invalid.status).toBe(400);
      // SAFETY: The in-process API returns a structured error response here.
      expect(((await invalid.json()) as any).error.code).toBe("INVALID_ARGUMENT");
    }

    const write = await runtime.app.request(
      `/v1/projects/${project.id}/sandboxes/${boxId}/files?path=/data/blob`,
      { method: "PUT", headers: { ...bearer, "Idempotency-Key": Bun.randomUUIDv7() }, body: bytes },
    );

    expect(write.status).toBe(200);
    // SAFETY: The successful fake write returns a FileReceipt JSON object.
    expect(((await write.json()) as any).bytesWritten).toBe(bytes.length);

    const read = await runtime.app.request(
      `/v1/projects/${project.id}/sandboxes/${boxId}/files?path=/data/blob`,
      { headers: bearer },
    );

    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);

    const invalidDotPath = "/data/./blob";
    const invalidWriteKey = Bun.randomUUIDv7();
    const invocationsBeforeInvalidPath = (await control("/_test/state")).invocations.length;

    const invalidRead = await json(
      `/v1/projects/${project.id}/sandboxes/${boxId}/files?path=${invalidDotPath}`,
      "GET",
      undefined,
      bearer,
    );

    expect(invalidRead.response.status).toBe(400);
    expect(invalidRead.value.error.code).toBe("INVALID_ARGUMENT");

    const invalidWrite = await runtime.app.request(
      `/v1/projects/${project.id}/sandboxes/${boxId}/files?path=${invalidDotPath}`,
      {
        method: "PUT",
        headers: { ...bearer, "Idempotency-Key": invalidWriteKey },
        body: bytes,
      },
    );

    expect(invalidWrite.status).toBe(400);
    // SAFETY: The in-process API emits an ErrorResponse for invalid file paths.
    expect(((await invalidWrite.json()) as any).error.code).toBe("INVALID_ARGUMENT");
    expect(
      (
        await json(
          `/v1/projects/${project.id}/invocations/${invalidWriteKey}?kind=file_write&sandboxId=${boxId}`,
          "GET",
          undefined,
          bearer,
        )
      ).response.status,
    ).toBe(404);
    expect((await control("/_test/state")).invocations).toHaveLength(invocationsBeforeInvalidPath);

    for (const query of ["path=/data/blob&path=/data/missing", "path=/data/blob&extra=1"]) {
      const invalid = await json(
        `/v1/projects/${project.id}/sandboxes/${boxId}/files?${query}`,
        "GET",
        undefined,
        bearer,
      );

      expect(invalid.response.status).toBe(400);
      expect(invalid.value.error.code).toBe("INVALID_ARGUMENT");
    }

    const missing = await runtime.app.request(
      `/v1/projects/${project.id}/sandboxes/${boxId}/files?path=/data/missing`,
      { headers: bearer },
    );

    expect(missing.status).toBe(404);
    // SAFETY: The missing-file response is the public ErrorResponse contract.
    expect(((await missing.json()) as any).error.code).toBe("NOT_FOUND");
    await control("/_test/seed", {
      submissionId: "*",
      action: "file_write",
      behavior: "lost_after_effect",
    });
    const lostWriteKey = Bun.randomUUIDv7();

    const lostWrite = await runtime.app.request(
      `/v1/projects/${project.id}/sandboxes/${boxId}/files?path=/data/lost`,
      { method: "PUT", headers: { ...bearer, "Idempotency-Key": lostWriteKey }, body: bytes },
    );

    expect(lostWrite.status).toBe(202);
    // SAFETY: Accepted file writes return an operation wrapper.
    const lostOperation = ((await lostWrite.json()) as any).operation;
    expect(
      (
        await json(
          `/v1/projects/${project.id}/invocations/${lostWriteKey}?kind=file_write&sandboxId=${boxId}`,
          "GET",
          undefined,
          bearer,
        )
      ).value.id,
    ).toBe(lostOperation.id);
    expect(lostOperation.status).toBe("unknown");
    await json(
      `/v1/projects/${project.id}/operations/${lostOperation.id}/reconcile`,
      "POST",
      {},
      bearer,
    );
    await runtime.runner.tick();

    const recoveredWrite = (
      await json(
        `/v1/projects/${project.id}/operations/${lostOperation.id}`,
        "GET",
        undefined,
        bearer,
      )
    ).value;

    expect(recoveredWrite.status).toBe("succeeded");
    expect(recoveredWrite.result.receipt.bytesWritten).toBe(bytes.length);
    const fakeState = await control("/_test/state");
    expect(fakeState.invocations.filter((item: any) => item.action === "create")).toHaveLength(1);
    expect(fakeState.invocations.filter((item: any) => item.action === "exec")).toHaveLength(2);
    expect(fakeState.invocations.filter((item: any) => item.action === "file_write")).toHaveLength(
      2,
    );

    const rejectedCreate = await json(
      `/v1/projects/${project.id}/sandboxes`,
      "POST",
      {
        environment: { kind: "prepared", imageId: "unsupported-image" },
        connectionId: connection.id,
      },
      { ...bearer, "Idempotency-Key": Bun.randomUUIDv7() },
    );

    const rejectedBoxId = rejectedCreate.value.operation.sandboxId;

    // Keep the create admission earlier than its queued cleanup in millisecond SQL ordering.
    await Bun.sleep(2);

    const cleanup = await json(
      `/v1/projects/${project.id}/sandboxes/${rejectedBoxId}`,
      "DELETE",
      undefined,
      { ...bearer, "Idempotency-Key": Bun.randomUUIDv7() },
    );

    expect(cleanup.value.operation.status).toBe("queued");

    const cleanupDeadline = Date.now() + 2_000;

    while (
      Date.now() < cleanupDeadline &&
      (await runtime.store.getOperation(project.id, cleanup.value.operation.id))?.status !==
        "succeeded"
    ) {
      if (!(await runtime.runner.tick())) await Bun.sleep(10);
    }

    expect(
      (
        await json(
          `/v1/projects/${project.id}/operations/${cleanup.value.operation.id}`,
          "GET",
          undefined,
          bearer,
        )
      ).value.status,
    ).toBe("succeeded");
    expect(
      (
        await json(
          `/v1/projects/${project.id}/sandboxes/${rejectedBoxId}`,
          "GET",
          undefined,
          bearer,
        )
      ).value.observedState,
    ).toBe("destroyed");
  } finally {
    await runtime.close();
  }
});

test("single-use setup, hashed credentials, session CSRF and logout", async () => {
  directory = await mkdtemp(join(tmpdir(), "sandbar-auth-"));

  const keyFile = join(directory, "key"),
    setupTokenFile = join(directory, "setup");

  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-single-use-setup-token-for-test");
  await chmod(setupTokenFile, 0o600);

  const runtime = await openDomainRuntime({
    databaseUrl: join(directory, "control.sqlite"),
    keyFile,
    setupTokenFile,
    fakeProviderUrl: "http://127.0.0.1:8789",
    fakeProviderToken: transportToken,
    startRunner: false,
  });

  try {
    const setupRequest = () =>
      runtime.app.request("http://localhost/v1/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ setupToken: "long-single-use-setup-token-for-test" }),
      });

    const results = await Promise.all([setupRequest(), setupRequest()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const success = results.find((r) => r.status === 201)!;
    // SAFETY: The successful setup response is a SessionResponse with token and CSRF fields.
    const { token, csrfToken } = (await success.json()) as { token: string; csrfToken: string };
    const cookie = success.headers.get("set-cookie")!.split(";")[0];
    expect(await runtime.store.authenticateBearer(token)).toBe(false);
    expect(await runtime.store.authenticateBearer(await sha256(token))).toBe(true);
    const projectBody = JSON.stringify({ name: "Private" });

    const mutate = (headers: Record<string, string>) =>
      runtime.app.request("http://localhost/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie, ...headers },
        body: projectBody,
      });

    expect((await mutate({ Origin: "http://localhost" })).status).toBe(403);
    expect(
      (await mutate({ Origin: "http://evil.invalid", "X-CSRF-Token": csrfToken })).status,
    ).toBe(403);
    expect((await mutate({ Origin: "http://localhost", "X-CSRF-Token": csrfToken })).status).toBe(
      201,
    );

    const refreshed = await runtime.app.request("http://localhost/v1/session", {
      headers: { Cookie: cookie },
    });

    expect(refreshed.status).toBe(200);
    // SAFETY: The successful session response contains the CSRF token.
    const nextCsrf = ((await refreshed.json()) as { csrfToken: string }).csrfToken;
    expect(nextCsrf).toBe(csrfToken);
    expect((await mutate({ Origin: "http://localhost", "X-CSRF-Token": csrfToken })).status).toBe(
      201,
    );

    const logout = await runtime.app.request("http://localhost/v1/sessions/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://localhost", "X-CSRF-Token": nextCsrf },
    });

    expect(logout.status).toBe(204);
    expect(
      (await runtime.app.request("http://localhost/v1/session", { headers: { Cookie: cookie } }))
        .status,
    ).toBe(401);
    expect(
      (
        await runtime.app.request("http://localhost/v1/projects", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
  } finally {
    await runtime.close();
  }
});

test("public JSON routes reject declared and streamed bodies above 64 KiB before mutation", async () => {
  directory = await mkdtemp(join(tmpdir(), "sandbar-public-json-"));

  const keyFile = join(directory, "key"),
    setupTokenFile = join(directory, "setup");

  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-public-json-setup-token-for-test");
  await chmod(setupTokenFile, 0o600);

  const runtime = await openDomainRuntime({
    databaseUrl: join(directory, "control.sqlite"),
    keyFile,
    setupTokenFile,
    fakeProviderUrl: "http://127.0.0.1:8789",
    fakeProviderToken: transportToken,
    startRunner: false,
  });

  // SAFETY: Bun accepts the standard Request duplex option for streamed request bodies.
  const request = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
    runtime.app.request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      duplex: "half",
    } as RequestInit);

  const streamedBody = () => {
    let canceled = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024));
        controller.enqueue(new Uint8Array(32 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        canceled = true;
      },
    });

    return { stream, wasCanceled: () => canceled };
  };

  const expectCapacity = async (response: Response) => {
    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      error: {
        code: "CAPACITY",
        message: "JSON body exceeds 64 KiB limit",
        effect: "none",
        retry: "never",
      },
    });
  };

  try {
    const setupBody = JSON.stringify({ setupToken: "long-public-json-setup-token-for-test" });

    await expectCapacity(
      await request("/v1/setup", setupBody, { "Content-Length": String(64 * 1024 + 1) }),
    );
    expect(await runtime.store.hasOperator()).toBe(false);

    const oversizedSetup = streamedBody();
    await expectCapacity(await request("/v1/setup", oversizedSetup.stream));
    expect(oversizedSetup.wasCanceled()).toBe(true);
    expect(await runtime.store.hasOperator()).toBe(false);

    const setup = await request("/v1/setup", setupBody);
    expect(setup.status).toBe(201);
    // SAFETY: Successful setup returns the bearer token for this test fixture.
    const { token } = (await setup.json()) as { token: string };

    const sessionCount = () => {
      const database = new Database(join(directory!, "control.sqlite"), { readonly: true });

      try {
        // SAFETY: This fixed aggregate query returns one row with an integer count.
        return (database.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number })
          .count;
      } finally {
        database.close();
      }
    };

    expect(sessionCount()).toBe(1);

    const sessionBody = JSON.stringify({ token });

    await expectCapacity(
      await request("/v1/sessions", sessionBody, { "Content-Length": String(64 * 1024 + 1) }),
    );
    const oversizedSession = streamedBody();
    await expectCapacity(
      await request("/v1/sessions", oversizedSession.stream, { "Content-Length": "1" }),
    );
    expect(oversizedSession.wasCanceled()).toBe(true);
    expect(sessionCount()).toBe(1);

    const session = await request("/v1/sessions", sessionBody);
    expect(session.status).toBe(201);
    expect(session.headers.get("set-cookie")).toContain("HttpOnly");
    expect(sessionCount()).toBe(2);
  } finally {
    await runtime.close();
  }
});

test("HTTPS logout deletes the host-prefixed cookie with Secure", async () => {
  directory = await mkdtemp(join(tmpdir(), "sandbar-https-cookie-"));

  const keyFile = join(directory, "key"),
    setupTokenFile = join(directory, "setup");

  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-https-setup-token-for-test");
  await chmod(setupTokenFile, 0o600);

  const runtime = await openDomainRuntime({
    databaseUrl: join(directory, "control.sqlite"),
    keyFile,
    setupTokenFile,
    fakeProviderUrl: "http://127.0.0.1:8789",
    fakeProviderToken: transportToken,
    publicOrigin: "https://sandbar.example",
    startRunner: false,
  });

  try {
    const setup = await runtime.app.request("https://sandbar.example/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://sandbar.example" },
      body: JSON.stringify({ setupToken: "long-https-setup-token-for-test" }),
    });

    expect(setup.status).toBe(201);
    const cookie = setup.headers.get("set-cookie")!;

    expect(cookie).toContain("__Host-sandbar_session=");
    expect(cookie).toContain("Secure");
    // SAFETY: A successful setup response contains its browser CSRF token.
    const csrfToken = ((await setup.json()) as { csrfToken: string }).csrfToken;

    const logout = await runtime.app.request("https://sandbar.example/v1/sessions/logout", {
      method: "POST",
      headers: {
        Cookie: cookie.split(";")[0],
        Origin: "https://sandbar.example",
        "X-CSRF-Token": csrfToken,
      },
    });

    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("__Host-sandbar_session=");
    expect(logout.headers.get("set-cookie")).toContain("Secure");
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  } finally {
    await runtime.close();
  }
});

test("output reservation failure uses the public output capacity code", async () => {
  directory = await mkdtemp(join(tmpdir(), "sandbar-output-capacity-"));

  const keyFile = join(directory, "key"),
    setupTokenFile = join(directory, "setup");

  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-output-capacity-setup-token");
  await chmod(setupTokenFile, 0o600);

  const runtime = await openDomainRuntime({
    databaseUrl: join(directory, "control.sqlite"),
    keyFile,
    setupTokenFile,
    fakeProviderUrl: "http://127.0.0.1:8789",
    fakeProviderToken: transportToken,
    startRunner: false,
  });

  try {
    const setup = await runtime.app.request("http://localhost/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ setupToken: "long-output-capacity-setup-token" }),
    });

    // SAFETY: Successful setup returns the bearer token for this API fixture.
    const token = ((await setup.json()) as { token: string }).token;
    const project = await runtime.store.createProject("capacity");

    const connection = await runtime.store.createConnection({
      id: "conn_capacity",
      projectId: project.id,
      provider: "fake",
      name: "Fake",
      encryptedCredentials: "ciphertext",
    });

    await runtime.store.verifyConnection(project.id, connection.id, "fake-local");

    const create = await runtime.store.admitCreate({
      projectId: project.id,
      endpoint: "POST /sandboxes",
      key: Bun.randomUUIDv7(),
      intentHash: "create",
      request: { environment: { kind: "prepared", imageId: "fake-starter" } },
      connectionId: connection.id,
    });

    const createClaim = (await runtime.store.claimDue("setup", 1000, project.id))!;
    await runtime.store.complete(createClaim, {
      effect: "applied",
      value: {
        kind: "sandbox",
        observation: { ref: { nativeId: "native_capacity" }, state: "running" },
      },
    });

    const captured = await runtime.store.admitExec({
      projectId: project.id,
      sandboxId: create.sandbox.id,
      endpoint: `POST /sandboxes/${create.sandbox.id}/executions`,
      key: Bun.randomUUIDv7(),
      intentHash: "terminal-output",
      encryptedRequest: "sealed",
      captureBytes: 1024 * 1024,
    });

    const capturedClaim = (await runtime.store.claimDue("capture", 1000, project.id))!;
    await runtime.store.complete(capturedClaim, {
      effect: "applied",
      value: { kind: "execution", observation: { completed: true, exitCode: 7 } },
      encryptedOutput: "sealed-output",
      outputBytes: 1024 * 1024,
    });
    await runtime.store.admitExec({
      projectId: project.id,
      sandboxId: create.sandbox.id,
      endpoint: `POST /sandboxes/${create.sandbox.id}/executions`,
      key: Bun.randomUUIDv7(),
      intentHash: "active-output",
      encryptedRequest: "sealed",
      captureBytes: 15 * 1024 * 1024,
    });

    const admit = () =>
      runtime.app.request(
        `http://localhost/v1/projects/${project.id}/sandboxes/${create.sandbox.id}/executions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": Bun.randomUUIDv7(),
          },
          body: JSON.stringify({ command: { kind: "argv", argv: ["fixture"] } }),
        },
      );

    expect((await admit()).status).toBe(202);

    const evicted = await runtime.app.request(
      `http://localhost/v1/projects/${project.id}/executions/${captured.execution!.id}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(evicted.status).toBe(200);
    // SAFETY: The execution endpoint returns the public execution DTO after eviction.
    expect(await evicted.json()).toMatchObject({
      outputAvailability: "evicted",
      capturedBytes: 1024 * 1024,
      exitCode: 7,
    });
    const response = await admit();

    expect(response.status).toBe(409);
    // SAFETY: This is the public ErrorResponse at the admission boundary.
    expect(((await response.json()) as any).error.code).toBe("OUTPUT_CAPACITY");
  } finally {
    await runtime.close();
  }
});

test("hard process kill after submission marker never replays create", async () => {
  directory = await mkdtemp(join(tmpdir(), "sandbar-crash-"));

  const keyFile = join(directory, "key"),
    setupTokenFile = join(directory, "setup"),
    databaseUrl = join(directory, "control.sqlite");

  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-crash-test-setup-token-content");
  await chmod(setupTokenFile, 0o600);
  server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "fake.json"),
    token: transportToken,
    testMode: true,
  });

  const config = {
    databaseUrl,
    keyFile,
    setupTokenFile,
    fakeProviderUrl: server.url.toString(),
    fakeProviderToken: transportToken,
    startRunner: false,
  };

  let runtime = await openDomainRuntime(config);
  let projectId: string, operationId: string;

  try {
    const setup = await runtime.app.request("/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupToken: "long-crash-test-setup-token-content" }),
    });

    // SAFETY: Successful setup returns the bearer token used in this fixture.
    const token = ((await setup.json()) as any).token;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const project = await runtime.app.request("/v1/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Crash" }),
    });

    // SAFETY: Successful project creation returns its ID.
    projectId = ((await project.json()) as any).id;

    const connection = await runtime.app.request(`/v1/projects/${projectId}/provider-connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "fake", name: "Fake" }),
    });

    // SAFETY: Successful connection creation returns its ID.
    const connectionId = ((await connection.json()) as any).id;
    await runtime.app.request(
      `/v1/projects/${projectId}/provider-connections/${connectionId}/verify`,
      { method: "POST", headers, body: "{}" },
    );

    const admission = await runtime.app.request(`/v1/projects/${projectId}/sandboxes`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": Bun.randomUUIDv7() },
      body: JSON.stringify({
        environment: { kind: "prepared", imageId: "fake-starter" },
        connectionId,
      }),
    });

    expect(admission.status).toBe(202);
    // SAFETY: Accepted sandbox creation returns an operation wrapper.
    operationId = ((await admission.json()) as any).operation.id;
  } finally {
    await runtime.close();
  }

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "test-support/crash-after-submission.ts"),
      databaseUrl,
    ],
    { cwd: join(import.meta.dir, "../../.."), stdout: "ignore", stderr: "pipe" },
  );

  const exitCode = await child.exited;
  const childStderr = await new Response(child.stderr).text();

  if (child.signalCode !== "SIGKILL")
    throw new Error(
      `Crash fixture exited before the deliberate hard kill: code=${exitCode}, signal=${child.signalCode}, stderr=${childStderr}`,
    );

  const markerDatabase = new Database(databaseUrl, { readonly: true });

  let marker:
    | { status: string; phase: string; effect: string; submission_possible: number }
    | undefined;

  try {
    // SAFETY: The fixture's operations table has these fixed marker columns for one ID.
    marker = markerDatabase
      .query("SELECT status, phase, effect, submission_possible FROM operations WHERE id = ?")
      .get(operationId!) as
      | { status: string; phase: string; effect: string; submission_possible: number }
      | undefined;

    expect(marker).toMatchObject({
      status: "running",
      phase: "submitted",
      effect: "possible",
      submission_possible: 1,
    });
  } finally {
    markerDatabase.close();
  }

  runtime = await openDomainRuntime(config);

  try {
    expect(await runtime.runner.tick()).toBe(true);
    const op = await runtime.store.getOperation(projectId!, operationId!);

    if (op?.status !== "unknown")
      throw new Error(
        `Expected observation-only unknown after hard kill: ${JSON.stringify({ exitCode, signal: child.signalCode, childStderr, marker, postTickStatus: op?.status })}`,
      );

    expect(op.status).toBe("unknown");

    const stateResponse = await fetch(new URL("/_test/state", server.url), {
      headers: { Authorization: `Bearer ${transportToken}` },
    });

    // SAFETY: The local fake test endpoint returns its invocation array.
    const state = (await stateResponse.json()) as { invocations: unknown[] };
    expect(state.invocations).toHaveLength(0);
  } finally {
    await runtime.close();
  }
});
