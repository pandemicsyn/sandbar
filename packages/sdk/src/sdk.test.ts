import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider } from "@sandbar/provider-fake/client";
import { startFakeProviderServer } from "@sandbar/provider-fake/server";
import { ProviderReadError, type SandboxRef } from "@sandbar/provider-spi";
import {
  Image as DirectImage,
  Sandbar as DirectSandbar,
  NonzeroExitError,
  NoExitCodeError,
  OutcomeUnknownError,
  SandbarError,
  WaitAbortedError,
} from "./direct";
import type { RecoveryReference } from "./direct";
import { Image as RemoteImage, Sandbar as RemoteSandbar } from "./remote";
import * as packagedRoot from "@sandbar/sdk";
import * as packagedDirect from "@sandbar/sdk/direct";
import * as packagedRemote from "@sandbar/sdk/remote";

let server: Awaited<ReturnType<typeof startFakeProviderServer>> | undefined;

let directory: string | undefined;

const token = "sdk-fake-token-12345";

type FixtureControlBody = {
  [key: string]: string | number | boolean | string[] | FixtureControlBody;
};

async function fixture() {
  directory = await mkdtemp(join(tmpdir(), "sandbar-sdk-"));
  server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "fake.json"),
    token,
    testMode: true,
  });
  const url = server.url.toString();

  const control = async (path: string, body?: FixtureControlBody) => {
    const response = await fetch(new URL(path, url), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Fixture control failed: ${response.status}`);

    return response.json();
  };

  return {
    client: DirectSandbar.direct({ provider: await fakeProvider({ url, token }) }),
    control,
    url,
  };
}

afterEach(async () => {
  server?.stop(true);
  server = undefined;

  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("packaged SDK entry points share error class identity", () => {
  expect(packagedRoot.SandbarError).toBe(packagedDirect.SandbarError);
  expect(packagedRoot.SandbarError).toBe(packagedRemote.SandbarError);
  expect(packagedRoot.OutcomeUnknownError).toBe(packagedDirect.OutcomeUnknownError);
  expect(packagedRoot.OutcomeUnknownError).toBe(packagedRemote.OutcomeUnknownError);
  expect(packagedRoot.WaitAbortedError).toBe(packagedDirect.WaitAbortedError);
  expect(packagedRoot.WaitAbortedError).toBe(packagedRemote.WaitAbortedError);
});

test("direct resource flow preserves binary files and nonzero output", async () => {
  const { client, control } = await fixture();
  await expect(client.sandboxes.submitCreate(JSON.parse("null"))).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect((await control("/_test/state")).invocations).toHaveLength(0);
  const box = await client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });
  expect((await box.inspect()).state).toBe("running");
  const preAborted = new AbortController();
  preAborted.abort(new Error("cancel before submission"));
  const before = (await control("/_test/state")).invocations.length;
  await expect(
    box.submitExec(
      { command: { kind: "argv", argv: ["fixture", "binary"] } },
      { signal: preAborted.signal },
    ),
  ).rejects.toBe(preAborted.signal.reason);
  expect((await control("/_test/state")).invocations.length).toBe(before);

  for (const invalid of [
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

  expect((await control("/_test/state")).invocations.length).toBe(before);
  const file = Uint8Array.of(0, 255, 128, 42);
  await box.writeFile("/binary", file);
  expect(await box.readFile("/binary")).toEqual(file);
  await expect(box.readFile("/missing")).rejects.toMatchObject({
    code: "NOT_FOUND",
    effect: "none",
  });
  await expect(box.readFile("/a/./b")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(box.readFile("/../escape")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(box.writeFile("/bad\0path", file)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(box.writeFile("/too-large", new Uint8Array(1_048_577))).rejects.toMatchObject({
    code: "OUTPUT_CAPACITY",
  });
  const command = { kind: "argv" as const, argv: ["fixture", "binary"] };
  await control("/_test/seed", {
    submissionId: "*",
    action: "exec",
    command: {
      command,
      exitCode: 7,
      stdoutBase64: Buffer.from(file).toString("base64"),
      stderrBase64: Buffer.from([1, 2]).toString("base64"),
    },
  });

  try {
    await box.exec({ command });
    throw new Error("Expected nonzero exit");
  } catch (error) {
    if (!(error instanceof NonzeroExitError)) throw error;
    const result = error.result;
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toEqual(file);
    expect(result.stderr).toEqual(Uint8Array.of(1, 2));
  }

  await box.destroy();
  await client.close();
  expect(box.inspect()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
});

test("direct rejects create contract violations before provider preparation", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const prepare = provider.driver.prepare.bind(provider.driver);
  const create = provider.driver.create.bind(provider.driver);
  let preparations = 0;
  let dispatches = 0;

  provider.driver.prepare = async (input) => {
    preparations++;

    return prepare(input);
  };

  provider.driver.create = async (input) => {
    dispatches++;

    return create(input);
  };

  const client = DirectSandbar.direct({ provider });

  for (const invalid of [
    { environment: DirectImage.prepared("invalid id") },
    { environment: DirectImage.oci("x".repeat(1025)) },
    { environment: DirectImage.prepared("fake-starter"), labels: { long: "x".repeat(257) } },
  ]) {
    await expect(client.sandboxes.submitCreate(invalid)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      effect: "none",
    });
  }

  expect(preparations).toBe(0);
  expect(dispatches).toBe(0);
});

test("direct rejects malformed provider scope with a public error before driver calls", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const capabilities = provider.driver.capabilities.bind(provider.driver);
  let calls = 0;

  provider.driver.capabilities = async (scope) => {
    calls++;

    return capabilities(scope);
  };

  try {
    DirectSandbar.direct({ provider: { driver: provider.driver, scope: JSON.parse("{}") } });
    throw new Error("Expected invalid provider scope");
  } catch (error) {
    if (!(error instanceof SandbarError)) throw error;
    expect(error).toMatchObject({ code: "INVALID_ARGUMENT", effect: "none" });
  }

  expect(calls).toBe(0);
});

test("direct file writes retain caller bytes before asynchronous provider dispatch", async () => {
  const { client } = await fixture();

  const box = await client.sandboxes.create({
    environment: DirectImage.prepared("fake-starter"),
  });

  const write = client.driver.writeFile.bind(client.driver);

  let started = () => {};

  let release = () => {};

  let dispatches = 0;

  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  client.driver.writeFile = async (input) => {
    dispatches++;
    started();
    await gate;

    return write(input);
  };

  const bytes = Uint8Array.of(1, 2, 3);
  const pending = box.writeFile("/snapshot", bytes);
  await entered;
  bytes[0] = 9;
  release();
  await pending;

  expect(dispatches).toBe(1);
  expect(await box.readFile("/snapshot")).toEqual(Uint8Array.of(1, 2, 3));
});

test("direct lost response is recovered by observation without replay; wrong scope is rejected", async () => {
  const { client, control } = await fixture();
  await control("/_test/seed", {
    submissionId: "*",
    action: "create",
    behavior: "lost_after_effect",
  });

  const operation = await client.sandboxes.submitCreate({
    environment: DirectImage.prepared("fake-starter"),
  });

  const reference = JSON.parse(JSON.stringify(operation.reference));
  expect(JSON.stringify(reference)).not.toContain(token);
  const recovered = await client.recover(reference);
  const box = await recovered.wait();
  expect(box).toMatchObject({ id: expect.stringMatching(/^fake_sandbox_/) });
  const state = await control("/_test/state");
  expect(state.invocations.filter((x: { action: string }) => x.action === "create")).toHaveLength(
    1,
  );
  await expect(
    client.recover({ ...reference, scope: { ...reference.scope, accountId: "other" } }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("direct client scope stays fixed across ambiguous sandbox mutation recovery", async () => {
  const { client, control } = await fixture();
  const box = await client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });
  const accountId = client.scope.accountId;

  expect(() => Object.assign(client.scope, { accountId: "other" })).toThrow();
  expect(client.scope.accountId).toBe(accountId);

  const command = { kind: "argv" as const, argv: ["fixture", "ok"] };

  await control("/_test/seed", {
    submissionId: "*",
    action: "exec",
    behavior: "lost_after_effect",
    command: { command, exitCode: 0, stdoutBase64: "" },
  });

  const operation = await box.submitExec({ command });
  expect(operation.reference.scope?.accountId).toBe(accountId);

  const recovered = await client.recover(operation.reference);
  const result = await recovered.wait();
  expect(result).toMatchObject({ exitCode: 0 });

  const state = await control("/_test/state");
  expect(
    state.invocations.filter((item: { action: string }) => item.action === "exec"),
  ).toHaveLength(1);
});

test("direct sandbox reference stays fixed across ambiguous mutation recovery", async () => {
  const { client, control } = await fixture();
  const box = await client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });

  // SAFETY: Direct mode returns a DirectSandbox with the public native ref under test.
  const ref = (box as typeof box & { ref: SandboxRef }).ref;
  const originalId = box.id;
  const originalAccount = client.scope.accountId;

  expect(() => Object.assign(ref, { nativeId: "foreign" })).toThrow();
  expect(() => Object.assign(ref.scope, { accountId: "foreign" })).toThrow();
  expect(ref.nativeId).toBe(originalId);
  expect(ref.scope.accountId).toBe(originalAccount);

  const command = { kind: "argv" as const, argv: ["fixture", "ok"] };

  await control("/_test/seed", {
    submissionId: "*",
    action: "exec",
    behavior: "lost_after_effect",
    command: { command, exitCode: 0, stdoutBase64: "" },
  });

  const operation = await box.submitExec({ command });
  expect(operation.reference.sandbox?.nativeId).toBe(originalId);
  expect(operation.reference.sandbox?.scope.accountId).toBe(originalAccount);

  await expect((await client.recover(operation.reference)).wait()).resolves.toMatchObject({
    exitCode: 0,
  });

  const state = await control("/_test/state");
  expect(
    state.invocations.filter((item: { action: string }) => item.action === "exec"),
  ).toHaveLength(1);
});

test("fake provider registration binds recovery to the configured endpoint", async () => {
  const { client } = await fixture();
  expect(JSON.stringify(client)).not.toContain(token);

  const op = await client.sandboxes.submitCreate({
    environment: DirectImage.prepared("fake-starter"),
  });

  const otherDirectory = await mkdtemp(join(tmpdir(), "sandbar-sdk-other-"));

  const other = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(otherDirectory, "fake.json"),
    token,
    testMode: true,
  });

  try {
    const otherClient = DirectSandbar.direct({
      provider: await fakeProvider({ url: other.url.toString(), token }),
    });

    await expect(otherClient.recover(op.reference)).rejects.toMatchObject({ code: "FORBIDDEN" });
  } finally {
    other.stop(true);
    await rm(otherDirectory, { recursive: true, force: true });
  }
});

test("fake provider recovery accepts equivalent ignored URL components without replay", async () => {
  const { client, control, url } = await fixture();

  const submitted = await client.sandboxes.submitCreate({
    environment: DirectImage.prepared("fake-starter"),
  });

  // SAFETY: The saved value is a JSON round trip of the SDK's RecoveryReference.
  const saved = JSON.parse(JSON.stringify(submitted.reference)) as RecoveryReference;

  const equivalent = DirectSandbar.direct({
    provider: await fakeProvider({ url: `${url}ignored/path?variant=1#fragment`, token }),
  });

  const recovered = await equivalent.recover(saved);
  expect((await recovered.wait()).id).toBeTruthy();
  expect((await control("/_test/state")).invocations).toHaveLength(1);
});

