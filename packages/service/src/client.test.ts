import { expect, test } from "bun:test";
import { Sandbar as RemoteSandbar, Image as RemoteImage } from "./client";
import { OutcomeUnknownError, WaitAbortedError, SandbarError, NoExitCodeError } from "sandbar-sdk";
import type { RecoveryReference } from "sandbar-sdk";
import * as packagedRoot from "sandbar-sdk";
import * as packagedDirect from "sandbar-sdk";
import * as packagedRemote from "sandbar-service/client";

test("packaged SDK entry points share error class identity", () => {
  expect(packagedRoot.SandbarError).toBe(packagedDirect.SandbarError);
  expect(packagedRoot.SandbarError).toBe(packagedRemote.SandbarError);
  expect(packagedRoot.OutcomeUnknownError).toBe(packagedDirect.OutcomeUnknownError);
  expect(packagedRoot.OutcomeUnknownError).toBe(packagedRemote.OutcomeUnknownError);
});

test("remote image build recovers a lost admission and binds its prepared result to create", async () => {
  const base = {
    projectId: "project_1",
    status: "succeeded",
    phase: "completed",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "applied",
    recovery: [],
  };

  const scope = { authority: { kind: "team", id: `team:${"a".repeat(507)}` }, partition: {} };
  const templateId = `template:${"t".repeat(503)}`;

  const build = {
    ...base,
    id: "op_build",
    kind: "image_build",
    result: {
      kind: "image_build",
      prepared: {
        kind: "prepared",
        value: templateId,
        provider: "e2b",
        scope,
        connectionId: "conn_1",
      },
      retainedResources: [
        { kind: "template", id: templateId, ownership: "unknown", cleanup: "manual" },
      ],
    },
  };

  const create = {
    ...base,
    id: "op_create",
    kind: "create",
    sandboxId: "box_1",
    result: { kind: "create", sandboxId: "box_1" },
  };

  let buildPosts = 0;
  let createBody: unknown;

  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (path.endsWith("/images/builds") && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toMatchObject({ connectionId: "conn_1" });
      buildPosts++;
      throw new TypeError("admission response lost");
    }

    if (path.endsWith("/sandboxes") && init?.method === "POST") {
      createBody = JSON.parse(String(init.body));

      return Response.json({ operation: create }, { status: 202 });
    }

    if (path.includes("/invocations/")) return Response.json(build);

    if (path.endsWith("/operations/op_build")) return Response.json(build);

    throw new Error(`Unexpected path: ${path}`);
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId: "project_1",
    fetch: fetcher,
  });

  const result = await client.images.build({
    source: RemoteImage.oci("registry.example/image:1"),
    connectionId: "conn_1",
  });

  expect(buildPosts).toBe(1);
  expect(result.prepared).toEqual(build.result.prepared);
  expect(result.retainedResources).toEqual(build.result.retainedResources);

  await client.sandboxes.submitCreate({ environment: RemoteImage.prepared(result.prepared) });
  expect(createBody).toMatchObject({
    environment: { kind: "prepared", imageId: templateId },
    connectionId: "conn_1",
    preparedBinding: { provider: "e2b", scope, connectionId: "conn_1" },
  });
});

