import { expect, test } from "bun:test";
import {
  connectAdapter,
  observeOperation,
  prepareOperation,
  submitOperation,
} from "sandbar-adapter";
import { Sandbar, Image } from "sandbar-sdk";
import { e2b } from "sandbar-sdk/e2b";
import { createE2BAdapter } from "./index";
import { createSdkTransport, type E2BRecord, type E2BTransport } from "./transport";

function fixture() {
  const records = new Map<string, E2BRecord>();
  const calls = { auth: 0, team: 0, template: 0, create: 0, run: 0, write: 0, kill: 0 };
  let loseResponse = false;

  const adapter = createE2BAdapter((): E2BTransport => ({
    async verifyAuth() {
      calls.auth++;
    },
    async verifyTeam(team) {
      calls.team++;

      if (team !== "team_one") throw new Error("Wrong team");
    },
    async verifyTemplate(_team, selector) {
      calls.template++;

      if (!["my-template", "template_one"].includes(selector))
        throw new Error("Not owned and ready");

      return "template_one";
    },
    async buildImage() {
      throw new Error("Not used");
    },
    async findBuild() {
      return null;
    },
    async create(input) {
      calls.create++;

      const record: E2BRecord = {
        id: `sb_${calls.create}`,
        templateId: input.templateId === "base" ? "canonical_base" : input.templateId,
        metadata: input.metadata,
        allowPublicTraffic: input.allowPublicTraffic,
        state: "running",
      };

      records.set(record.id, record);

      if (loseResponse) throw new Error("Response lost after effect");

      return record.id;
    },
    async get(id) {
      return records.get(id) ?? null;
    },
    async list(metadata, limit) {
      return {
        items: [...records.values()]
          .filter((record) =>
            Object.entries(metadata).every(([key, value]) => record.metadata[key] === value),
          )
          .slice(0, limit),
      };
    },
    async kill(id) {
      calls.kill++;

      return records.delete(id);
    },
    async run() {
      calls.run++;
      throw new Error("Not used");
    },
    async read() {
      throw new Error("Not used");
    },
    async write() {
      calls.write++;
    },
    async remove() {},
    close() {},
  }));

  return {
    adapter,
    records,
    calls,
    loseNextResponse() {
      loseResponse = true;
    },
  };
}

test("API-key-only defaults reopen the same scope and bind canonical base resources", async () => {
  expect(e2b({ apiKey: "fixture" }).bound).toBe(true);
  const f = fixture();
  const options = { adapter: f.adapter, config: {}, credentials: { apiKey: "first-key" } };
  const client = await Sandbar.connect(options);
  expect(client.scope).toMatchObject({
    authority: { kind: "api-key" },
    partition: { template: "base" },
  });
  expect(client.scope.authority.id).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(client.scope)).not.toContain("first-key");
  expect(f.calls.template).toBe(0);
  expect(f.calls.create).toBe(0);
  const creation = await client.sandboxes.submitCreate({ environment: Image.prepared("base") });
  const box = await creation.wait();
  expect(f.records.get(box.id)?.templateId).toBe("canonical_base");
  const reference = creation.reference;
  await client.close();
  const reopened = await Sandbar.connect(options);
  const rotated = await Sandbar.connect({ ...options, credentials: { apiKey: "rotated-key" } });

  try {
    expect(reopened.scope).toEqual(client.scope);
    expect(rotated.scope).not.toEqual(client.scope);
    const recovered = await reopened.recover(reference);
    expect(await recovered.wait()).toMatchObject({ id: box.id });
    const before = { ...f.calls };
    await expect(rotated.recover(reference)).rejects.toThrow();
    await expect(
      rotated.sandboxes.create({
        environment: Image.prepared({
          kind: "prepared",
          value: "base",
          provider: "e2b",
          scope: client.scope,
        }),
      }),
    ).rejects.toThrow("scope differs");
    expect(f.calls).toEqual(before);
    f.records.clear();
    expect(f.calls.auth).toBeGreaterThan(0);
    expect(f.calls.team).toBe(0);
    expect(f.calls.create).toBe(1);
  } finally {
    await reopened.close();
    await rotated.close();
  }
});