test("direct undiscoverable effect reports unknown without replay", async () => {
  const { client, control } = await fixture();
  await control("/_test/profile", {
    nativeIdempotency: { create: false, exec: false, destroy: false, writeFile: false },
    discoveryBySubmission: false,
  });
  await control("/_test/seed", {
    submissionId: "*",
    action: "create",
    behavior: "lost_after_effect",
  });

  const operation = await client.sandboxes.submitCreate({
    environment: DirectImage.prepared("fake-starter"),
  });

  await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
  const state = await control("/_test/state");
  expect(state.resources).toHaveLength(1);
  expect(state.invocations.filter((x: { action: string }) => x.action === "create")).toHaveLength(
    1,
  );
});

test("closing a client interrupts pending direct observation without destroying compute", async () => {
  const { client, control } = await fixture();
  await control("/_test/seed", { submissionId: "*", action: "create", delayObservations: 100 });

  const operation = await client.sandboxes.submitCreate({
    environment: DirectImage.prepared("fake-starter"),
  });

  const waiting = operation.wait({ pollMs: 60 });
  await client.close();
  await expect(waiting).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  await expect(operation.observe()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  expect((await control("/_test/state")).resources).toHaveLength(1);
});

test("closing a client releases direct public observation waits", async () => {
  const { client, control } = await fixture();
  await control("/_test/seed", { submissionId: "*", action: "create", delayObservations: 1 });

  const operation = await client.sandboxes.submitCreate({
    environment: DirectImage.prepared("fake-starter"),
  });

  expect(await operation.observe()).toBeNull();

  const observe = client.driver.observe.bind(client.driver);
  let entered!: () => void, release!: () => void;

  const bothEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let calls = 0;

  client.driver.observe = async (input) => {
    const call = ++calls;

    if (call === 2) entered();
    await gate;

    if (call === 2) throw new Error("late provider read failure");

    return observe(input);
  };

  const first = operation.observe();
  const second = operation.observe();
  await bothEntered;

  try {
    await client.close();
    await expect(first).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      reference: operation.reference,
    });
    await expect(second).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      reference: operation.reference,
    });
  } finally {
    release();
  }

  await expect(operation.observe()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  expect((await control("/_test/state")).invocations).toHaveLength(1);
});