test("remote lost acceptance is resolved by invocation lookup under one key", async () => {
  let posts = 0;
  let key = "";
  const projectId = "project_1";

  const base = {
    id: "op_1",
    projectId,
    kind: "create",
    sandboxId: "box_1",
    status: "succeeded",
    phase: "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "applied",
    recovery: [],
    result: { kind: "create", sandboxId: "box_1" },
  };

  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (init?.method === "POST") {
      posts++;
      key = new Headers(init.headers).get("Idempotency-Key") ?? "";
      throw new TypeError("response lost");
    }

    if (path.includes("/invocations/")) return Response.json(base);

    if (path.includes("/operations/")) return Response.json(base);

    if (path.includes("/sandboxes/box_1"))
      return Response.json({
        id: "box_1",
        projectId,
        connectionId: "conn_1",
        desiredState: "running",
        observedState: "running",
        revision: 1,
        environment: { kind: "prepared", imageId: "fake-starter" },
        network: { policy: "blocked" },
        labels: {},
      });
    throw new Error(`Unexpected path: ${path}`);
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  await expect(client.sandboxes.submitCreate(JSON.parse("{}"))).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });

  for (const invalid of [
    { environment: RemoteImage.prepared("x".repeat(513)) },
    { environment: RemoteImage.oci("x".repeat(1025)) },
    { environment: RemoteImage.prepared("fake-starter"), labels: { long: "x".repeat(257) } },
  ]) {
    await expect(client.sandboxes.submitCreate(invalid)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      effect: "none",
    });
  }

  expect(posts).toBe(0);

  const operation = await client.sandboxes.submitCreate({
    environment: RemoteImage.prepared("fake-starter"),
  });

  const box = await operation.wait();
  expect(box.id).toBe("box_1");
  const preAborted = new AbortController();
  preAborted.abort(new Error("cancel before submission"));
  await expect(
    box.submitExec(
      { command: { kind: "argv", argv: ["fixture", "binary"] } },
      { signal: preAborted.signal },
    ),
  ).rejects.toBe(preAborted.signal.reason);
  await expect(
    client.sandboxes.submitCreate(
      { environment: RemoteImage.prepared("fake-starter") },
      { signal: preAborted.signal },
    ),
  ).rejects.toBe(preAborted.signal.reason);

  for (const invalid of [
    [],
    ["echo", 42],
    ["echo", "x".repeat(8193)],
    Array.from({ length: 129 }, () => "arg"),
    { command: { kind: "argv", argv: [] } },
    { command: { kind: "argv", argv: ["echo"] }, env: { "BAD=KEY": "value" } },
    { command: { kind: "argv", argv: ["echo"] }, deadlineSeconds: 0 },
  ]) {
    await expect(box.submitExec(JSON.parse(JSON.stringify(invalid)))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      effect: "none",
    });
  }

  // Simulate a deserialized JavaScript call with a missing execution request.
  const missingExecInput = JSON.parse("null") ?? undefined;

  await expect(box.submitExec(missingExecInput)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    effect: "none",
  });

  await expect(box.readFile("/a/./b")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(box.writeFile("/too-large", new Uint8Array(1_048_577))).rejects.toMatchObject({
    code: "OUTPUT_CAPACITY",
  });
  expect(posts).toBe(1);
  expect(operation.reference.invocationKey).toBe(key);
  expect(JSON.stringify(operation.reference)).not.toContain("secret");
  await expect(
    client.recover({ ...operation.reference, operationId: "op_other" }),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  await expect(
    RemoteSandbar.connect({
      url: "https://other.example/",
      token: "secret",
      projectId,
      fetch: fetcher,
    }).recover(operation.reference),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const imported = structuredClone(operation.reference);
  const recovered = await client.recover(imported);
  imported.service!.projectId = "other";

  try {
    recovered.reference.service!.projectId = "other";
  } catch {
    /* frozen references reject caller mutation */
  }

  expect(await recovered.wait()).toMatchObject({ id: "box_1" });
  expect(recovered.reference.service?.projectId).toBe(projectId);
  const malformed = structuredClone(operation.reference);
  Object.assign(malformed.service!, { secret: "hidden" });
  await expect(client.recover(malformed)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

test("remote recovery accepts equivalent service URLs with or without trailing slash", async () => {
  const projectId = "project_1";

  const operation = {
    id: "op_1",
    projectId,
    kind: "create",
    status: "queued",
    phase: "queued",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "none",
    recovery: [],
  };

  const paths: string[] = [];
  let posts = 0;

  const fetcher: typeof fetch = async (url, init) => {
    paths.push(new URL(String(url)).pathname);

    if (init?.method === "POST") {
      posts++;

      return Response.json({ operation }, { status: 202 });
    }

    return Response.json(operation);
  };

  const original = RemoteSandbar.connect({
    url: "https://sandbar.example/api",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const submitted = await original.sandboxes.submitCreate({
    environment: RemoteImage.prepared("fake-starter"),
  });

  expect(submitted.reference.service?.url).toBe("https://sandbar.example/api/");

  const restarted = RemoteSandbar.connect({
    url: "https://sandbar.example/api/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const recovered = await restarted.recover(submitted.reference);

  expect(recovered.reference.service?.url).toBe("https://sandbar.example/api/");

  const differentBase = RemoteSandbar.connect({
    url: "https://sandbar.example/other/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  await expect(differentBase.recover(submitted.reference)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });

  expect(posts).toBe(1);

  expect(paths).toEqual([
    "/api/v1/projects/project_1/sandboxes",
    "/api/v1/projects/project_1/invocations/" + submitted.reference.invocationKey,
  ]);
});

test("remote reads map malformed successful JSON to a public response error", async () => {
  const projectId = "project_1";

  const operation = {
    id: "op_1",
    projectId,
    kind: "create",
    sandboxId: "box_1",
    status: "succeeded",
    phase: "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "applied",
    recovery: [],
    result: { kind: "create", sandboxId: "box_1" },
  };

  let malformedSandbox = false;
  let malformedLookup = false;

  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (init?.method === "POST") return Response.json({ operation }, { status: 202 });

    if (path.includes("/invocations/"))
      return malformedLookup ? new Response("{", { status: 200 }) : Response.json(operation);

    if (path.endsWith("/sandboxes/box_1"))
      return malformedSandbox
        ? new Response("{", { status: 200 })
        : Response.json({
            id: "box_1",
            projectId,
            connectionId: "conn_1",
            desiredState: "running",
            observedState: "running",
            revision: 1,
            environment: { kind: "prepared", imageId: "fake-starter" },
            network: { policy: "blocked" },
            labels: {},
          });

    throw new Error(`Unexpected path: ${path}`);
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const submitted = await client.sandboxes.submitCreate({
    environment: RemoteImage.prepared("fake-starter"),
  });

  const box = await submitted.wait();
  malformedSandbox = true;
  await expect(box.inspect()).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
    effect: "unknown",
  });

  malformedSandbox = false;
  malformedLookup = true;
  await expect(client.recover(submitted.reference)).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
    effect: "unknown",
  });
});

test("remote ambiguous mutation response cancels its body before invocation lookup", async () => {
  const projectId = "project_1";

  const operation = {
    id: "op_1",
    projectId,
    kind: "create",
    status: "queued",
    phase: "queued",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "none",
    recovery: [],
  };

  let cancelled = 0;
  let lookupAfterCancel = false;
  let posts = 0;
  let lookups = 0;

  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === "POST") {
      posts++;

      return new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { status: 503 },
      );
    }

    lookups++;
    lookupAfterCancel = cancelled === 1;

    return Response.json(operation);
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  await client.sandboxes.submitCreate({ environment: RemoteImage.prepared("fake-starter") });
  expect(cancelled).toBe(1);
  expect(lookupAfterCancel).toBe(true);
  expect(posts).toBe(1);
  expect(lookups).toBe(1);
});

test("remote create carries its recovery reference through post-admission read failures", async () => {
  for (const failure of ["poll", "sandbox"] as const) {
    const projectId = "project_1";

    const operation = {
      id: "op_1",
      projectId,
      kind: "create",
      sandboxId: "box_1",
      status: "succeeded",
      phase: "done",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      effect: "applied",
      recovery: [],
      result: { kind: "create", sandboxId: "box_1" },
    };

    const box = {
      id: "box_1",
      projectId,
      connectionId: "conn_1",
      desiredState: "running",
      observedState: "running",
      revision: 1,
      environment: { kind: "prepared", imageId: "fake-starter" },
      network: { policy: "blocked" },
      labels: {},
    };

    let posts = 0;
    let failOnce = true;

    const fetcher: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;

      if (init?.method === "POST") {
        posts++;

        return Response.json({ operation }, { status: 202 });
      }

      if (path.includes("/invocations/")) {
        if (failure === "poll" && failOnce) {
          failOnce = false;
          throw new TypeError("poll disconnected");
        }

        return Response.json(operation);
      }

      if (path.endsWith("/sandboxes/box_1")) {
        if (failure === "sandbox" && failOnce) {
          failOnce = false;
          throw new TypeError("sandbox read disconnected");
        }

        return Response.json(box);
      }

      throw new Error(`Unexpected path: ${path}`);
    };

    const client = RemoteSandbar.connect({
      url: "https://sandbar.example/",
      token: "secret",
      projectId,
      fetch: fetcher,
    });

    let reference: OutcomeUnknownError["reference"] | undefined;

    try {
      await client.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") });
    } catch (error) {
      if (!(error instanceof OutcomeUnknownError)) throw error;
      reference = error.reference;
    }

    expect(reference?.operationId).toBe("op_1");
    const recovered = await client.recover(reference!);
    expect(await recovered.wait()).toMatchObject({ id: "box_1" });
    expect(posts).toBe(1);
  }
});

test("remote exec carries its recovery reference through a failed execution read", async () => {
  const projectId = "project_1";

  const common = {
    projectId,
    status: "succeeded",
    phase: "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "applied",
    recovery: [],
  };

  const createOperation = {
    ...common,
    id: "op_create",
    kind: "create",
    sandboxId: "box_1",
    result: { kind: "create", sandboxId: "box_1" },
  };

  const execOperation = {
    ...common,
    id: "op_exec",
    kind: "exec",
    sandboxId: "box_1",
    executionId: "exec_1",
    result: { kind: "exec", executionId: "exec_1" },
  };

  const execution = {
    id: "exec_1",
    projectId,
    sandboxId: "box_1",
    operationId: "op_exec",
    status: "completed",
    exitCode: 0,
    outputAvailability: "captured",
    capturedBytes: 0,
    stdoutBase64: "",
    stderrBase64: "",
  };

  let creates = 0,
    execs = 0,
    failRead = true;

  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    const path = target.pathname;

    if (init?.method === "POST" && path.endsWith("/sandboxes")) {
      creates++;

      return Response.json({ operation: createOperation }, { status: 202 });
    }

    if (init?.method === "POST" && path.endsWith("/executions")) {
      execs++;

      return Response.json({ operation: execOperation, execution }, { status: 202 });
    }

    if (path.includes("/invocations/"))
      return Response.json(
        target.searchParams.get("kind") === "exec" ? execOperation : createOperation,
      );

    if (path.endsWith("/sandboxes/box_1"))
      return Response.json({
        id: "box_1",
        projectId,
        connectionId: "conn_1",
        desiredState: "running",
        observedState: "running",
        revision: 1,
        environment: { kind: "prepared", imageId: "fake-starter" },
        network: { policy: "blocked" },
        labels: {},
      });

    if (path.endsWith("/executions/exec_1")) {
      if (failRead) {
        failRead = false;
        throw new TypeError("execution read disconnected");
      }

      return Response.json(execution);
    }

    throw new Error(`Unexpected path: ${path}`);
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const box = await client.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") });
  let reference: OutcomeUnknownError["reference"] | undefined;

  try {
    await box.exec({ command: { kind: "argv", argv: ["echo", "ok"] } });
  } catch (error) {
    if (!(error instanceof OutcomeUnknownError)) throw error;
    reference = error.reference;
  }

  expect(reference?.operationId).toBe("op_exec");
  const recovered = await client.recover(reference!);
  expect(await recovered.wait()).toMatchObject({ exitCode: 0 });
  expect(creates).toBe(1);
  expect(execs).toBe(1);
});

test("remote exec uses the submitted output limit after caller input changes", async () => {
  const projectId = "project_1";

  const common = {
    projectId,
    status: "succeeded",
    phase: "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "applied",
    recovery: [],
  };

  const createOperation = {
    ...common,
    id: "op_create",
    kind: "create",
    sandboxId: "box_1",
    result: { kind: "create", sandboxId: "box_1" },
  };

  const execOperation = {
    ...common,
    id: "op_exec",
    kind: "exec",
    sandboxId: "box_1",
    executionId: "exec_1",
    result: { kind: "exec", executionId: "exec_1" },
  };

  const execution = {
    id: "exec_1",
    projectId,
    sandboxId: "box_1",
    operationId: "op_exec",
    status: "completed",
    exitCode: 0,
    outputAvailability: "captured",
    capturedBytes: 4,
    stdoutBase64: "YWI=",
    stderrBase64: "Y2Q=",
  };

  let execDispatches = 0;
  const submittedBodies: string[] = [];

  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    const path = target.pathname;

    if (init?.method === "POST" && path.endsWith("/sandboxes"))
      return Response.json({ operation: createOperation }, { status: 202 });

    if (init?.method === "POST" && path.endsWith("/executions")) {
      execDispatches++;
      submittedBodies.push(String(init.body));

      return Response.json({ operation: execOperation, execution }, { status: 202 });
    }

    if (path.includes("/invocations/"))
      return Response.json(
        target.searchParams.get("kind") === "exec" ? execOperation : createOperation,
      );

    if (path.endsWith("/sandboxes/box_1"))
      return Response.json({
        id: "box_1",
        projectId,
        connectionId: "conn_1",
        desiredState: "running",
        observedState: "running",
        revision: 1,
        environment: { kind: "prepared", imageId: "fake-starter" },
        network: { policy: "blocked" },
        labels: {},
      });

    if (path.endsWith("/executions/exec_1")) return Response.json(execution);

    throw new Error(`Unexpected path: ${path}`);
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const box = await client.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") });

  const input = { command: { kind: "argv" as const, argv: ["echo", "ok"] }, maxOutputBytes: 4 };

  const operation = await box.submitExec(input);

  input.maxOutputBytes = 1;

  await expect(operation.wait()).resolves.toMatchObject({
    stdout: Uint8Array.of(97, 98),
    stderr: Uint8Array.of(99, 100),
  });

  expect(execDispatches).toBe(1);

  const tooSmall = { command: input.command, maxOutputBytes: 3 };

  const oversized = await box.submitExec(tooSmall);

  tooSmall.maxOutputBytes = 10;

  await expect(oversized.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);

  expect(execDispatches).toBe(2);
  const argv = ["echo", "$HOME", "a b", "; echo nope", ""];
  const expected = [...argv];
  const submission = box.submitExec(argv);
  argv[1] = "changed";
  const shorthand = await submission;
  expect((await shorthand.wait()).stdout).toEqual(Uint8Array.of(97, 98));
  const readonlyArgv = ["echo", "ok"] as const;
  expect((await box.exec(readonlyArgv)).exitCode).toBe(0);
  expect(submittedBodies.slice(2).map((body) => JSON.parse(body))).toEqual([
    {
      command: { kind: "argv", argv: expected },
      deadlineSeconds: 300,
      output: { capture: "bounded", maxBytes: 1_048_576 },
    },
    {
      command: { kind: "argv", argv: ["echo", "ok"] },
      deadlineSeconds: 300,
      output: { capture: "bounded", maxBytes: 1_048_576 },
    },
  ]);
  expect(execDispatches).toBe(4);
  await client.close();
});

test("remote create rejects disagreement between operation and result sandbox IDs", async () => {
  const projectId = "project_1";

  const mismatched = {
    id: "op_1",
    projectId,
    kind: "create",
    sandboxId: "box_other",
    status: "succeeded",
    phase: "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "applied",
    recovery: [],
    result: { kind: "create", sandboxId: "box_1" },
  };

  const fetcher: typeof fetch = async (_url, init) =>
    init?.method === "POST"
      ? Response.json({ operation: mismatched }, { status: 202 })
      : Response.json(mismatched);

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  let reference: RecoveryReference | undefined;

  try {
    await client.sandboxes.submitCreate({ environment: RemoteImage.prepared("fake-starter") });
    throw new Error("Expected an uncertain admission");
  } catch (error) {
    if (!(error instanceof OutcomeUnknownError)) throw error;
    reference = error.reference;
  }

  await expect(client.recover(reference!)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

test("remote file receipt retains snapshotted length after caller buffer transfer", async () => {
  const projectId = "project_1";

  const common = {
    projectId,
    sandboxId: "box_1",
    status: "succeeded",
    phase: "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "applied",
    recovery: [],
  };

  const createOperation = {
    ...common,
    id: "op_create",
    kind: "create",
    result: { kind: "create", sandboxId: "box_1" },
  };

  const writeOperation = {
    ...common,
    id: "op_write",
    kind: "file_write",
    result: {
      kind: "file_write",
      receipt: { path: "/snapshot", bytesWritten: 3, complete: true, effect: "applied" },
    },
  };

  let started = () => {};

  let release = () => {};

  let writes = 0;
  let requestBytes = new Uint8Array();

  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    const path = target.pathname;

    if (init?.method === "POST" && path.endsWith("/sandboxes"))
      return Response.json({ operation: createOperation }, { status: 202 });

    if (init?.method === "PUT" && path.endsWith("/files")) {
      writes++;
      requestBytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      started();
      await gate;

      return Response.json({ operation: writeOperation }, { status: 202 });
    }

    if (path.endsWith("/operations/op_create")) return Response.json(createOperation);

    if (path.endsWith("/operations/op_write")) return Response.json(writeOperation);

    if (path.includes("/invocations/"))
      return Response.json(
        target.searchParams.get("kind") === "file_write" ? writeOperation : createOperation,
      );

    if (path.endsWith("/sandboxes/box_1"))
      return Response.json({
        id: "box_1",
        projectId,
        connectionId: "conn_1",
        desiredState: "running",
        observedState: "running",
        revision: 1,
        environment: { kind: "prepared", imageId: "fake-starter" },
        network: { policy: "blocked" },
        labels: {},
      });

    throw new Error(`Unexpected path: ${path}`);
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const box = await client.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") });
  const bytes = Uint8Array.of(1, 2, 3);
  const pending = box.writeFile("/snapshot", bytes);
  await entered;

  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  expect(bytes.length).toBe(0);
  release();
  await pending;

  expect(writes).toBe(1);
  expect(requestBytes).toEqual(Uint8Array.of(1, 2, 3));
});

test("remote file reads stop at the SDK limit and cancel the response stream", async () => {
  const projectId = "project_1";

  const operation = {
    id: "op_1",
    projectId,
    kind: "create",
    sandboxId: "box_1",
    status: "succeeded",
    phase: "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "applied",
    recovery: [],
    result: { kind: "create", sandboxId: "box_1" },
  };

  let cancelled = 0;
  let declaredLength = false;

  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel() {
        cancelled++;
      },
    });

  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (init?.method === "POST") return Response.json({ operation }, { status: 202 });

    if (path.includes("/invocations/")) return Response.json(operation);

    if (path.endsWith("/sandboxes/box_1"))
      return Response.json({
        id: "box_1",
        projectId,
        connectionId: "conn_1",
        desiredState: "running",
        observedState: "running",
        revision: 1,
        environment: { kind: "prepared", imageId: "fake-starter" },
        network: { policy: "blocked" },
        labels: {},
      });

    if (path.endsWith("/files")) {
      const headers = new Headers({ "content-type": "application/octet-stream" });

      if (declaredLength) headers.set("content-length", "1200000");

      return new Response(stream(), { headers });
    }

    throw new Error(`Unexpected path: ${path}`);
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const box = await client.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") });
  await expect(box.readFile("/large")).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  expect(cancelled).toBe(1);
  declaredLength = true;
  await expect(box.readFile("/large")).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  expect(cancelled).toBe(2);
});

test("remote close aborts an in-flight file read", async () => {
  const projectId = "project_1";

  const operation = {
    id: "op_1",
    projectId,
    kind: "create",
    sandboxId: "box_1",
    status: "succeeded",
    phase: "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "applied",
    recovery: [],
    result: { kind: "create", sandboxId: "box_1" },
  };

  let started!: () => void;

  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });

  let readSignal: AbortSignal | undefined;

  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (init?.method === "POST") return Response.json({ operation }, { status: 202 });

    if (path.includes("/invocations/")) return Response.json(operation);

    if (path.endsWith("/sandboxes/box_1"))
      return Response.json({
        id: "box_1",
        projectId,
        connectionId: "conn_1",
        desiredState: "running",
        observedState: "running",
        revision: 1,
        environment: { kind: "prepared", imageId: "fake-starter" },
        network: { policy: "blocked" },
        labels: {},
      });

    if (path.endsWith("/files")) {
      readSignal = init?.signal ?? undefined;
      started();

      return new Promise<Response>((_resolve, reject) =>
        readSignal?.addEventListener("abort", () => reject(readSignal?.reason), { once: true }),
      );
    }

    throw new Error(`Unexpected path: ${path}`);
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const box = await client.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") });
  const pending = box.readFile("/hanging");
  await dispatched;
  await client.close();
  await expect(pending).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  expect(readSignal?.aborted).toBe(true);
});

test("remote close after service admission preserves the invocation reference", async () => {
  let started!: () => void, release!: () => void;

  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let key = "";
  let posts = 0;
  let requestSignal: AbortSignal | undefined;
  const projectId = "project_1";

  const operation = {
    id: "op_1",
    projectId,
    kind: "create",
    status: "queued",
    phase: "queued",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "none",
    recovery: [],
  };

  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method !== "POST") throw new Error("Unexpected lookup");
    posts++;
    requestSignal = init.signal ?? undefined;
    key = new Headers(init.headers).get("Idempotency-Key") ?? "";
    started();
    await gate;

    return Response.json({ operation }, { status: 202 });
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const pending = client.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") });
  await dispatched;
  await client.close();
  expect(requestSignal?.aborted).toBe(true);
  expect(posts).toBe(1);

  try {
    await pending;
    throw new Error("Expected uncertain close");
  } catch (error) {
    if (!(error instanceof OutcomeUnknownError)) throw error;
    expect(error.reference.invocationKey).toBe(key);
  }

  release();
});

test("remote abort after admission retains its invocation reference and cause", async () => {
  let started!: () => void, release!: () => void;

  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let key = "";
  const projectId = "project_1";

  const operation = {
    id: "op_1",
    projectId,
    kind: "create",
    status: "queued",
    phase: "queued",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "none",
    recovery: [],
  };

  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method !== "POST") throw new Error("Unexpected lookup");
    key = new Headers(init.headers).get("Idempotency-Key") ?? "";
    started();
    await gate;

    return Response.json({ operation }, { status: 202 });
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const controller = new AbortController();

  const pending = client.sandboxes.create(
    { environment: RemoteImage.prepared("fake-starter") },
    { signal: controller.signal },
  );

  await dispatched;
  const reason = new Error("stop waiting");
  controller.abort(reason);

  try {
    await pending;
    throw new Error("Expected abort");
  } catch (error) {
    if (!(error instanceof WaitAbortedError)) throw error;
    expect(error.reference.invocationKey).toBe(key);
    expect(error.cause).toBe(reason);
  }

  release();
});