test("lost base create recovers by exact native markers after reconnect without resolving aliases", async () => {
  const f = fixture();
  f.loseNextResponse();
  const options = { config: {}, credentials: { apiKey: "fixture-key" } };
  let connection = await connectAdapter(f.adapter, options);
  const signal = new AbortController().signal;
  const identity = { operationId: "op_one", submissionId: "sub_one", invocationKey: "inv_one" };

  try {
    const prepared = await prepareOperation(
      connection.session,
      "create",
      { image: { kind: "prepared", value: "base" }, networkPolicy: "blocked" },
      signal,
    );

    expect(f.calls.create).toBe(0);
    expect((await submitOperation(prepared, identity, signal)).kind).toBe("unknown");
    await connection.close();
    connection = await connectAdapter(f.adapter, options);
    const record = f.records.get("sb_1")!;
    record.metadata.sandbar_operation = "op_other";
    expect(
      await observeOperation(
        connection.session,
        "create",
        { ...identity, token: { allowPublicTraffic: false }, version: 1 },
        signal,
      ),
    ).toBeNull();
    record.metadata.sandbar_operation = identity.operationId;
    expect(
      await observeOperation(
        connection.session,
        "create",
        { ...identity, token: { allowPublicTraffic: false }, version: 1 },
        signal,
      ),
    ).toMatchObject({
      kind: "completed",
      value: { id: "sb_1", state: "running" },
    });
    expect(f.calls.create).toBe(1);
    expect(f.calls.template).toBe(0);
  } finally {
    await connection.close();
  }
});

test("owned aliases resolve to canonical IDs and explicit team scope survives key rotation", async () => {
  const f = fixture();

  const client = await Sandbar.connect({
    adapter: f.adapter,
    config: { templateId: "my-template" },
    credentials: { apiKey: "fixture" },
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("my-template") });
    expect(f.records.get(box.id)?.metadata.sandbar_template).toBe("template_one");
    await expect(
      client.sandboxes.create({ environment: Image.prepared("public-alias") }),
    ).rejects.toThrow();
    expect(f.calls.create).toBe(1);
    await box.destroy();
  } finally {
    await client.close();
  }

  const connect = (apiKey: string) =>
    Sandbar.connect({
      adapter: f.adapter,
      config: { teamId: "team_one" },
      credentials: { apiKey },
    });

  const first = await connect("first-key");
  const rotated = await connect("rotated-key");

  try {
    expect(first.scope).toEqual(rotated.scope);
    expect(first.scope.authority).toEqual({ kind: "team", id: "team_one" });
  } finally {
    await first.close();
    await rotated.close();
  }

  await expect(
    Sandbar.connect({
      adapter: f.adapter,
      config: { teamId: "api-key-id" },
      credentials: { apiKey: "fixture" },
    }),
  ).rejects.toThrow();
});

test("native API-key authentication validates bounded responses without team discovery", async () => {
  for (const [status, body, valid] of [
    [200, "[]", true],
    [401, "[]", false],
    [403, "[]", false],
    [200, "{}", false],
    [200, "x".repeat(1_048_577), false],
  ] as const) {
    const fetcher = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.e2b.app/v2/templates?limit=1");
        expect(init?.method ?? "GET").toBe("GET");
        expect(init?.headers).toMatchObject({ "X-API-Key": "fixture" });

        return new Response(body, { status });
      },
      { preconnect() {} },
    );

    const auth = createSdkTransport("fixture", fetcher).verifyAuth();

    if (valid) await auth;
    else await expect(auth).rejects.toThrow();
  }
});

test("native owned alias verification accepts only ready unambiguous default names", async () => {
  const ready = {
    templateID: "canonical",
    buildID: "build",
    buildStatus: "ready",
    names: ["team-slug/my-template:default", "team-slug/my-template:v1"],
  };

  let values = [ready];

  const fetcher = Object.assign(
    async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).searchParams.has("teamID")).toBe(false);

      return Response.json(values);
    },
    { preconnect() {} },
  );

  const transport = createSdkTransport("fixture", fetcher);

  for (const alias of ["canonical", "my-template", "my-template:default", "team-slug/my-template"])
    expect(await transport.verifyTemplate(undefined, alias)).toBe("canonical");
  await expect(transport.verifyTemplate(undefined, "my-template:v1")).rejects.toThrow();
  values = [{ ...ready, buildStatus: "building" }];
  await expect(transport.verifyTemplate(undefined, "my-template")).rejects.toThrow();
  values = [ready, { ...ready, templateID: "another" }];
  await expect(transport.verifyTemplate(undefined, "my-template")).rejects.toThrow("ambiguous");
});