test("closing a direct client releases stalled inspect and file-read waits", async () => {
  const { url, control } = await fixture();
  const provider = await fakeProvider({ url, token });
  const client = DirectSandbar.direct({ provider });
  const box = await client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });
  await box.writeFile("/sample", Uint8Array.of(1, 2, 3));

  const inspect = provider.driver.inspect.bind(provider.driver);
  const readFile = provider.driver.readFile.bind(provider.driver);
  let entered!: () => void, release!: () => void;

  const bothEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let started = 0;

  const markEntered = () => {
    started++;

    if (started === 2) entered();
  };

  provider.driver.inspect = async (ref) => {
    markEntered();
    await gate;

    return inspect(ref);
  };

  provider.driver.readFile = async (input) => {
    markEntered();
    await gate;

    return readFile(input);
  };

  const waitingInspect = box.inspect();
  const waitingRead = box.readFile("/sample");
  await bothEntered;

  try {
    await client.close();
    await expect(waitingInspect).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(waitingRead).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  } finally {
    release();
  }

  expect((await control("/_test/state")).invocations).toHaveLength(2);
});

test("direct inspect translates provider read errors to public SDK errors", async () => {
  const { url, control } = await fixture();
  const provider = await fakeProvider({ url, token });
  const client = DirectSandbar.direct({ provider });
  const box = await client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });

  expect((await box.inspect()).state).toBe("running");

  provider.driver.inspect = async () => {
    throw new ProviderReadError("INVALID_RESPONSE", "Fake inspect returned another sandbox");
  };

  const invalid = box.inspect();
  await expect(invalid).rejects.toBeInstanceOf(SandbarError);
  await expect(invalid).rejects.toMatchObject({ code: "INVALID_RESPONSE", effect: "unknown" });

  provider.driver.inspect = async () => {
    throw new ProviderReadError("NOT_FOUND", "Fake sandbox not found");
  };

  await expect(box.inspect()).rejects.toMatchObject({ code: "NOT_FOUND", effect: "none" });
  expect((await control("/_test/state")).invocations).toHaveLength(1);
});