test("remote refuses bearer transport over non-loopback HTTP", () => {
  expect(() =>
    RemoteSandbar.connect({
      url: "http://sandbar.example/",
      token: "secret",
      projectId: "project_1",
    }),
  ).toThrow();
  expect(() =>
    RemoteSandbar.connect({
      url: "http://127.0.0.1:8788/",
      token: "secret",
      projectId: "project_1",
    }),
  ).not.toThrow();
});

test("remote rejects invalid project IDs with public errors before fetch", () => {
  let fetches = 0;

  const fetcher: typeof fetch = async () => {
    fetches++;

    throw new Error("Unexpected fetch");
  };

  for (const projectId of ["invalid id", "x".repeat(129)]) {
    try {
      RemoteSandbar.connect({
        url: "https://sandbar.example/",
        token: "secret",
        projectId,
        fetch: fetcher,
      });
      throw new Error("Expected invalid project ID");
    } catch (error) {
      if (!(error instanceof SandbarError)) throw error;
      expect(error).toMatchObject({ code: "INVALID_ARGUMENT", effect: "none" });
    }
  }

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId: "valid_project",
    fetch: fetcher,
  });

  expect(client.projectId).toBe("valid_project");
  expect(fetches).toBe(0);
});

test("remote rejects tokens that cannot be sent as bearer headers before dispatch", () => {
  let fetches = 0;

  const fetcher: typeof fetch = async () => {
    fetches++;

    throw new Error("Unexpected fetch");
  };

  for (const token of ["bad\rvalue", "bad\nvalue", "bad\0value"]) {
    try {
      RemoteSandbar.connect({
        url: "https://sandbar.example/",
        token,
        projectId: "project_1",
        fetch: fetcher,
      });
      throw new Error("Expected invalid token");
    } catch (error) {
      if (!(error instanceof SandbarError)) throw error;
      expect(error).toMatchObject({ code: "INVALID_ARGUMENT", effect: "none" });
      expect(error.message).not.toContain(token);
    }
  }

  expect(() =>
    RemoteSandbar.connect({
      url: "https://sandbar.example/",
      token: "normal-token",
      projectId: "project_1",
      fetch: fetcher,
    }),
  ).not.toThrow();
  expect(fetches).toBe(0);
});

