import { expect, test } from "bun:test";
import { z } from "zod";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox, Template } from "e2b";
import { adapterSuite } from "sandbar-adapter/testing";
import { Image, Sandbar } from "sandbar-sdk";
import {
  connectAdapter,
  observeOperation,
  prepareOperation,
  submitOperation,
  type Json,
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
    async verifyAuth() {},
    async verifyTeam(teamId) {
      if (!teamId.startsWith("team_")) throw new Error("unverified team");
    },
    async verifyTemplate(_teamId, templateId) {
      if (templateId !== "template_1") throw new Error("unverified template");

      return templateId;
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

test("GNU ln -T creates only an absent exact target and survives stage cleanup", async () => {
  const command = process.platform === "darwin" ? "gln" : "ln";
  const probe = Bun.spawnSync({ cmd: [command, "--version"], stdout: "pipe", stderr: "pipe" });

  if (probe.exitCode !== 0) throw new Error("E2B no-clobber fixture requires GNU ln");

  const root = await mkdtemp(join(tmpdir(), "sandbar-e2b-link-"));
  const stage = join(root, "stage");
  const directory = join(root, "directory");
  const directoryLink = join(root, "directory-link");
  const existing = join(root, "existing");
  const absent = join(root, "absent");

  try {
    await writeFile(stage, Uint8Array.of(0, 255));
    await mkdir(directory);
    await symlink(directory, directoryLink);
    await writeFile(existing, Uint8Array.of(42));

    for (const destination of [directory, directoryLink, existing]) {
      const attempt = Bun.spawnSync({
        cmd: [command, "-T", "--", stage, destination],
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(attempt.exitCode).not.toBe(0);
      expect(await readdir(directory)).toEqual([]);
    }

    expect(new Uint8Array(await readFile(existing))).toEqual(Uint8Array.of(42));

    const created = Bun.spawnSync({
      cmd: [command, "-T", "--", stage, absent],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(created.exitCode).toBe(0);
    await unlink(stage);
    expect(new Uint8Array(await readFile(absent))).toEqual(Uint8Array.of(0, 255));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("E2B exec and file operations preserve binary content and no-clobber intent", async () => {
  const binary = Uint8Array.from([0, 255, 129, 10]);
  const files = new Map<string, Uint8Array>();
  const scripts: string[] = [];
  let linkAnswer = "CREATED";

  const record: E2BRecord = {
    id: "sandbox_1",
    templateId: "template_1",
    metadata: {
      sandbar_scope: "team_one:template_1",
      sandbar_template: "template_1",
      sandbar_submission: "sub_seed",
      sandbar_operation: "op_seed",
    },
    state: "running",
  };

  const adapter = createE2BAdapter((): E2BTransport => ({
    async verifyAuth() {},
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      return id;
    },
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
    async verifyAuth() {},
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      return id;
    },
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
    async verifyAuth() {},
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      return id;
    },
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

    const buildIdentity = {
      operationId: "op_build_lost",
      submissionId: "sub_build_lost",
      invocationKey: "inv_build_lost",
    };

    const build = await prepareOperation(
      connection.session,
      "image_build",
      { source: { kind: "oci", value: "node:24" } },
      signal,
    );

    const buildResult = await submitOperation(build, buildIdentity, signal);
    expect(buildResult.kind).toBe("unknown");

    const observedBuild = await observeOperation(
      connection.session,
      "image_build",
      buildIdentity,
      signal,
    );

    expect(observedBuild).toMatchObject({
      kind: "completed",
      value: { preparedId: "retained_template" },
    });
    expect(creates).toBe(0);
  } finally {
    await connection.close();
  }
});

test("shared image build returns a scoped prepared handle for one native create", async () => {
  let builtName = "";
  let creates = 0;
  let record: E2BRecord | null = null;
  const createdRecords: E2BRecord[] = [];

  const adapter = createE2BAdapter((): E2BTransport => ({
    async verifyAuth() {},
    async verifyTeam() {},
    async verifyTemplate(_team, templateId) {
      if (!["template_1", "built_template"].includes(templateId))
        throw new Error("template outside team");

      return templateId;
    },
    async buildImage(_reference, name) {
      builtName = name;

      return { templateId: "built_template", buildId: "build_one" };
    },
    async findBuild(_team, name) {
      return name === builtName
        ? { templateId: "built_template", buildId: "build_one", status: "ready" }
        : null;
    },
    async create(input) {
      creates++;
      record = {
        id: `sandbox_${creates}`,
        templateId: input.templateId,
        metadata: input.metadata,
        state: "running",
      };
      createdRecords.push(record);

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

  const client = await Sandbar.connect({
    adapter,
    config: { teamId: "team_one", templateId: "template_1" },
    credentials: { apiKey: "secret" },
  });

  try {
    const built = await client.images.build({ source: Image.oci("node:24") });
    expect(built.prepared).toMatchObject({
      kind: "prepared",
      value: "built_template",
      provider: "e2b",
      scope: client.scope,
    });
    expect(built.retainedResources).toEqual([
      {
        kind: "e2b-template",
        id: "built_template",
        ownership: "unknown",
        cleanup: "manual",
      },
    ]);
    expect(creates).toBe(0);

    await expect(
      client.sandboxes.create({
        environment: Image.prepared({ ...built.prepared, provider: "another-provider" }),
      }),
    ).rejects.toThrow("scope differs");
    expect(creates).toBe(0);

    const box = await client.sandboxes.create({ environment: Image.prepared(built.prepared) });
    expect(box.id).toBe("sandbox_1");
    expect(createdRecords[0]?.templateId).toBe("built_template");
    await box.destroy();
    expect(creates).toBe(1);
  } finally {
    await client.close();
  }
});

test("SDK abort settles a stalled E2B build and late outcomes never create a sandbox", async () => {
  for (const late of ["resolve", "reject"] as const) {
    let started = false;
    let creates = 0;
    let finish!: () => void;
    let fail!: (error: Error) => void;

    const stalled = new Promise<{ templateId: string; buildId: string }>((resolve, reject) => {
      finish = () => resolve({ templateId: "built_template", buildId: "build_one" });
      fail = reject;
    });

    const adapter = createE2BAdapter((): E2BTransport => ({
      async verifyAuth() {},
      async verifyTeam() {},
      async verifyTemplate(_team, id) {
        return id;
      },
      async buildImage() {
        started = true;

        return stalled;
      },
      async findBuild() {
        return null;
      },
      async create() {
        creates++;

        return "unexpected";
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

    const client = await Sandbar.connect({
      adapter,
      config: { teamId: "team_one", templateId: "template_1" },
      credentials: { apiKey: "secret" },
    });

    const controller = new AbortController();

    try {
      const pending = client.sandboxes.submitCreate(
        { environment: Image.oci("node:24"), networkPolicy: "blocked" },
        { signal: controller.signal },
      );

      while (!started) await Bun.sleep(1);

      controller.abort("stop");
      await expect(
        Promise.race([
          pending,
          Bun.sleep(500).then(() => {
            throw new Error("E2B create did not stop waiting after abort");
          }),
        ]),
      ).rejects.toThrow();

      if (late === "resolve") finish();
      else fail(new Error("late build failure"));
      await Bun.sleep(1);
      expect(creates).toBe(0);
    } finally {
      await client.close();
    }
  }
});

test("SDK abort settles a stalled E2B exec after one native dispatch", async () => {
  let record: E2BRecord | null = null;
  let runs = 0;
  let reads = 0;
  let finish!: () => void;

  const stalled = new Promise<string>((resolve) => {
    finish = () => resolve("");
  });

  const adapter = createE2BAdapter((): E2BTransport => ({
    async verifyAuth() {},
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      return id;
    },
    async buildImage() {
      throw new Error("not used");
    },
    async findBuild() {
      return null;
    },
    async create(input) {
      record = {
        id: "sandbox_1",
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
      runs++;

      return stalled;
    },
    async read() {
      reads++;

      return { bytes: new Uint8Array(), truncated: false };
    },
    async write() {},
    async remove() {},
    close() {},
  }));

  const client = await Sandbar.connect({
    adapter,
    config: { teamId: "team_one", templateId: "template_1" },
    credentials: { apiKey: "secret" },
  });

  try {
    const box = await client.sandboxes.create({
      environment: Image.prepared("template_1"),
      networkPolicy: "blocked",
    });

    const controller = new AbortController();

    const pending = box.exec(
      { command: { kind: "argv", argv: ["printf", "test"] } },
      { signal: controller.signal },
    );

    while (!runs) await Bun.sleep(1);

    controller.abort("stop");
    await expect(
      Promise.race([
        pending,
        Bun.sleep(500).then(() => {
          throw new Error("E2B exec did not stop waiting after abort");
        }),
      ]),
    ).rejects.toThrow();

    finish();
    await Bun.sleep(1);
    expect(runs).toBe(1);
    expect(reads).toBe(0);
  } finally {
    await client.close();
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
      sandbar_submission: "sub_seed",
      sandbar_operation: "op_seed",
      sandbar_build: "sandbar-build",
    },
    state: "running",
    volumeMounts: [{ name: "kept-volume", path: "/data" }],
  };

  let writes = 0;
  let links = 0;
  let kills = 0;

  const adapter = createE2BAdapter((): E2BTransport => ({
    async verifyAuth() {},
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      return id;
    },
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
      { ...identity.sandbox, storage: "allow-unconfirmed" },
      signal,
    );

    let checkpoint: Json | undefined;
    let checkpointVersion: number | undefined;
    const result = await submitOperation(
      prepared,
      identity,
      signal,
      undefined,
      async (token, version) => {
        expect(kills).toBe(0);
        checkpoint = JSON.parse(JSON.stringify(token));
        checkpointVersion = version;
      },
    );
    expect(checkpoint).toEqual({
      stage: "uncertain",
      retainedTemplateId: "built_template",
      retainedVolumeNames: ["kept-volume"],
    });
    expect(result.kind).toBe("pending");

    if (result.kind !== "pending") throw new Error("missing destroy recovery token");

    await connection.close();
    connection = await connect();

    const observed = await observeOperation(
      connection.session,
      "destroy",
      { ...identity, token: checkpoint, version: checkpointVersion },
      signal,
    );

    expect(observed).toEqual({
      kind: "completed",
      value: {
        computeStopped: true,
        retainedResources: ["e2b-template:built_template", "e2b-volume-name:kept-volume"],
      },
    });
    expect(kills).toBe(1);
  } finally {
    await connection.close();
  }
});

test("pinned E2B forwards immutable build selector and blocked network policy in one create request", async () => {
  const requests: { path: string; body: unknown }[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() });

      return new Response("fixture rejection", { status: 429, headers: { "Retry-After": "0" } });
    },
  });

  const selector = "snapshot_raw:11111111-1111-4111-8111-111111111111";

  try {
    await expect(
      Sandbox.create(selector, {
        apiKey: "fixture-key",
        apiUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        requestTimeoutMs: 1000,
        allowInternetAccess: false,
      }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/v2/sandboxes",
      body: { templateID: selector, allow_internet_access: false },
    });
  } finally {
    server.stop(true);
  }
});

test("native unfiltered inventory omits the invalid empty metadata parameter", async () => {
  const original = globalThis.fetch;
  const requests: URL[] = [];
  // SAFETY: This deterministic fetch boundary matches Bun's fetch/preconnect shape and receives only fixture credentials.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(new URL(input instanceof Request ? input.url : String(input)));

      return Response.json([]);
    },
    { preconnect() {} },
  ) as typeof fetch;

  try {
    const transport = createSdkTransport("fixture-key");
    expect(await transport.list({}, 100)).toMatchObject({ items: [] });
    expect(requests[0]?.searchParams.has("metadata")).toBe(false);
    await transport.list({ owner: "fixture" }, 100);
    expect(requests[1]?.searchParams.get("metadata")).toBeTruthy();
  } finally {
    globalThis.fetch = original;
  }
});

for (const barrier of ["reject-before", "abort-before", "reject-after"] as const) {
  test(`destroy checkpoint ${barrier} preserves custody and never replays kill`, async () => {
    let kills = 0;
    let present = true;
    const record: E2BRecord = {
      id: "box",
      templateId: "built_template",
      state: "running",
      metadata: {
        sandbar_scope: "team_one:template_1",
        sandbar_build: "owned-build",
        sandbar_template: "built_template",
        sandbar_submission: "seed-sub",
        sandbar_operation: "seed-op",
      },
      volumeMounts: [{ name: "retained-name", path: "/data" }],
    };
    const adapter = createE2BAdapter(() => ({
      async verifyAuth() {},
      async verifyTeam() {},
      async verifyTemplate(_team, id) {
        return id;
      },
      async buildImage() {
        throw Error("unused");
      },
      async findBuild() {
        return null;
      },
      async create() {
        throw Error("unused");
      },
      async get() {
        return present ? record : null;
      },
      async list() {
        return { items: present ? [record] : [] };
      },
      async kill() {
        kills++;
        present = false;
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
    const connect = (apiKey: string) =>
      connectAdapter(adapter, {
        config: { teamId: "team_one", templateId: "template_1" },
        credentials: { apiKey },
      });
    let connection = await connect("first-key");
    const controller = new AbortController();
    const identity = {
      operationId: "destroy-op",
      submissionId: "destroy-sub",
      invocationKey: "destroy-inv",
      sandbox: { id: "box" },
    };
    let saved: Json | undefined;
    let version: number | undefined;
    try {
      const prepared = await prepareOperation(
        connection.session,
        "destroy",
        { ...identity.sandbox, storage: "allow-unconfirmed" },
        controller.signal,
      );
      const submitted = submitOperation(
        prepared,
        identity,
        controller.signal,
        undefined,
        async (token, tokenVersion) => {
          saved = JSON.parse(JSON.stringify(token));
          version = tokenVersion;
          const stage = z.object({ stage: z.string() }).parse(token).stage;
          expect(kills).toBe(stage === "accepted" ? 1 : 0);
          if (barrier === "abort-before") controller.abort();
          else if (
            (barrier === "reject-before" && stage === "uncertain") ||
            (barrier === "reject-after" && stage === "accepted")
          )
            throw Error("durable store unavailable");
        },
      );
      if (barrier === "abort-before") expect((await submitted).kind).toBe("unknown");
      else await expect(submitted).rejects.toThrow("reference persistence failed");
      expect(kills).toBe(barrier === "reject-after" ? 1 : 0);
      expect(saved).toMatchObject({
        retainedTemplateId: "built_template",
        retainedVolumeNames: ["retained-name"],
      });
      await connection.close();
      connection = await connect("rotated-key");
      const observed = await observeOperation(
        connection.session,
        "destroy",
        { ...identity, token: saved, version },
        new AbortController().signal,
      );
      if (barrier === "reject-after")
        expect(observed).toMatchObject({
          kind: "completed",
          value: {
            computeStopped: true,
            retainedResources: ["e2b-template:built_template", "e2b-volume-name:retained-name"],
          },
        });
      else expect(observed?.kind).toBe("pending");
      expect(kills).toBe(barrier === "reject-after" ? 1 : 0);
    } finally {
      await connection.close();
    }
  });
}