test("direct close during applied create preserves a recovery reference", async () => {
  const { url, control } = await fixture();
  const provider = await fakeProvider({ url, token });
  const create = provider.driver.create.bind(provider.driver);
  let entered!: () => void, release!: () => void;

  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  provider.driver.create = async (input) => {
    const result = await create(input);
    entered();
    await gate;

    return result;
  };

  const client = DirectSandbar.direct({ provider });
  const pending = client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });
  await dispatched;
  await client.close();

  try {
    await pending;
    throw new Error("Expected uncertain close");
  } catch (error) {
    if (!(error instanceof OutcomeUnknownError)) throw error;
    expect(error.reference.submissionId).toStartWith("sdk_");
  }

  release();
  expect((await control("/_test/state")).resources).toHaveLength(1);
});

test("direct abort after effect retains its reference and cause", async () => {
  const { url, control } = await fixture();
  const provider = await fakeProvider({ url, token });
  const create = provider.driver.create.bind(provider.driver);
  let entered!: () => void, release!: () => void;

  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  provider.driver.create = async (input) => {
    const result = await create(input);
    entered();
    await gate;

    return result;
  };

  const client = DirectSandbar.direct({ provider });
  const controller = new AbortController();

  const pending = client.sandboxes.create(
    { environment: DirectImage.prepared("fake-starter") },
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
    expect(error.reference.submissionId).toStartWith("sdk_");
    expect(error.cause).toBe(reason);
  }

  release();
  expect((await control("/_test/state")).resources).toHaveLength(1);
});

