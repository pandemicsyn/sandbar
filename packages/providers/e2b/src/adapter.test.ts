import { expect, test } from "bun:test";
import { Sandbox, Template } from "e2b";
import { adapterSuite } from "sandbar-adapter/testing";
import {
  connectAdapter,
  observeOperation,
  prepareOperation,
  submitOperation,
} from "sandbar-adapter";
import { createE2BAdapter } from "./index";
import {
  collectBounded,
  createSdkTransport,
  shellQuote,
  type E2BRecord,
  type E2BTransport,
} from "./transport";

test("E2B team and template verification is authenticated and scope-specific", async () => {
  const paths: string[] = [];

  // SAFETY: The loopback fixture implements the fetch call shape used by the E2B transport.
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      expect(init?.headers).toMatchObject({ "X-API-Key": "private-key" });

      if (url.pathname.includes("team_wrong")) return new Response(null, { status: 403 });

      if (url.pathname.endsWith("/metrics/max")) return Response.json({ value: 1 });

      return Response.json([
        {
          templateID: "template_1",
          buildID: "build_1",
          buildStatus: "ready",
          names: ["team-slug/sandbar-abc:default"],
        },
      ]);
    },
    { preconnect() {} },
  ) as typeof fetch;

  const transport = createSdkTransport("private-key", fetcher);
  await transport.verifyTeam("team_one");
  await transport.verifyTemplate("team_one", "template_1");
  expect(await transport.findBuild("team_one", "sandbar-abc")).toEqual({
    templateId: "template_1",
    buildId: "build_1",
    status: "ready",
  });
  await expect(transport.verifyTeam("team_wrong")).rejects.toThrow("403");
  expect(paths).toEqual([
    "/teams/team_one/metrics/max",
    "/v2/templates",
    "/v2/templates",
    "/teams/team_wrong/metrics/max",
  ]);
});