test("sandbox references reopen fresh scoped connections without creation and distinguish paused state", async () => {
  const f = fixture();

  const connect = (key: string, templateId = "base") =>
    Sandbar.connect({
      adapter: f.adapter,
      config: { teamId: "team_one", templateId },
      credentials: { apiKey: key },
    });

  const first = await connect("old-key");
  const operation = await first.sandboxes.submitCreate({ environment: Image.prepared("base") });
  const box = await operation.wait();
  const saved = JSON.parse(JSON.stringify(box.reference));
  expect(saved).toMatchObject({ kind: "sandbox", provider: "e2b", nativeId: box.id });
  expect(saved.history).toBeUndefined();
  expect(JSON.stringify(saved)).not.toContain("old-key");
  await first.close();
  const fresh = await connect("rotated-key");

  try {
    const reopened = await fresh.sandboxes.get(saved);
    expect(reopened.id).toBe(box.id);
    expect((await reopened.inspect()).expires.status).toBe("unknown");
    const recovered = await fresh.recover(operation.reference);

    if (recovered.kind !== "create") throw new Error("Wrong operation kind");
    expect((await recovered.wait()).reference).toEqual(saved);
    const record = f.records.get(box.id)!;
    record.state = "paused";
    record.endAt = "2000-01-01T00:00:00Z";
    expect(await (await fresh.sandboxes.get(saved)).inspect()).toMatchObject({
      state: "suspended",
      nativeState: "paused",
      expires: { status: "none" },
      retention: { status: "known", value: { autoDeleteAfterStoppedSeconds: null } },
    });
    await expect(reopened.readFile("/tmp/value")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    record.state = "native-future-state";
    expect((await reopened.inspect()).state).toBe("unknown");
    record.state = "running";
    record.metadata.sandbar_operation = "different";

    for (const operation of [
      () => reopened.exec(["true"]),
      () => reopened.readFile("/tmp/value"),
      () => reopened.writeFile("/tmp/value", new Uint8Array([1])),
      () => reopened.destroy(),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.records.has(box.id)).toBe(true);
    await expect(fresh.sandboxes.get(saved)).rejects.toMatchObject({ code: "CONFLICT" });
    record.metadata.sandbar_operation = JSON.parse(saved.receipt).operation;

    for (const forged of [
      { ...saved, version: 2 },
      { ...saved, kind: "snapshot" },
      { ...saved, credentials: "secret" },
      { ...saved, service: { url: "https://service.invalid", projectId: "p", connectionId: "c" } },
    ])
      await expect(fresh.sandboxes.get(forged)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    for (const forged of [
      { ...saved, provider: "daytona" },
      { ...saved, scope: { ...saved.scope, authority: { kind: "team", id: "foreign" } } },
    ])
      await expect(fresh.sandboxes.get(forged)).rejects.toMatchObject({ code: "CONFLICT" });
    f.records.delete(box.id);
    await expect(reopened.inspect()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(fresh.sandboxes.get(saved)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.calls.create).toBe(1);
  } finally {
    await fresh.close();
  }
});

test("sandbox key-scoped references cannot rotate credentials or change template binding", async () => {
  const f = fixture();

  const first = await Sandbar.connect({
    adapter: f.adapter,
    config: {},
    credentials: { apiKey: "first-key" },
  });

  const box = await first.sandboxes.create({ environment: Image.prepared("base") });
  await first.close();

  for (const config of [{}, { templateId: "my-template" }]) {
    const fresh = await Sandbar.connect({
      adapter: f.adapter,
      config,
      credentials: { apiKey: "other-key" },
    });

    try {
      await expect(fresh.sandboxes.get(box.reference!)).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await fresh.close();
    }
  }
});

for (const kind of ["exec", "file_write", "destroy"] as const) {
  test(`E2B ${kind} rechecks markers after saving the submission reference`, async () => {
    const f = fixture();

    const client = await Sandbar.connect({
      adapter: f.adapter,
      config: { teamId: "team_one" },
      credentials: { apiKey: "fixture" },
      onReference(ref) {
        if (ref.kind === kind && (kind !== "destroy" || ref.token !== undefined))
          f.records.get(ref.sandboxId!)!.metadata.sandbar_operation = "changed";
      },
    });

    try {
      const created = await client.sandboxes.create({ environment: Image.prepared("base") });
      const box = await client.sandboxes.get(created.reference!);

      const dispatch = {
        exec: () => box.exec(["true"]),
        file_write: () => box.writeFile("/tmp/value", new Uint8Array([1])),
        destroy: () => box.destroy(),
      };

      await expect(dispatch[kind]()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(f.calls.run).toBe(0);
      expect(f.calls.write).toBe(0);
      expect(f.calls.kill).toBe(0);
    } finally {
      await client.close();
    }
  });
}