test("direct abort during image preparation does not dispatch create", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const prepare = provider.driver.prepare.bind(provider.driver);
  const create = provider.driver.create.bind(provider.driver);
  let entered!: () => void, release!: () => void;

  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let creates = 0;
  provider.driver.prepare = async (input) => {
    entered();
    await gate;

    return prepare(input);
  };

  provider.driver.create = async (input) => {
    creates++;

    return create(input);
  };

  const client = DirectSandbar.direct({ provider });
  const controller = new AbortController();
  const reason = new Error("cancel preparation");

  const pending = client.sandboxes.create(
    { environment: DirectImage.prepared("fake-starter") },
    { signal: controller.signal },
  );

  await preparing;
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(creates).toBe(0);
});

test("direct submitCreate aborts stalled preflight before dispatch", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const capabilities = provider.driver.capabilities.bind(provider.driver);
  const create = provider.driver.create.bind(provider.driver);
  let entered!: () => void, release!: () => void;

  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let creates = 0;
  provider.driver.capabilities = async (scope) => {
    entered();
    await gate;

    return capabilities(scope);
  };

  provider.driver.create = async (input) => {
    creates++;

    return create(input);
  };

  const client = DirectSandbar.direct({ provider });
  const controller = new AbortController();
  const reason = new Error("stop preflight");

  const pending = client.sandboxes.submitCreate(
    { environment: DirectImage.prepared("fake-starter") },
    { signal: controller.signal },
  );

  await checking;
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(creates).toBe(0);
});

test("direct operation keeps a terminal result without provider discovery", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const client = DirectSandbar.direct({ provider });

  const operation = await client.sandboxes.submitCreate({
    environment: DirectImage.prepared("fake-starter"),
  });

  const box = await operation.wait();
  let observations = 0;
  provider.driver.observe = async () => {
    observations++;

    return null;
  };

  expect((await operation.observe())?.id).toBe(box.id);
  expect((await operation.wait()).id).toBe(box.id);
  expect(observations).toBe(0);
});

test("direct inspection rejects malformed provider state", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const client = DirectSandbar.direct({ provider });
  const box = await client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });
  Reflect.set(provider.driver, "inspect", async (ref: { nativeId: string }) => ({
    ref,
    state: "impossible",
    observedAt: "bad",
  }));
  await expect(box.inspect()).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
    effect: "unknown",
  });
});

test("fake direct reads reject malformed base64 as an invalid provider response", async () => {
  const { url } = await fixture();

  const provider = await fakeProvider({
    url,
    token,
    fetch: async (request, init) => {
      if (JSON.parse(String(init?.body)).kind === "readFile")
        return Response.json({ bytesBase64: "not base64" });

      return fetch(request, init);
    },
  });

  const client = DirectSandbar.direct({ provider });
  const box = await client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });
  await expect(box.readFile("/binary")).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
    effect: "unknown",
  });
});

test("abort ends direct and remote waits even when observation hangs", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const client = DirectSandbar.direct({ provider });

  const operation = await client.sandboxes.submitCreate({
    environment: DirectImage.prepared("fake-starter"),
  });

  provider.driver.observe = async () => new Promise(() => {});
  const directAbort = new AbortController();
  const directRef = await client.recover(operation.reference);
  const directWait = directRef.wait({ signal: directAbort.signal });
  setTimeout(() => directAbort.abort(), 10);
  await expect(directWait).rejects.toMatchObject({ name: "AbortError" });

  const projectId = "project_1";

  const queued = {
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

  const fetcher: typeof fetch = async (_url, init) =>
    init?.method === "POST"
      ? Response.json({ operation: queued }, { status: 202 })
      : new Promise(() => {});

  const remote = RemoteSandbar.connect({
    url: "https://sandbar.example/",
    token: "secret",
    projectId,
    fetch: fetcher,
  });

  const remoteOp = await remote.sandboxes.submitCreate({
    environment: RemoteImage.prepared("fake-starter"),
  });

  const remoteAbort = new AbortController();
  const remoteWait = remoteOp.wait({ signal: remoteAbort.signal });
  setTimeout(() => remoteAbort.abort(), 10);
  await expect(remoteWait).rejects.toMatchObject({ name: "AbortError" });
});