test("pinned E2B control-plane retries are disabled for a mutation", async () => {
  let attempts = 0;

  const server = Bun.serve({
    port: 0,
    fetch() {
      attempts++;

      return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
    },
  });

  try {
    await expect(
      Sandbox.create("template_1", {
        apiKey: "e2b_test_key",
        apiUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        requestTimeoutMs: 1000,
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("pinned E2B template build submission has one outbound attempt", async () => {
  let attempts = 0;

  const server = Bun.serve({
    port: 0,
    fetch() {
      attempts++;

      return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
    },
  });

  try {
    await expect(
      Template.build(Template().fromImage("node:24"), "sandbar-fixture", {
        apiKey: "e2b_test_key",
        apiUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        requestTimeoutMs: 1000,
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("E2B public adapter passes managed compute conformance at its native boundary", async () => {
  const records = new Map<string, E2BRecord>();
  let creates = 0;
  let destroys = 0;
  let releases = 0;
  let lose = false;
  let hold = false;
  let releaseHeld = () => {};

  const adapter = createE2BAdapter((): E2BTransport => ({
    async verifyTeam(teamId) {
      if (!teamId.startsWith("team_")) throw new Error("unverified team");
    },
    async verifyTemplate(_teamId, templateId) {
      if (templateId !== "template_1") throw new Error("unverified template");
    },
    async buildImage() {
      return { templateId: "template_1", buildId: "build_1" };
    },
    async findBuild() {
      return null;
    },
    async create(input) {
      creates++;
      const id = `sandbox_${creates}`;
      records.set(id, {
        id,
        templateId: input.templateId,
        metadata: input.metadata,
        state: "running",
      });

      if (lose) {
        lose = false;
        throw new Error("response lost after native effect");
      }

      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => {
          releaseHeld = resolve;
        });
      }

      return id;
    },
    async get(id) {
      return records.get(id) ?? null;
    },
    async list(metadata, limit) {
      const items = [...records.values()].filter((record) =>
        Object.entries(metadata).every(([key, value]) => record.metadata[key] === value),
      );

      return { items: items.slice(0, limit) };
    },
    async kill(id) {
      destroys++;

      return records.delete(id);
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
      releases++;
    },
  }));

  const report = await adapterSuite({
    adapter,
    fixture: {
      config: { teamId: "team_one", templateId: "template_1" },
      credentials: { apiKey: "secret_1" },
      alternate: {
        config: { teamId: "team_two", templateId: "template_1" },
        credentials: { apiKey: "secret_2" },
      },
      createInput: { image: { kind: "prepared", value: "template_1" }, networkPolicy: "blocked" },
      counters: () => ({ create: creates, destroy: destroys, release: releases }),
      loseNextCreateResponse: () => {
        lose = true;
      },
      holdNextCreateResponse: () => {
        hold = true;
      },
      releaseHeldCreateResponse: () => {
        releaseHeld();
      },
      assertNativeRetriesDisabled: () => {},
    },
  });

  expect(report.scenarios).toContain("lost response unknown and observation without replay");
  expect(creates).toBe(3);
});

test("shell quoting and bounded streams preserve binary bytes", async () => {
  expect(shellQuote("one'two")).toBe("'one'\\''two'");
  const bytes = Uint8Array.from([0, 255, 129, 10]);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  expect(await collectBounded(stream, 4)).toEqual({ bytes, truncated: false });

  const long = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  expect(await collectBounded(long, 2)).toEqual({ bytes: bytes.slice(0, 2), truncated: true });
});

test("E2B exec and file operations preserve binary content and no-clobber intent", async () => {
  const binary = Uint8Array.from([0, 255, 129, 10]);
  const files = new Map<string, Uint8Array>();
  const scripts: string[] = [];
  let linkAnswer = "CREATED";

  const record: E2BRecord = {
    id: "sandbox_1",
    templateId: "template_1",
    metadata: { sandbar_scope: "team_one:template_1", sandbar_template: "template_1" },
    state: "running",
  };

  const adapter = createE2BAdapter((): E2BTransport => ({
    async verifyTeam() {},
    async verifyTemplate() {},
    async buildImage() {
      return { templateId: "template_1", buildId: "build_1" };
    },
    async findBuild() {
      return null;
    },
    async create() {
      return record.id;
    },
    async get(id) {
      return id === record.id ? record : null;
    },
    async list() {
      return { items: [record] };
    },
    async kill() {
      return true;
    },
    async run(_id, script) {
      scripts.push(script);

      if (script.includes(".status")) {
        files.set("/tmp/.sandbar-sub_exec.stdout", binary);
        files.set("/tmp/.sandbar-sub_exec.stderr", Uint8Array.from([0, 254]));
        files.set("/tmp/.sandbar-sub_exec.status", new TextEncoder().encode("7"));
      }

      return script.includes("ln -T --") ? linkAnswer : "";
    },
    async read(_id, path, maxBytes) {
      const bytes = files.get(path);

      if (!bytes) throw new Error("missing file");

      return { bytes: bytes.slice(0, maxBytes), truncated: bytes.length > maxBytes };
    },
    async write(_id, path, bytes) {
      files.set(path, bytes);
    },
    async remove(_id, path) {
      files.delete(path);
    },
    close() {},
  }));

  const connection = await connectAdapter(adapter, {
    config: { teamId: "team_one", templateId: "template_1" },
    credentials: { apiKey: "secret" },
  });

  const signal = new AbortController().signal;

  try {
    const exec = await prepareOperation(
      connection.session,
      "exec",
      {
        sandbox: { id: record.id },
        command: { kind: "argv", argv: ["printf", "a'b", "$(touch /tmp/never)"] },
        cwd: "/tmp",
        env: { LANG: "C" },
        deadlineSeconds: 20,
        maxOutputBytes: 8,
      },
      signal,
    );

    const result = await submitOperation(
      exec,
      {
        operationId: "op_exec",
        submissionId: "sub_exec",
        invocationKey: "inv_exec",
      },
      signal,
    );

    expect(result.kind).toBe("completed");

    if (result.kind === "completed" && "stdout" in result.value) {
      expect(result.value.stdout).toEqual(binary);
      expect(result.value.stderr).toEqual(Uint8Array.from([0, 254]));
      expect(result.value.exitCode).toBe(7);
    }

    expect(scripts[0]).toContain("'$(touch /tmp/never)'");

    const write = await prepareOperation(
      connection.session,
      "file_write",
      {
        sandbox: { id: record.id },
        path: "/tmp/file.bin",
        bytes: binary,
        overwrite: false,
      },
      signal,
    );

    const written = await submitOperation(
      write,
      {
        operationId: "op_write",
        submissionId: "sub_write",
        invocationKey: "inv_write",
      },
      signal,
    );

    expect(written).toEqual({ kind: "completed", value: { bytesWritten: 4 } });
    expect(scripts[1]).toContain("ln -T --");
    expect(files.has("/tmp/.sandbar-write-sub_write")).toBe(false);

    files.set("/tmp/file.bin", Uint8Array.of(42));
    linkAnswer = "EXISTS";

    const conflict = await submitOperation(
      write,
      {
        operationId: "op_conflict",
        submissionId: "sub_conflict",
        invocationKey: "inv_conflict",
      },
      signal,
    );

    expect(conflict.kind).toBe("rejected");
    expect(files.get("/tmp/file.bin")).toEqual(Uint8Array.of(42));
    expect(files.has("/tmp/.sandbar-write-sub_conflict")).toBe(false);
  } finally {
    await connection.close();
  }
});

test("OCI create builds a correlated E2B template inside submit and reports it after destroy", async () => {
  let buildName = "";
  let creates = 0;
  let record: E2BRecord | null = null;

  const adapter = createE2BAdapter((): E2BTransport => ({
    async verifyTeam() {},
    async verifyTemplate() {},
    async buildImage(reference, name) {
      expect(reference).toBe("docker.io/library/node:24");
      buildName = name;

      return { templateId: "built_template", buildId: "build_one" };
    },
    async findBuild(_team, name) {
      return name === buildName
        ? { templateId: "built_template", buildId: "build_one", status: "ready" }
        : null;
    },
    async create(input) {
      creates++;
      expect(input.templateId).toBe("built_template");
      record = {
        id: "sandbox_oci",
        templateId: input.templateId,
        metadata: input.metadata,
        state: "running",
      };

      return record.id;
    },
    async get(id) {
      return record?.id === id ? record : null;
    },
    async list() {
      return { items: record ? [record] : [] };
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
    close() {},
  }));

  const connection = await connectAdapter(adapter, {
    config: { teamId: "team_one", templateId: "template_1" },
    credentials: { apiKey: "secret" },
  });

  const signal = new AbortController().signal;

  try {
    const prepared = await prepareOperation(
      connection.session,
      "create",
      {
        image: { kind: "oci", value: "docker.io/library/node:24" },
        networkPolicy: "blocked",
      },
      signal,
    );

    expect(buildName).toBe("");

    const result = await submitOperation(
      prepared,
      {
        operationId: "op_oci",
        submissionId: "sub_oci",
        invocationKey: "inv_oci",
      },
      signal,
    );

    expect(result).toEqual({ kind: "completed", value: { id: "sandbox_oci", state: "running" } });
    expect(buildName).toMatch(/^sandbar-[a-f0-9]{40}$/);
    expect(creates).toBe(1);

    const deletion = await prepareOperation(
      connection.session,
      "destroy",
      { id: "sandbox_oci" },
      signal,
    );

    const destroyed = await submitOperation(
      deletion,
      {
        operationId: "op_destroy",
        submissionId: "sub_destroy",
        invocationKey: "inv_destroy",
      },
      signal,
    );

    expect(destroyed).toEqual({
      kind: "completed",
      value: { computeStopped: true, retainedResources: ["e2b-template:built_template"] },
    });
  } finally {
    await connection.close();
  }
});

test("lost OCI build response observes the retained template without submitting a sandbox", async () => {
  let builtName = "";
  let creates = 0;

  const adapter = createE2BAdapter((): E2BTransport => ({
    async verifyTeam() {},
    async verifyTemplate() {},
    async buildImage(_reference, name) {
      builtName = name;
      throw new Error("build response lost");
    },
    async findBuild(_team, name) {
      return name === builtName
        ? { templateId: "retained_template", buildId: "build_one", status: "ready" }
        : null;
    },
    async create() {
      creates++;

      return "should_not_create";
    },
    async get() {
      return null;
    },
    async list() {
      return { items: [] };
    },
    async kill() {
      return false;
    },
    async run() {
      return "";
    },
    async read() {
      return { bytes: new Uint8Array(), truncated: false };
    },
    async write() {},
    async remove() {},
    close() {},
  }));

  const connection = await connectAdapter(adapter, {
    config: { teamId: "team_one", templateId: "template_1" },
    credentials: { apiKey: "secret" },
  });

  const signal = new AbortController().signal;

  try {
    const prepared = await prepareOperation(
      connection.session,
      "create",
      {
        image: { kind: "oci", value: "node:24" },
        networkPolicy: "blocked",
      },
      signal,
    );

    const identity = {
      operationId: "op_lost",
      submissionId: "sub_lost",
      invocationKey: "inv_lost",
    };

    const result = await submitOperation(prepared, identity, signal);
    expect(result.kind).toBe("unknown");
    const observed = await observeOperation(connection.session, "create", identity, signal);
    expect(observed?.kind).toBe("unknown");
    expect(JSON.stringify(observed)).toContain("retained_template");
    expect(creates).toBe(0);
  } finally {
    await connection.close();
  }
});

test("uncertain writes and destroy reconcile after reconnect without replay", async () => {
  const files = new Map<string, Uint8Array>();
  const bytes = Uint8Array.of(0, 255, 42);

  let record: E2BRecord | null = {
    id: "sandbox_1",
    templateId: "built_template",
    metadata: {
      sandbar_scope: "team_one:template_1",
      sandbar_template: "built_template",
      sandbar_build: "sandbar-build",
    },
    state: "running",
  };

  let writes = 0;
  let links = 0;
  let kills = 0;

  const adapter = createE2BAdapter((): E2BTransport => ({
    async verifyTeam() {},
    async verifyTemplate() {},
    async buildImage() {
      throw new Error("not used");
    },
    async findBuild() {
      return null;
    },
    async create() {
      throw new Error("not used");
    },
    async get(id) {
      return record?.id === id ? record : null;
    },
    async list() {
      return { items: record ? [record] : [] };
    },
    async kill() {
      kills++;
      record = null;
      throw new Error("kill response lost after effect");
    },
    async run(_id, script) {
      if (script.includes("ln -T --")) {
        links++;
        files.set("/tmp/no.bin", files.get("/tmp/.sandbar-write-sub_no")!);
        throw new Error("link response lost after effect");
      }

      if (script.includes(" -ef "))
        return files.get("/tmp/no.bin") === files.get("/tmp/.sandbar-write-sub_no")
          ? "SAME"
          : "DIFFERENT";

      throw new Error("unexpected command");
    },
    async read(_id, path, maxBytes) {
      const value = files.get(path);

      if (!value) throw new Error("file absent");

      return { bytes: value.slice(0, maxBytes), truncated: value.length > maxBytes };
    },
    async write(_id, path, value) {
      writes++;
      files.set(path, value);

      if (path === "/tmp/overwrite.bin") throw new Error("write response lost after effect");
    },
    async remove(_id, path) {
      files.delete(path);
    },
    close() {},
  }));

  const connect = () =>
    connectAdapter(adapter, {
      config: { teamId: "team_one", templateId: "template_1" },
      credentials: { apiKey: "secret" },
    });

  const signal = new AbortController().signal;
  let connection = await connect();

  try {
    for (const [path, overwrite, submissionId] of [
      ["/tmp/overwrite.bin", true, "sub_overwrite"],
      ["/tmp/no.bin", false, "sub_no"],
    ] as const) {
      const identity = {
        operationId: `op_${submissionId}`,
        submissionId,
        invocationKey: `inv_${submissionId}`,
        sandbox: { id: "sandbox_1" },
      };

      const prepared = await prepareOperation(
        connection.session,
        "file_write",
        { sandbox: identity.sandbox, path, bytes, overwrite },
        signal,
      );

      const result = await submitOperation(prepared, identity, signal);
      expect(result.kind).toBe("pending");

      if (result.kind !== "pending") throw new Error("missing recovery token");

      await connection.close();
      connection = await connect();

      const observed = await observeOperation(
        connection.session,
        "file_write",
        { ...identity, token: result.token, version: result.version },
        signal,
      );

      expect(observed).toEqual({ kind: "completed", value: { bytesWritten: bytes.length } });
    }

    expect(writes).toBe(2);
    expect(links).toBe(1);
    expect(files.has("/tmp/.sandbar-write-sub_no")).toBe(true);

    const identity = {
      operationId: "op_destroy",
      submissionId: "sub_destroy",
      invocationKey: "inv_destroy",
      sandbox: { id: "sandbox_1" },
    };

    const prepared = await prepareOperation(
      connection.session,
      "destroy",
      identity.sandbox,
      signal,
    );

    const result = await submitOperation(prepared, identity, signal);
    expect(result.kind).toBe("pending");

    if (result.kind !== "pending") throw new Error("missing destroy recovery token");

    await connection.close();
    connection = await connect();

    const observed = await observeOperation(
      connection.session,
      "destroy",
      { ...identity, token: result.token, version: result.version },
      signal,
    );

    expect(observed).toEqual({
      kind: "completed",
      value: { computeStopped: true, retainedResources: ["e2b-template:built_template"] },
    });
    expect(kills).toBe(1);
  } finally {
    await connection.close();
  }
});
