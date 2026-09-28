import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { openDomainRuntime } from "./runtime";
import { Sandbar, Image } from "../../../packages/service/src/client";

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
    creates = 0,
    snapshotReads = 0,
    limitedNetworkEgress = false,
    credentialStatus = 200,
    regionStatus = 200,
    regionType: "shared" | "dedicated" = "shared",
    regionOwner = "org-1";

  let createdState = "started";

  const calls: string[] = [];

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);

    if (url.pathname === "/api/api-keys/current")
      return credentialStatus === 200
        ? Response.json({ organizationId: account })
        : new Response("private-key sensitive provider detail", { status: credentialStatus });

    if (url.pathname === `/api/organizations/${account}`)
      return Response.json({ id: account, sandboxLimitedNetworkEgress: limitedNetworkEgress });

    if (url.pathname === "/api/regions")
      return regionStatus === 200
        ? Response.json([
            { id: "us", name: "United States", regionType, organizationId: regionOwner },
          ])
        : new Response("private region detail", { status: regionStatus });

    if (url.pathname === "/api/snapshots/snap-1") {
      snapshotReads++;

      if (snapshotReads > creates + 1)
        throw new Error("snapshot was checked after durable submission");

      return Response.json({
        id: "snap-1",
        organizationId: account,
        state: "active",
        regionIds: ["us"],
        sandboxClass: "linux-vm",
      });
    }

    if (url.pathname === "/api/sandbox" && init?.method === "POST") {
      creates++;

      const body = z
        .object({ name: z.string(), networkBlockAll: z.boolean(), snapshot: z.string() })
        .parse(JSON.parse(String(init.body)));

      expect(body.networkBlockAll).toBe(true);
      expect(body.snapshot).toBe("snap-1");

      return Response.json({
        id: `native-${creates}`,
        name: body.name,
        organizationId: account,
        target: "us",
        state: createdState,
        networkBlockAll: true,
        public: false,
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

    const invalidConfigurations: Record<string, string>[] = [
      { apiUrl: "http://example.com/api", target: "us" },
      { apiUrl: "https://user:pass@app.daytona.io/api", target: "us" },
      { apiUrl: "https://app.daytona.io/api?private=1", target: "us" },
      { apiUrl: "https://app.daytona.io/api#private", target: "us" },
      { toolboxOrigin: "https://proxy.app.daytona.io/path", target: "us" },
    ];

    for (const configuration of invalidConfigurations) {
      const invalid = await request(
        `/v1/projects/${project.id}/provider-connections`,
        "POST",
        {
          provider: "daytona",
          name: "Invalid endpoint shape",
          credentials: { apiKey: "private-key" },
          configuration,
        },
        token,
      );

      expect(invalid.response.status).toBe(400);
      expect(invalid.value).toEqual({
        error: {
          code: "INVALID_ARGUMENT",
          message: "Adapter input or connection is invalid",
          effect: "none",
          retry: "never",
        },
      });
      expect(calls).toHaveLength(0);
    }

    for (const [caseName, target] of [
      ["missing", "not-a-region"],
      ["foreign-dedicated", "us"],
    ] as const) {
      regionType = caseName === "foreign-dedicated" ? "dedicated" : "shared";
      regionOwner = caseName === "foreign-dedicated" ? "org-other" : account;

      const candidate = await request(
        `/v1/projects/${project.id}/provider-connections`,
        "POST",
        {
          provider: "daytona",
          name: caseName,
          credentials: { apiKey: "private-key" },
          configuration: { target },
        },
        token,
      );

      expect(candidate.response.status).toBe(201);
      const candidateId = z.object({ id: z.string() }).parse(candidate.value).id;

      const verification = await request(
        `/v1/projects/${project.id}/provider-connections/${candidateId}/verify`,
        "POST",
        {},
        token,
      );

      expect(verification.response.status).toBe(400);
      expect(verification.value).toEqual({
        error: {
          code: "INVALID_ARGUMENT",
          message: "Invalid request",
          effect: "none",
          retry: "never",
        },
      });
      expect(JSON.stringify(verification.value)).not.toContain("private-key");
      expect((await runtime.store.getConnection(project.id, candidateId))?.status).toBe(
        "unverified",
      );
      expect(creates).toBe(0);
    }

    regionType = "shared";
    regionOwner = account;

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

    for (const status of [401, 403]) {
      credentialStatus = status;
      const callsBeforeVerify = calls.length;

      const rejected = await request(
        `/v1/projects/${project.id}/provider-connections/${connection.id}/verify`,
        "POST",
        {},
        token,
      );

      expect(rejected.response.status).toBe(401);
      expect(rejected.value).toEqual({
        error: {
          code: "UNAUTHENTICATED",
          message: "Provider credential rejected",
          effect: "none",
          retry: "never",
        },
      });
      expect(JSON.stringify(rejected.value)).not.toContain("private-key");
      expect((await runtime.store.getConnection(project.id, connection.id))?.status).toBe(
        "unverified",
      );
      expect(calls.slice(callsBeforeVerify)).toEqual(["GET /api/api-keys/current"]);
      expect(creates).toBe(0);
    }

    credentialStatus = 200;

    for (const status of [401, 403]) {
      regionStatus = status;
      const callsBeforeVerify = calls.length;

      const rejected = await request(
        `/v1/projects/${project.id}/provider-connections/${connection.id}/verify`,
        "POST",
        {},
        token,
      );

      expect(rejected.response.status).toBe(401);
      expect(rejected.value).toEqual({
        error: {
          code: "UNAUTHENTICATED",
          message: "Provider credential rejected",
          effect: "none",
          retry: "never",
        },
      });
      expect(calls.slice(callsBeforeVerify)).toEqual([
        "GET /api/api-keys/current",
        "GET /api/regions",
      ]);
      expect(creates).toBe(0);
    }

    regionStatus = 200;

    const verified = await request(
      `/v1/projects/${project.id}/provider-connections/${connection.id}/verify`,
      "POST",
      {},
      token,
    );

    expect(verified.response.status).toBe(200);

    const verifiedScope = z
      .object({
        nativeScope: z.object({
          accountId: z.string(),
          adapterScope: z.object({ partition: z.object({ endpoint: z.string() }) }),
        }),
      })
      .parse(verified.value).nativeScope;

    expect(verifiedScope.accountId).toBe("organization:org-1");
    expect(verifiedScope.adapterScope.partition.endpoint).toBe("https://app.daytona.io/api");
    expect(verified.value).not.toHaveProperty("capabilities");

    limitedNetworkEgress = true;

    const restrictedVerification = await request(
      `/v1/projects/${project.id}/provider-connections/${connection.id}/verify`,
      "POST",
      {},
      token,
    );

    expect(restrictedVerification.response.status).toBe(200);
    expect(restrictedVerification.value).not.toHaveProperty("capabilities");
    const callsBeforeList = calls.length;

    const restrictedList = await request(
      `/v1/projects/${project.id}/provider-connections`,
      "GET",
      undefined,
      token,
    );

    expect(restrictedList.response.status).toBe(200);
    expect(calls).toHaveLength(callsBeforeList);
    expect(
      z.object({ items: z.array(z.object({ id: z.string() })) }).parse(restrictedList.value).items,
    ).toContainEqual(expect.objectContaining({ id: connection.id }));
    expect(JSON.stringify(restrictedList.value)).not.toContain('"create":true');
    limitedNetworkEgress = false;

    const rejectedKey = Bun.randomUUIDv7();

    const rejectedAdmission = await request(
      `/v1/projects/${project.id}/sandboxes`,
      "POST",
      { environment: { kind: "prepared", imageId: "snap-1" }, connectionId: connection.id },
      token,
      rejectedKey,
    );

    expect(rejectedAdmission.response.status).toBe(202);

    const rejectedOperationId = z
      .object({ operation: z.object({ id: z.string() }) })
      .parse(rejectedAdmission.value).operation.id;

    regionStatus = 401;
    await runtime.runner.tick();

    const rejectedOperation = await request(
      `/v1/projects/${project.id}/operations/${rejectedOperationId}`,
      "GET",
      undefined,
      token,
    );

    expect(rejectedOperation.value).toMatchObject({
      status: "failed",
      effect: "none",
      error: { code: "UNAUTHENTICATED", effect: "none", retry: "never" },
    });
    expect(creates).toBe(0);
    expect(snapshotReads).toBe(0);

    const repeatedRejected = await request(
      `/v1/projects/${project.id}/sandboxes`,
      "POST",
      { environment: { kind: "prepared", imageId: "snap-1" }, connectionId: connection.id },
      token,
      rejectedKey,
    );

    expect(repeatedRejected.response.status).toBe(202);
    expect(
      z.object({ operation: z.object({ id: z.string() }) }).parse(repeatedRejected.value).operation
        .id,
    ).toBe(rejectedOperationId);
    regionStatus = 200;

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
    expect(snapshotReads).toBe(1);

    createdState = "stopped";

    const stoppedAdmission = await request(
      `/v1/projects/${project.id}/sandboxes`,
      "POST",
      { environment: { kind: "prepared", imageId: "snap-1" }, connectionId: connection.id },
      token,
      Bun.randomUUIDv7(),
    );

    expect(stoppedAdmission.response.status).toBe(202);

    const stopped = z
      .object({ operation: z.object({ id: z.string(), sandboxId: z.string() }) })
      .parse(stoppedAdmission.value).operation;

    expect(await runtime.runner.tick()).toBe(true);
    expect((await runtime.store.getOperation(project.id, stopped.id))?.status).toBe("succeeded");
    const stoppedRow = await runtime.store.getSandbox(project.id, stopped.sandboxId);
    expect(stoppedRow?.native_id).toBe("native-2");
    expect(stoppedRow?.observed_state).toBe("unknown");
    expect(creates).toBe(2);
    expect(snapshotReads).toBe(2);

    const blockedExec = await request(
      `/v1/projects/${project.id}/sandboxes/${stopped.sandboxId}/executions`,
      "POST",
      { command: { kind: "shell", script: "true" } },
      token,
      Bun.randomUUIDv7(),
    );

    expect(blockedExec.response.status).toBe(409);

    for (const unavailable of ["draining", "missing scope"] as const) {
      const queued = await request(
        `/v1/projects/${project.id}/sandboxes`,
        "POST",
        { environment: { kind: "prepared", imageId: "snap-1" }, connectionId: connection.id },
        token,
        Bun.randomUUIDv7(),
      );

      expect(queued.response.status).toBe(202);

      const queuedId = z.object({ operation: z.object({ id: z.string() }) }).parse(queued.value)
        .operation.id;

      const control = new Database(join(directory, "control.sqlite"));

      try {
        if (unavailable === "draining")
          control
            .query("UPDATE provider_connections SET status='draining' WHERE id=?")
            .run(connection.id);
        else
          control.query("UPDATE provider_connections SET scope=NULL WHERE id=?").run(connection.id);
      } finally {
        control.close();
      }

      const before = calls.length;
      expect(await runtime.runner.tick()).toBe(true);
      expect(calls).toHaveLength(before);
      expect((await runtime.store.getOperation(project.id, queuedId))?.submission_possible).toBe(0);
      expect(creates).toBe(2);

      if (unavailable === "draining") {
        const control = new Database(join(directory, "control.sqlite"));

        try {
          control
            .query("UPDATE provider_connections SET status='verified' WHERE id=?")
            .run(connection.id);
        } finally {
          control.close();
        }
      }
    }

    const cleanup = await request(
      `/v1/projects/${project.id}/sandboxes/${stopped.sandboxId}`,
      "DELETE",
      undefined,
      token,
      Bun.randomUUIDv7(),
    );

    expect(cleanup.response.status).toBe(202);

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

test("Daytona service reconnects and observes lost exec, write and delete without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-daytona-recovery-"));
  const keyFile = join(directory, "key");
  const setupTokenFile = join(directory, "setup");
  const databaseUrl = join(directory, "control.sqlite");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-daytona-recovery-setup-token");
  await chmod(setupTokenFile, 0o600);
  const files = new Map<string, Uint8Array>();
  const mutations = { build: 0, create: 0, exec: 0, upload: 0, write: 0, destroy: 0 };
  let snapshotName = "";
  let state = "started";
  let name = "";
  let labels: Record<string, string> = {};

  const box = () => ({
    id: "native-1",
    name,
    organizationId: "org-1",
    target: "us",
    state,
    networkBlockAll: true,
    public: false,
    toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
    labels,
  });

  const fetchImpl = fixtureFetch(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;

    if (path === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

    if (path === "/api/regions")
      return Response.json([
        { id: "us", name: "US", regionType: "shared", organizationId: "org-1" },
      ]);

    if (path === "/api/organizations/org-1")
      return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

    if (path === "/api/snapshots/snap-1")
      return Response.json({
        id: "snap-1",
        organizationId: "org-1",
        state: "active",
        regionIds: ["us"],
        sandboxClass: "container",
      });

    if (path === "/api/snapshots" && init?.method === "POST") {
      mutations.build++;
      snapshotName = z.object({ name: z.string() }).parse(JSON.parse(String(init.body))).name;
      throw new Error("snapshot build response lost");
    }

    if (path.startsWith("/api/snapshots/"))
      return snapshotName &&
        [snapshotName, "built-1"].includes(decodeURIComponent(path.split("/").at(-1)!))
        ? Response.json({
            id: "built-1",
            name: snapshotName,
            imageName: "alpine:3.21",
            organizationId: "org-1",
            state: "active",
            regionIds: ["us"],
            sandboxClass: "container",
          })
        : new Response(null, { status: 404 });

    if (path === "/api/sandbox" && init?.method === "POST") {
      mutations.create++;
      const body = JSON.parse(String(init.body));
      name = body.name;
      labels = body.labels;

      return Response.json(box());
    }

    if (path === "/api/sandbox/native-1") {
      if (init?.method === "DELETE") {
        mutations.destroy++;
        state = "destroyed";
        throw new Error("Daytona delete response lost");
      }

      return Response.json(box());
    }

    if (path.endsWith("/files/upload-v2")) {
      mutations.upload++;
      const destination = url.searchParams.get("path")!;
      const form = init?.body;

      if (!(form instanceof FormData)) throw new Error("Expected multipart upload");
      const file = form.get("file");

      if (!(file instanceof Blob)) throw new Error("Expected uploaded Blob");
      files.set(destination, new Uint8Array(await file.arrayBuffer()));

      return Response.json({ path: destination, name: "blob", type: "file" });
    }

    if (path.endsWith("/files/download")) {
      const bytes = files.get(url.searchParams.get("path")!);

      return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
    }

    if (path.endsWith("/process/execute")) {
      const command = z
        .object({ command: z.string() })
        .parse(JSON.parse(String(init?.body))).command;

      if (command.startsWith("{ ")) {
        mutations.exec++;
        const receipt = /\}\s*>\s*'([^']+)'; cat/.exec(command)?.[1];
        expect(receipt).toBeDefined();
        files.set(
          receipt!,
          new TextEncoder().encode(
            "SANDBAR-EXEC-V1\n0\n2\n0\n 00 ff\nSANDBAR-STDERR\nSANDBAR-END\n",
          ),
        );
        throw new Error("Daytona exec response lost");
      }

      mutations.write++;
      const link = /^ln -T -- '([^']+)' '([^']+)'/.exec(command);
      expect(link).not.toBeNull();
      files.set(link![2]!, files.get(link![1]!)!);
      files.delete(link![1]!);
      const marker = /printf '%s' '([^']+)' > '([^']+)'/.exec(command);
      expect(marker).not.toBeNull();
      const publish = /mv -f -- '([^']+)' '([^']+)'/.exec(command);
      expect(publish?.[1]).toBe(marker![2]);
      files.set(publish![2]!, new TextEncoder().encode(marker![1]!));
      throw new Error("Daytona write response lost");
    }

    throw new Error(`Unexpected Daytona fixture route ${path}`);
  });

  const config = {
    databaseUrl,
    keyFile,
    setupTokenFile,
    startRunner: false,
    daytonaFetch: fetchImpl,
  };

  let runtime = await openDomainRuntime(config);
  let bearer = "";

  const request = async (path: string, method = "GET", body?: FixtureJson, key?: string) => {
    const headers: Record<string, string> = {};

    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    if (body !== undefined) headers["Content-Type"] = "application/json";

    if (key) headers["Idempotency-Key"] = key;

    const response = await runtime.app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return { status: response.status, value: await response.json() };
  };

  const id = (value: FixtureJson) =>
    z
      .object({ operation: z.object({ id: z.string(), sandboxId: z.string().optional() }) })
      .parse(value).operation;

  try {
    bearer = z
      .object({ token: z.string() })
      .parse(
        (await request("/v1/setup", "POST", { setupToken: "long-daytona-recovery-setup-token" }))
          .value,
      ).token;

    const projectId = z
      .object({ id: z.string() })
      .parse((await request("/v1/projects", "POST", { name: "Daytona recovery" })).value).id;

    const base = `/v1/projects/${projectId}`;

    const connectionId = z.object({ id: z.string() }).parse(
      (
        await request(`${base}/provider-connections`, "POST", {
          provider: "daytona",
          name: "Daytona fixture",
          credentials: { apiKey: "fixture-key" },
          configuration: { target: "us", ttlMinutes: 15 },
        })
      ).value,
    ).id;

    expect(
      (await request(`${base}/provider-connections/${connectionId}/verify`, "POST")).status,
    ).toBe(200);

    const client = Sandbar.connect({
      url: "http://127.0.0.1:12345",
      projectId,
      token: bearer,
      fetch: fixtureFetch(async (url, init) => runtime.app.request(String(url), init)),
    });

    const build = await client.images.submitBuild({
      source: Image.oci("alpine:3.21"),
      connectionId,
    });

    await runtime.runner.tick();
    expect(mutations.build).toBe(1);
    expect(mutations.create).toBe(0);
    expect(
      (await runtime.store.getOperation(projectId, build.reference.operationId!))?.status,
    ).toBe("running");
    await runtime.close();
    runtime = await openDomainRuntime(config);
    await request(`${base}/operations/${build.reference.operationId}/reconcile`, "POST", {});
    await runtime.runner.tick();

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
      .parse(await (await client.recover(build.reference)).wait());

    expect(built.prepared).toMatchObject({ value: "built-1", provider: "daytona", connectionId });
    expect(mutations.build).toBe(1);

    const create = await client.sandboxes.submitCreate({
      environment: Image.prepared(built.prepared),
      networkPolicy: "blocked",
    });

    await runtime.runner.tick();
    expect(
      (await runtime.store.getOperation(projectId, create.reference.operationId!))?.status,
    ).toBe("succeeded");
    const boxId = (await create.wait()).id;
    await client.close();

    const exec = id(
      (
        await request(
          `${base}/sandboxes/${boxId}/executions`,
          "POST",
          { command: { kind: "shell", script: "printf '\\000\\377'" } },
          Bun.randomUUIDv7(),
        )
      ).value,
    );

    await runtime.runner.tick();
    expect((await runtime.store.getOperation(projectId, exec.id))?.status).not.toBe("succeeded");
    await runtime.close();
    runtime = await openDomainRuntime(config);
    await request(`${base}/operations/${exec.id}/reconcile`, "POST", {});
    await runtime.runner.tick();
    expect((await runtime.store.getOperation(projectId, exec.id))?.status).toBe("succeeded");
    const data = new Uint8Array([0, 255]);

    const write = await runtime.app.request(`${base}/sandboxes/${boxId}/files?path=%2Fout`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${bearer}`, "Idempotency-Key": Bun.randomUUIDv7() },
      body: data,
    });

    expect(write.status).toBe(202);
    const writeId = id(await write.json()).id;
    await runtime.close();
    runtime = await openDomainRuntime(config);
    await request(`${base}/operations/${writeId}/reconcile`, "POST", {});
    await runtime.runner.tick();
    expect((await runtime.store.getOperation(projectId, writeId))?.status).toBe("succeeded");

    const destroy = id(
      (await request(`${base}/sandboxes/${boxId}`, "DELETE", undefined, Bun.randomUUIDv7())).value,
    );

    await runtime.runner.tick();
    await runtime.close();
    runtime = await openDomainRuntime(config);
    await request(`${base}/operations/${destroy.id}/reconcile`, "POST", {});
    await runtime.runner.tick();
    expect((await runtime.store.getOperation(projectId, destroy.id))?.status).toBe("succeeded");
    expect(mutations).toEqual({ build: 1, create: 1, exec: 1, upload: 1, write: 1, destroy: 1 });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stored Daytona endpoint trust removal terminates fresh work before provider I/O", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-daytona-trust-restart-"));
  const keyFile = join(directory, "key");
  const setupTokenFile = join(directory, "setup");
  const databaseUrl = join(directory, "control.sqlite");

  const pair = {
    apiUrl: "https://private.daytona.example/api",
    toolboxOrigin: "https://toolbox.private.daytona.example",
  };

  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "daytona-trust-restart-setup-token");
  await chmod(setupTokenFile, 0o600);

  const calls: string[] = [];

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    calls.push(pathname);

    if (pathname === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

    if (pathname === "/api/regions")
      return Response.json([
        { id: "us", name: "United States", regionType: "shared", organizationId: "org-1" },
      ]);

    throw new Error(`Unexpected provider request ${pathname}`);
  });

  let runtime = await openDomainRuntime({
    databaseUrl,
    keyFile,
    setupTokenFile,
    daytonaFetch: fetchImpl,
    daytonaTrustedEndpoints: [pair],
    startRunner: false,
  });

  const request = async (
    path: string,
    method: string,
    token?: string,
    body?: FixtureJson,
    key?: string,
  ) => {
    const headers: Record<string, string> = {};

    if (token) headers.Authorization = `Bearer ${token}`;

    if (key) headers["Idempotency-Key"] = key;

    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await runtime.app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return { status: response.status, value: await response.json() };
  };

  try {
    const setup = await request("/v1/setup", "POST", undefined, {
      setupToken: "daytona-trust-restart-setup-token",
    });

    const token = z.object({ token: z.string() }).parse(setup.value).token;
    const project = await request("/v1/projects", "POST", token, { name: "Trust restart" });

    const projectId = z.object({ id: z.string() }).parse(project.value).id;

    const connection = await request(
      `/v1/projects/${projectId}/provider-connections`,
      "POST",
      token,
      {
        provider: "daytona",
        name: "Previously trusted",
        credentials: { apiKey: "private-key" },
        configuration: { ...pair, target: "us" },
      },
    );

    const connectionId = z.object({ id: z.string() }).parse(connection.value).id;

    const verified = await request(
      `/v1/projects/${projectId}/provider-connections/${connectionId}/verify`,
      "POST",
      token,
      {},
    );

    expect(verified.status).toBe(200);
    expect(calls).toEqual(["/api/api-keys/current", "/api/regions", "/api/organizations/org-1"]);
    await runtime.close();
    runtime = await openDomainRuntime({
      databaseUrl,
      keyFile,
      setupTokenFile,
      daytonaFetch: fetchImpl,
      startRunner: false,
    });

    const key = Bun.randomUUIDv7();

    const body = {
      environment: { kind: "prepared", imageId: "snapshot-1" },
      connectionId,
    };

    const admitted = await request(`/v1/projects/${projectId}/sandboxes`, "POST", token, body, key);

    expect(admitted.status).toBe(202);

    const operationId = z.object({ operation: z.object({ id: z.string() }) }).parse(admitted.value)
      .operation.id;

    await runtime.runner.tick();

    const operation = await request(
      `/v1/projects/${projectId}/operations/${operationId}`,
      "GET",
      token,
    );

    expect(operation.value).toMatchObject({
      status: "failed",
      effect: "none",
      error: { code: "INVALID_ARGUMENT", effect: "none", retry: "never" },
    });
    expect(JSON.stringify(operation.value)).not.toContain("private-key");
    expect(calls).toEqual(["/api/api-keys/current", "/api/regions", "/api/organizations/org-1"]);

    const repeated = await request(`/v1/projects/${projectId}/sandboxes`, "POST", token, body, key);

    expect(repeated.status).toBe(202);
    expect(
      z.object({ operation: z.object({ id: z.string() }) }).parse(repeated.value).operation.id,
    ).toBe(operationId);

    const db = new Database(databaseUrl, { readonly: true });

    try {
      // SAFETY: This fixture's query selects only the reservation state column.
      const reservation = db
        .query("SELECT state FROM reservations WHERE operation_id = ?")
        .get(operationId) as { state: string } | null;

      expect(reservation?.state).toBe("released");
    } finally {
      db.close();
    }
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