test("direct recovery never treats incomplete destroy or file receipts as success", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const client = DirectSandbar.direct({ provider });
  const sandbox = { scope: provider.scope, nativeId: "fake_sandbox_1", kind: "sandbox" as const };

  const common = {
    version: 1 as const,
    mode: "direct" as const,
    invocationKey: "0199f92e-1234-7000-8000-000000000001",
    operationId: "op_1",
    submissionId: "sid_1",
    scope: provider.scope,
    sandbox,
  };

  provider.driver.observe = async () => ({
    status: "completed",
    effect: "applied",
    submissionId: "sid_1",
    value: {
      kind: "destroy",
      observation: { sandbox, computeStopped: false, retainedResources: [] },
    },
  });
  await expect(
    (await client.recover({ ...common, kind: "destroy" })).observe(),
  ).rejects.toBeInstanceOf(OutcomeUnknownError);
  provider.driver.observe = async () => ({
    status: "completed",
    effect: "applied",
    submissionId: "sid_1",
    value: {
      kind: "file_write",
      observation: { sandbox, path: "/data", bytesWritten: 1, complete: false },
    },
  });
  await expect(
    (
      await client.recover({ ...common, kind: "file_write", file: { path: "/data", bytes: 2 } })
    ).observe(),
  ).rejects.toBeInstanceOf(OutcomeUnknownError);
  await expect(
    client.recover({ ...common, kind: "file_write", file: { path: "/../escape", bytes: 2 } }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(
    client.recover({ ...common, kind: "file_write", file: { path: "/a/./b", bytes: 2 } }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(
    client.recover({ ...common, kind: "destroy", file: { path: "/data", bytes: 2 } }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  provider.driver.observe = async () => ({
    status: "completed",
    effect: "applied",
    submissionId: "sid_1",
    value: {
      kind: "execution",
      observation: {
        ref: { scope: provider.scope, nativeId: "fake_execution_1", kind: "execution" },
        sandbox,
        completed: true,
        exitCode: null,
        stdoutBase64: "",
        stderrBase64: "",
        observedAt: "2026-01-01T00:00:00Z",
      },
    },
  });
  await expect(
    (await client.recover({ ...common, kind: "exec", maxOutputBytes: 1024 })).observe(),
  ).rejects.toBeInstanceOf(NoExitCodeError);
});

test("direct imported recovery strips nested secrets and ignores later caller changes", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const client = DirectSandbar.direct({ provider });
  const sandbox = { scope: provider.scope, nativeId: "fake_sandbox_1", kind: "sandbox" as const };

  const imported = JSON.parse(
    JSON.stringify({
      version: 1,
      mode: "direct",
      kind: "destroy",
      invocationKey: "0199f92e-1234-7000-8000-000000000001",
      operationId: "op_1",
      submissionId: "sid_1",
      scope: provider.scope,
      sandbox,
    }),
  );

  imported.scope.secret = "scope-secret";
  imported.sandbox.scope.token = "sandbox-secret";
  let observedScope: unknown;
  provider.driver.observe = async (input) => {
    observedScope = input.scope;

    return {
      status: "rejected",
      effect: "none",
      error: { code: "not_found", message: "missing", effect: "none", retry: "never" },
    };
  };

  const recovered = await client.recover(imported);
  expect(JSON.stringify(recovered.reference)).not.toContain("secret");
  imported.scope.connectionId = "changed";
  imported.sandbox.scope.connectionId = "changed";

  try {
    recovered.reference.scope!.connectionId = "changed";
  } catch {
    /* frozen references reject caller mutation */
  }

  await expect(recovered.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
  expect(observedScope).toEqual(provider.scope);
  expect(recovered.reference.sandbox?.scope).toEqual(provider.scope);
});

test("direct observation failure retains its recovery reference", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  provider.driver.observe = async () => {
    throw new TypeError("provider response lost");
  };

  const client = DirectSandbar.direct({ provider });

  const reference: RecoveryReference = {
    version: 1,
    mode: "direct",
    kind: "create",
    invocationKey: "0199f92e-1234-7000-8000-000000000001",
    operationId: "op_1",
    submissionId: "sid_1",
    scope: provider.scope,
  };

  const operation = await client.recover(reference);
  await expect(operation.observe()).rejects.toMatchObject({
    code: "OUTCOME_UNKNOWN",
    reference: operation.reference,
  });
});

test("direct null submission response never treats a later rejection as definitive", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  let dispatches = 0;
  let observations = 0;
  Reflect.set(provider.driver, "create", async () => {
    dispatches++;

    return null;
  });
  provider.driver.observe = async () => {
    observations++;

    return {
      status: "rejected",
      effect: "none",
      error: { code: "invalid", message: "late rejection", effect: "none", retry: "never" },
    };
  };

  const client = DirectSandbar.direct({ provider });

  const operation = await client.sandboxes.submitCreate({
    environment: DirectImage.prepared("fake-starter"),
  });

  await expect(operation.observe()).rejects.toMatchObject({
    code: "OUTCOME_UNKNOWN",
    reference: operation.reference,
  });
  expect(dispatches).toBe(1);
  expect(observations).toBe(0);
});

test("direct definitive provider rejections use the service error vocabulary", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });

  const expected = [
    ["invalid", "INVALID_ARGUMENT"],
    ["unsupported", "UNSUPPORTED"],
    ["unauthorized", "UNAUTHENTICATED"],
    ["not_found", "NOT_FOUND"],
    ["conflict", "CONFLICT"],
    ["capacity", "CAPACITY"],
    ["rate_limit", "RATE_LIMIT"],
    ["unavailable", "UNAVAILABLE"],
    ["timeout", "TIMEOUT"],
    ["internal", "INTERNAL"],
  ] as const;

  let code: (typeof expected)[number][0] = "invalid";
  let dispatches = 0;

  Reflect.set(provider.driver, "create", async () => {
    dispatches++;

    return {
      status: "rejected",
      effect: "none",
      error: { code, message: "provider rejected", effect: "none", retry: "never" },
    };
  });
  provider.driver.observe = async () => {
    throw new Error("Definitive submission rejection must not require observation");
  };

  const client = DirectSandbar.direct({ provider });

  for (const [providerCode, publicCode] of expected) {
    code = providerCode;

    const operation = await client.sandboxes.submitCreate({
      environment: DirectImage.prepared("fake-starter"),
    });

    await expect(operation.observe()).rejects.toMatchObject({
      code: publicCode,
      message: "provider rejected",
      effect: "none",
    });

    await expect(operation.observe()).rejects.toMatchObject({ code: publicCode });
  }

  expect(dispatches).toBe(expected.length);
});