test("remote rejects malformed service URLs with public errors before fetch", () => {
  let fetches = 0;

  const fetcher: typeof fetch = async () => {
    fetches++;

    throw new Error("Unexpected fetch");
  };

  for (const url of ["not a URL", "https://["]) {
    try {
      RemoteSandbar.connect({ url, token: "secret", projectId: "project_1", fetch: fetcher });
      throw new Error("Expected invalid service URL");
    } catch (error) {
      if (!(error instanceof SandbarError)) throw error;
      expect(error).toMatchObject({ code: "INVALID_ARGUMENT", effect: "none" });
      expect(error.message).not.toContain(url);
    }
  }

  expect(fetches).toBe(0);
});

test("remote transport keeps authenticated routes within the configured project", async () => {
  let calls = 0;

  const fetcher: typeof fetch = async () => {
    calls++;

    return Response.json({});
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId: "project_1",
    fetch: fetcher,
  });

  expect(JSON.stringify(client)).not.toContain("secret");
  await expect(
    client.raw("../../../../v1/projects/project_2/sandboxes", { method: "GET" }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(calls).toBe(0);
});

test("remote recovery rejects an incomplete execution observation", async () => {
  const projectId = "project_1";

  const operation = {
    id: "op_1",
    projectId,
    kind: "exec",
    sandboxId: "box_1",
    executionId: "exec_1",
    status: "succeeded",
    phase: "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "applied",
    recovery: [],
    result: { kind: "exec", executionId: "exec_1" },
  };

  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;

    if (path.includes("/invocations/")) return Response.json(operation);

    if (path.endsWith("/executions/exec_1"))
      return Response.json({
        id: "exec_1",
        projectId,
        sandboxId: "box_1",
        operationId: "op_1",
        status: "unknown",
        outputAvailability: "captured",
        capturedBytes: 0,
        stdoutBase64: "",
        stderrBase64: "",
      });
    throw new Error(`Unexpected path: ${path}`);
  };

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const reference = {
    version: 2 as const,
    mode: "remote" as const,
    kind: "exec" as const,
    invocationKey: "0199f92e-1234-7000-8000-000000000001",
    operationId: "op_1",
    resourceId: "box_1",
    service: { url: "https://sandbar.example/", projectId },
  };

  const recovered = await client.recover(reference);
  await expect(recovered.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
});

test("remote recovery requires confirmed destroy and exact file receipts", async () => {
  const projectId = "project_1";

  const base = {
    id: "op_1",
    projectId,
    sandboxId: "box_1",
    status: "succeeded",
    phase: "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "applied",
    recovery: [],
  };

  let fileWrite = false;

  const fetcher: typeof fetch = async () =>
    Response.json(
      fileWrite
        ? {
            ...base,
            kind: "file_write",
            effect: "partial",
            result: {
              kind: "file_write",
              receipt: { path: "/data", bytesWritten: 1, complete: false, effect: "partial" },
            },
          }
        : {
            ...base,
            kind: "destroy",
            result: { kind: "destroy", computeStopped: false, retainedResources: [] },
          },
    );

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const common = {
    version: 2 as const,
    mode: "remote" as const,
    invocationKey: "0199f92e-1234-7000-8000-000000000001",
    operationId: "op_1",
    resourceId: "box_1",
    service: { url: "https://sandbar.example/", projectId },
  };

  await expect(
    (await client.recover({ ...common, kind: "destroy" })).observe(),
  ).rejects.toBeInstanceOf(OutcomeUnknownError);
  fileWrite = true;
  await expect(
    (
      await client.recover({ ...common, kind: "file_write", file: { path: "/data", bytes: 2 } })
    ).observe(),
  ).rejects.toBeInstanceOf(OutcomeUnknownError);
});

test("remote completed execution without an exit code has a distinct outcome", async () => {
  const projectId = "project_1";

  const operation = {
    id: "op_1",
    projectId,
    kind: "exec",
    sandboxId: "box_1",
    status: "succeeded",
    phase: "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    effect: "applied",
    recovery: [],
    result: { kind: "exec", executionId: "exec_1" },
  };

  const fetcher: typeof fetch = async (url) =>
    new URL(String(url)).pathname.includes("/invocations/")
      ? Response.json(operation)
      : Response.json({
          id: "exec_1",
          projectId,
          sandboxId: "box_1",
          operationId: "op_1",
          status: "completed",
          exitCode: null,
          outputAvailability: "captured",
          capturedBytes: 0,
          stdoutBase64: "",
          stderrBase64: "",
        });

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const reference = {
    version: 2 as const,
    mode: "remote" as const,
    kind: "exec" as const,
    invocationKey: "0199f92e-1234-7000-8000-000000000001",
    operationId: "op_1",
    resourceId: "box_1",
    service: { url: "https://sandbar.example/", projectId },
  };

  await expect((await client.recover(reference)).observe()).rejects.toBeInstanceOf(NoExitCodeError);
});

test("remote mount checks report unsupported without dispatching a request", async () => {
  let requests = 0;

  const client = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId: "project_1",
    fetch: async () => {
      requests++;
      throw new Error("Mount checks must not dispatch");
    },
  });

  const input = {
    environment: RemoteImage.prepared("base"),
    mounts: [
      {
        volume: {
          version: 1 as const,
          kind: "volume" as const,
          provider: "daytona",
          nativeId: "volume_1",
          scope: { authority: { kind: "organization", id: "org_1" }, partition: {} },
          ownership: "borrowed" as const,
        },
        path: "/data",
      },
    ],
  };

  expect(await client.sandboxes.checkCreate(input)).toMatchObject({ status: "unsupported" });
  await expect(client.sandboxes.submitCreate(input)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(requests).toBe(0);
});