test("direct fake authentication failures are public before dispatch and during reads", async () => {
  const { url, control } = await fixture();
  let revoked = false;
  let creates = 0;

  const provider = await fakeProvider({
    url,
    token,
    fetch: async (request, init) => {
      if (JSON.parse(String(init?.body)).kind === "create") creates++;

      if (revoked) return Response.json({ error: "unauthorized" }, { status: 401 });

      return fetch(request, init);
    },
  });

  const client = DirectSandbar.direct({ provider });
  revoked = true;

  await expect(
    client.sandboxes.submitCreate({ environment: DirectImage.prepared("fake-starter") }),
  ).rejects.toMatchObject({ name: "SandbarError", code: "UNAUTHENTICATED", effect: "none" });
  expect(creates).toBe(0);
  expect((await control("/_test/state")).invocations).toHaveLength(0);

  revoked = false;
  const box = await client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });
  revoked = true;
  await expect(box.inspect()).rejects.toMatchObject({
    name: "SandbarError",
    code: "UNAUTHENTICATED",
    effect: "unknown",
  });
  await expect(box.readFile("/file")).rejects.toMatchObject({
    name: "SandbarError",
    code: "UNAUTHENTICATED",
    effect: "unknown",
  });
  expect(creates).toBe(1);
});

test("direct preparation authentication failure remains pre-dispatch", async () => {
  const { url, control } = await fixture();
  const provider = await fakeProvider({ url, token });
  let creates = 0;
  provider.driver.prepare = async () => {
    throw new ProviderReadError("UNAUTHENTICATED", "Fake provider authentication failed");
  };

  Reflect.set(provider.driver, "create", async () => {
    creates++;
    throw new Error("Must not dispatch");
  });
  const client = DirectSandbar.direct({ provider });

  await expect(
    client.sandboxes.submitCreate({ environment: DirectImage.prepared("fake-starter") }),
  ).rejects.toMatchObject({ name: "SandbarError", code: "UNAUTHENTICATED", effect: "none" });
  expect(creates).toBe(0);
  expect((await control("/_test/state")).invocations).toHaveLength(0);
});

test("direct post-submission authentication failure keeps the recovery reference", async () => {
  const { url, control } = await fixture();
  let revoked = false;
  let creates = 0;

  const provider = await fakeProvider({
    url,
    token,
    fetch: async (request, init) => {
      if (JSON.parse(String(init?.body)).kind === "create") creates++;

      if (revoked) return Response.json({ error: "unauthorized" }, { status: 401 });

      return fetch(request, init);
    },
  });

  await control("/_test/seed", {
    submissionId: "*",
    action: "create",
    behavior: "lost_after_effect",
  });
  const client = DirectSandbar.direct({ provider });

  const operation = await client.sandboxes.submitCreate({
    environment: DirectImage.prepared("fake-starter"),
  });

  revoked = true;

  await expect(operation.observe()).rejects.toMatchObject({
    code: "OUTCOME_UNKNOWN",
    reference: operation.reference,
  });
  expect(creates).toBe(1);
  expect((await control("/_test/state")).invocations).toHaveLength(1);
});

test("direct execution bounds provider output before decoding", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const sandbox = { scope: provider.scope, nativeId: "fake_sandbox_1", kind: "sandbox" as const };
  provider.driver.observe = async () => ({
    status: "completed",
    submissionId: "sid_1",
    effect: "applied",
    value: {
      kind: "execution",
      observation: {
        ref: { scope: provider.scope, nativeId: "fake_execution_1", kind: "execution" as const },
        sandbox,
        completed: true,
        exitCode: 0,
        stdoutBase64: "AAAA".repeat(1_000_000),
        stderrBase64: "",
        observedAt: "2026-01-01T00:00:00Z",
      },
    },
  });
  const client = DirectSandbar.direct({ provider });

  const operation = await client.recover({
    version: 1,
    mode: "direct",
    kind: "exec",
    invocationKey: "0199f92e-1234-7000-8000-000000000001",
    operationId: "op_1",
    submissionId: "sid_1",
    scope: provider.scope,
    sandbox,
    maxOutputBytes: 2,
  });

  await expect(operation.observe()).resolves.toMatchObject({
    stdout: Uint8Array.of(0, 0),
    truncated: true,
  });
});

test("direct operation can observe a later complete execution after incomplete evidence", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const sandbox = { scope: provider.scope, nativeId: "fake_sandbox_1", kind: "sandbox" as const };
  let observations = 0;
  provider.driver.observe = async () => ({
    status: "completed",
    submissionId: "sid_1",
    effect: "applied",
    value: {
      kind: "execution",
      observation: {
        ref: { scope: provider.scope, nativeId: "fake_execution_1", kind: "execution" as const },
        sandbox,
        completed: ++observations > 1,
        exitCode: observations > 1 ? 0 : undefined,
        stdoutBase64: observations > 1 ? "YQ==" : undefined,
        observedAt: "2026-01-01T00:00:00Z",
      },
    },
  });
  const client = DirectSandbar.direct({ provider });

  const operation = await client.recover({
    version: 1,
    mode: "direct",
    kind: "exec",
    invocationKey: "0199f92e-1234-7000-8000-000000000001",
    operationId: "op_1",
    submissionId: "sid_1",
    scope: provider.scope,
    sandbox,
  });

  await expect(operation.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
  await expect(operation.observe()).resolves.toMatchObject({
    stdout: Uint8Array.of(97),
    exitCode: 0,
  });
  expect(observations).toBe(2);
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
    { environment: RemoteImage.prepared("invalid id") },
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

  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    const path = target.pathname;

    if (init?.method === "POST" && path.endsWith("/sandboxes"))
      return Response.json({ operation: createOperation }, { status: 202 });

    if (init?.method === "POST" && path.endsWith("/executions")) {
      execDispatches++;

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
    version: 1 as const,
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
    version: 1 as const,
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
    version: 1 as const,
    mode: "remote" as const,
    kind: "exec" as const,
    invocationKey: "0199f92e-1234-7000-8000-000000000001",
    operationId: "op_1",
    resourceId: "box_1",
    service: { url: "https://sandbar.example/", projectId },
  };

  await expect((await client.recover(reference)).observe()).rejects.toBeInstanceOf(NoExitCodeError);
});
