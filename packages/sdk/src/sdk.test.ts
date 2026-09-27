import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider } from "@sandbar/provider-fake/client";
import { startFakeProviderServer } from "@sandbar/provider-fake/server";
import { Image as DirectImage, Sandbar as DirectSandbar, NonzeroExitError, NoExitCodeError, OutcomeUnknownError, WaitAbortedError } from "./direct";
import type { RecoveryReference } from "./direct";
import { Image as RemoteImage, Sandbar as RemoteSandbar } from "./remote";
import * as packagedRoot from "@sandbar/sdk";
import * as packagedDirect from "@sandbar/sdk/direct";
import * as packagedRemote from "@sandbar/sdk/remote";

let server: Awaited<ReturnType<typeof startFakeProviderServer>> | undefined;
let directory: string | undefined;
const token = "sdk-fake-token-12345";
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), "sandbar-sdk-"));
  server = await startFakeProviderServer({ hostname: "127.0.0.1", port: 0, statePath: join(directory, "fake.json"), token, testMode: true });
  const url = server.url.toString();
  const control = async (path: string, body?: unknown) => {
    const response = await fetch(new URL(path, url), { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`Fixture control failed: ${response.status}`);
    return response.json();
  };
  return { client: DirectSandbar.direct({ provider: await fakeProvider({ url, token }) }), control, url };
}
afterEach(async () => { server?.stop(true); server = undefined; if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

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
  await expect(client.sandboxes.submitCreate(undefined as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect((await control("/_test/state")).invocations).toHaveLength(0);
  const box = await client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });
  expect((await box.inspect()).state).toBe("running");
  const preAborted = new AbortController();
  preAborted.abort(new Error("cancel before submission"));
  const before = (await control("/_test/state")).invocations.length;
  await expect(box.submitExec({ command: { kind: "argv", argv: ["fixture", "binary"] } }, { signal: preAborted.signal })).rejects.toBe(preAborted.signal.reason);
  expect((await control("/_test/state")).invocations.length).toBe(before);
  const file = Uint8Array.of(0, 255, 128, 42);
  await box.writeFile("/binary", file);
  expect(await box.readFile("/binary")).toEqual(file);
  await expect(box.readFile("/missing")).rejects.toMatchObject({ code: "NOT_FOUND", effect: "none" });
  await expect(box.readFile("/a/./b")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(box.readFile("/../escape")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(box.writeFile("/bad\0path", file)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(box.writeFile("/too-large", new Uint8Array(1_048_577))).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  const command = { kind: "argv" as const, argv: ["fixture", "binary"] };
  await control("/_test/seed", { submissionId: "*", action: "exec", command: { command, exitCode: 7, stdoutBase64: Buffer.from(file).toString("base64"), stderrBase64: Buffer.from([1, 2]).toString("base64") } });
  try { await box.exec({ command }); throw new Error("Expected nonzero exit"); }
  catch (error) {
    expect(error).toBeInstanceOf(NonzeroExitError);
    const result = (error as NonzeroExitError).result;
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toEqual(file);
    expect(result.stderr).toEqual(Uint8Array.of(1, 2));
  }
  await box.destroy();
  await client.close();
  expect(box.inspect()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
});

test("direct lost response is recovered by observation without replay; wrong scope is rejected", async () => {
  const { client, control } = await fixture();
  await control("/_test/seed", { submissionId: "*", action: "create", behavior: "lost_after_effect" });
  const operation = await client.sandboxes.submitCreate({ environment: DirectImage.prepared("fake-starter") });
  const reference = JSON.parse(JSON.stringify(operation.reference));
  expect(JSON.stringify(reference)).not.toContain(token);
  const recovered = await client.recover(reference);
  const box = await recovered.wait();
  expect((box as { id: string }).id).toStartWith("fake_sandbox_");
  const state = await control("/_test/state");
  expect(state.invocations.filter((x: { action: string }) => x.action === "create")).toHaveLength(1);
  await expect(client.recover({ ...reference, scope: { ...reference.scope, accountId: "other" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("fake provider registration binds recovery to the configured endpoint", async () => {
  const { client } = await fixture();
  const op = await client.sandboxes.submitCreate({ environment: DirectImage.prepared("fake-starter") });
  const otherDirectory = await mkdtemp(join(tmpdir(), "sandbar-sdk-other-"));
  const other = await startFakeProviderServer({ hostname: "127.0.0.1", port: 0, statePath: join(otherDirectory, "fake.json"), token, testMode: true });
  try {
    const otherClient = DirectSandbar.direct({ provider: await fakeProvider({ url: other.url.toString(), token }) });
    await expect(otherClient.recover(op.reference)).rejects.toMatchObject({ code: "FORBIDDEN" });
  } finally {
    other.stop(true);
    await rm(otherDirectory, { recursive: true, force: true });
  }
});

test("direct undiscoverable effect reports unknown without replay", async () => {
  const { client, control } = await fixture();
  await control("/_test/profile", { nativeIdempotency: { create: false, exec: false, destroy: false, writeFile: false }, discoveryBySubmission: false });
  await control("/_test/seed", { submissionId: "*", action: "create", behavior: "lost_after_effect" });
  const operation = await client.sandboxes.submitCreate({ environment: DirectImage.prepared("fake-starter") });
  await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
  const state = await control("/_test/state");
  expect(state.resources).toHaveLength(1);
  expect(state.invocations.filter((x: { action: string }) => x.action === "create")).toHaveLength(1);
});

test("closing a client interrupts pending direct observation without destroying compute", async () => {
  const { client, control } = await fixture();
  await control("/_test/seed", { submissionId: "*", action: "create", delayObservations: 100 });
  const operation = await client.sandboxes.submitCreate({ environment: DirectImage.prepared("fake-starter") });
  const waiting = operation.wait({ pollMs: 60 });
  await client.close();
  await expect(waiting).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  await expect(operation.observe()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  expect((await control("/_test/state")).resources).toHaveLength(1);
});

test("direct close during applied create preserves a recovery reference", async () => {
  const { url, control } = await fixture();
  const provider = await fakeProvider({ url, token });
  const create = provider.driver.create.bind(provider.driver);
  let entered!: () => void, release!: () => void;
  const dispatched = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  provider.driver.create = async input => { const result = await create(input); entered(); await gate; return result; };
  const client = DirectSandbar.direct({ provider });
  const pending = client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });
  await dispatched;
  await client.close();
  try { await pending; throw new Error("Expected uncertain close"); }
  catch (error) { expect(error).toBeInstanceOf(OutcomeUnknownError); expect((error as OutcomeUnknownError).reference.submissionId).toStartWith("sdk_"); }
  release();
  expect((await control("/_test/state")).resources).toHaveLength(1);
});

test("direct abort after effect retains its reference and cause", async () => {
  const { url, control } = await fixture();
  const provider = await fakeProvider({ url, token });
  const create = provider.driver.create.bind(provider.driver);
  let entered!: () => void, release!: () => void;
  const dispatched = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  provider.driver.create = async input => { const result = await create(input); entered(); await gate; return result; };
  const client = DirectSandbar.direct({ provider });
  const controller = new AbortController();
  const pending = client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") }, { signal: controller.signal });
  await dispatched;
  const reason = new Error("stop waiting");
  controller.abort(reason);
  try { await pending; throw new Error("Expected abort"); }
  catch (error) { expect(error).toBeInstanceOf(WaitAbortedError); expect((error as WaitAbortedError).reference.submissionId).toStartWith("sdk_"); expect((error as WaitAbortedError).cause).toBe(reason); }
  release();
  expect((await control("/_test/state")).resources).toHaveLength(1);
});

test("direct abort during image preparation does not dispatch create", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const prepare = provider.driver.prepare.bind(provider.driver);
  const create = provider.driver.create.bind(provider.driver);
  let entered!: () => void, release!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let creates = 0;
  provider.driver.prepare = async input => { entered(); await gate; return prepare(input); };
  provider.driver.create = async input => { creates++; return create(input); };
  const client = DirectSandbar.direct({ provider });
  const controller = new AbortController();
  const reason = new Error("cancel preparation");
  const pending = client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") }, { signal: controller.signal });
  await preparing;
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(creates).toBe(0);
});

test("direct submitCreate aborts stalled preflight before dispatch", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const capabilities = provider.driver.capabilities.bind(provider.driver);
  const create = provider.driver.create.bind(provider.driver);
  let entered!: () => void, release!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let creates = 0;
  provider.driver.capabilities = async scope => { entered(); await gate; return capabilities(scope); };
  provider.driver.create = async input => { creates++; return create(input); };
  const client = DirectSandbar.direct({ provider });
  const controller = new AbortController();
  const reason = new Error("stop preflight");
  const pending = client.sandboxes.submitCreate({ environment: DirectImage.prepared("fake-starter") }, { signal: controller.signal });
  await checking;
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(creates).toBe(0);
});

test("direct operation keeps a terminal result without provider discovery", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const client = DirectSandbar.direct({ provider });
  const operation = await client.sandboxes.submitCreate({ environment: DirectImage.prepared("fake-starter") });
  const box = await operation.wait();
  let observations = 0;
  provider.driver.observe = async () => { observations++; return null; };
  expect((await operation.observe())?.id).toBe(box.id);
  expect((await operation.wait()).id).toBe(box.id);
  expect(observations).toBe(0);
});

test("direct inspection rejects malformed provider state", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const client = DirectSandbar.direct({ provider });
  const box = await client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });
  provider.driver.inspect = async ref => ({ ref, state: "impossible", observedAt: "bad" }) as never;
  await expect(box.inspect()).rejects.toMatchObject({ code: "INVALID_RESPONSE", effect: "unknown" });
});

test("fake direct reads reject malformed base64 as an invalid provider response", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token, fetch: async (request, init) => {
    if (JSON.parse(String(init?.body)).kind === "readFile") return Response.json({ bytesBase64: "not base64" });
    return fetch(request, init);
  } });
  const client = DirectSandbar.direct({ provider });
  const box = await client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });
  await expect(box.readFile("/binary")).rejects.toMatchObject({ code: "INVALID_RESPONSE", effect: "unknown" });
});

test("abort ends direct and remote waits even when observation hangs", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const client = DirectSandbar.direct({ provider });
  const operation = await client.sandboxes.submitCreate({ environment: DirectImage.prepared("fake-starter") });
  provider.driver.observe = async () => new Promise(() => {});
  const directAbort = new AbortController();
  const directRef = await client.recover(operation.reference);
  const directWait = directRef.wait({ signal: directAbort.signal });
  setTimeout(() => directAbort.abort(), 10);
  await expect(directWait).rejects.toMatchObject({ name: "AbortError" });

  const projectId = "project_1";
  const queued = { id: "op_1", projectId, kind: "create", status: "queued", phase: "queued", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", effect: "none", recovery: [] };
  const fetcher: typeof fetch = async (_url, init) => init?.method === "POST" ? Response.json({ operation: queued }, { status: 202 }) : new Promise(() => {});
  const remote = RemoteSandbar.connect({ url: "https://sandbar.example/", token: "secret", projectId, fetch: fetcher });
  const remoteOp = await remote.sandboxes.submitCreate({ environment: RemoteImage.prepared("fake-starter") });
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
  const common = { version: 1 as const, mode: "direct" as const, invocationKey: "0199f92e-1234-7000-8000-000000000001", operationId: "op_1", submissionId: "sid_1", scope: provider.scope, sandbox };
  provider.driver.observe = async () => ({ status: "completed", effect: "applied", submissionId: "sid_1", value: { kind: "destroy", observation: { sandbox, computeStopped: false, retainedResources: [] } } });
  await expect((await client.recover({ ...common, kind: "destroy" })).observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
  provider.driver.observe = async () => ({ status: "completed", effect: "applied", submissionId: "sid_1", value: { kind: "file_write", observation: { sandbox, path: "/data", bytesWritten: 1, complete: false } } });
  await expect((await client.recover({ ...common, kind: "file_write", file: { path: "/data", bytes: 2 } })).observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
  await expect(client.recover({ ...common, kind: "file_write", file: { path: "/../escape", bytes: 2 } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(client.recover({ ...common, kind: "file_write", file: { path: "/a/./b", bytes: 2 } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(client.recover({ ...common, kind: "destroy", file: { path: "/data", bytes: 2 } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  provider.driver.observe = async () => ({ status: "completed", effect: "applied", submissionId: "sid_1", value: { kind: "execution", observation: { ref: { scope: provider.scope, nativeId: "fake_execution_1", kind: "execution" }, sandbox, completed: true, exitCode: null, stdoutBase64: "", stderrBase64: "", observedAt: "2026-01-01T00:00:00Z" } } });
  await expect((await client.recover({ ...common, kind: "exec", maxOutputBytes: 1024 })).observe()).rejects.toBeInstanceOf(NoExitCodeError);
});

test("direct imported recovery strips nested secrets and ignores later caller changes", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  const client = DirectSandbar.direct({ provider });
  const sandbox = { scope: provider.scope, nativeId: "fake_sandbox_1", kind: "sandbox" as const };
  const imported = JSON.parse(JSON.stringify({ version: 1, mode: "direct", kind: "destroy", invocationKey: "0199f92e-1234-7000-8000-000000000001", operationId: "op_1", submissionId: "sid_1", scope: provider.scope, sandbox }));
  imported.scope.secret = "scope-secret";
  imported.sandbox.scope.token = "sandbox-secret";
  let observedScope: unknown;
  provider.driver.observe = async input => {
    observedScope = input.scope;
    return { status: "rejected", effect: "none", error: { code: "not_found", message: "missing", effect: "none", retry: "never" } };
  };
  const recovered = await client.recover(imported);
  expect(JSON.stringify(recovered.reference)).not.toContain("secret");
  imported.scope.connectionId = "changed";
  imported.sandbox.scope.connectionId = "changed";
  try { recovered.reference.scope!.connectionId = "changed"; } catch { /* frozen references reject caller mutation */ }
  await expect(recovered.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
  expect(observedScope).toEqual(provider.scope);
  expect(recovered.reference.sandbox?.scope).toEqual(provider.scope);
});

test("direct observation failure retains its recovery reference", async () => {
  const { url } = await fixture();
  const provider = await fakeProvider({ url, token });
  provider.driver.observe = async () => { throw new TypeError("provider response lost"); };
  const client = DirectSandbar.direct({ provider });
  const reference: RecoveryReference = {
    version: 1, mode: "direct", kind: "create",
    invocationKey: "0199f92e-1234-7000-8000-000000000001",
    operationId: "op_1", submissionId: "sid_1", scope: provider.scope,
  };
  const operation = await client.recover(reference);
  await expect(operation.observe()).rejects.toMatchObject({
    code: "OUTCOME_UNKNOWN", reference: operation.reference,
  });
});

test("remote lost acceptance is resolved by invocation lookup under one key", async () => {
  let posts = 0;
  let key = "";
  const projectId = "project_1";
  const base = { id: "op_1", projectId, kind: "create", sandboxId: "box_1", status: "succeeded", phase: "done", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", effect: "applied", recovery: [], result: { kind: "create", sandboxId: "box_1" } };
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") { posts++; key = new Headers(init.headers).get("Idempotency-Key") ?? ""; throw new TypeError("response lost"); }
    if (path.includes("/invocations/")) return Response.json(base);
    if (path.includes("/operations/")) return Response.json(base);
    if (path.includes("/sandboxes/box_1")) return Response.json({ id: "box_1", projectId, connectionId: "conn_1", desiredState: "running", observedState: "running", revision: 1, environment: { kind: "prepared", imageId: "fake-starter" }, network: { policy: "blocked" }, labels: {} });
    throw new Error(`Unexpected path: ${path}`);
  };
  const client = RemoteSandbar.connect({ url: "https://sandbar.example/", token: "secret", projectId, fetch: fetcher });
  await expect(client.sandboxes.submitCreate({} as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(posts).toBe(0);
  const operation = await client.sandboxes.submitCreate({ environment: RemoteImage.prepared("fake-starter") });
  const box = await operation.wait();
  expect(box.id).toBe("box_1");
  const preAborted = new AbortController();
  preAborted.abort(new Error("cancel before submission"));
  await expect(box.submitExec({ command: { kind: "argv", argv: ["fixture", "binary"] } }, { signal: preAborted.signal })).rejects.toBe(preAborted.signal.reason);
  await expect(client.sandboxes.submitCreate({ environment: RemoteImage.prepared("fake-starter") }, { signal: preAborted.signal })).rejects.toBe(preAborted.signal.reason);
  await expect(box.submitExec({ command: { kind: "argv", argv: [] } })).rejects.toThrow();
  await expect(box.readFile("/a/./b")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(box.writeFile("/too-large", new Uint8Array(1_048_577))).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  expect(posts).toBe(1);
  expect(operation.reference.invocationKey).toBe(key);
  expect(JSON.stringify(operation.reference)).not.toContain("secret");
  await expect(client.recover({ ...operation.reference, operationId: "op_other" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  await expect(RemoteSandbar.connect({ url: "https://other.example/", token: "secret", projectId, fetch: fetcher }).recover(operation.reference)).rejects.toMatchObject({ code: "FORBIDDEN" });
  const imported = structuredClone(operation.reference);
  const recovered = await client.recover(imported);
  imported.service!.projectId = "other";
  try { recovered.reference.service!.projectId = "other"; } catch { /* frozen references reject caller mutation */ }
  expect((await recovered.wait() as { id: string }).id).toBe("box_1");
  expect(recovered.reference.service?.projectId).toBe(projectId);
  await expect(client.recover({ ...operation.reference, service: { ...operation.reference.service!, secret: "hidden" } } as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

test("remote create carries its recovery reference through post-admission read failures", async () => {
  for (const failure of ["poll", "sandbox"] as const) {
    const projectId = "project_1";
    const operation = { id: "op_1", projectId, kind: "create", sandboxId: "box_1", status: "succeeded", phase: "done", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", effect: "applied", recovery: [], result: { kind: "create", sandboxId: "box_1" } };
    const box = { id: "box_1", projectId, connectionId: "conn_1", desiredState: "running", observedState: "running", revision: 1, environment: { kind: "prepared", imageId: "fake-starter" }, network: { policy: "blocked" }, labels: {} };
    let posts = 0;
    let failOnce = true;
    const fetcher: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST") { posts++; return Response.json({ operation }, { status: 202 }); }
      if (path.includes("/invocations/")) {
        if (failure === "poll" && failOnce) { failOnce = false; throw new TypeError("poll disconnected"); }
        return Response.json(operation);
      }
      if (path.endsWith("/sandboxes/box_1")) {
        if (failure === "sandbox" && failOnce) { failOnce = false; throw new TypeError("sandbox read disconnected"); }
        return Response.json(box);
      }
      throw new Error(`Unexpected path: ${path}`);
    };
    const client = RemoteSandbar.connect({ url: "https://sandbar.example/", token: "secret", projectId, fetch: fetcher });
    let reference: OutcomeUnknownError["reference"] | undefined;
    try { await client.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") }); }
    catch (error) { expect(error).toBeInstanceOf(OutcomeUnknownError); reference = (error as OutcomeUnknownError).reference; }
    expect(reference?.operationId).toBe("op_1");
    const recovered = await client.recover(reference!);
    expect((await recovered.wait() as { id: string }).id).toBe("box_1");
    expect(posts).toBe(1);
  }
});

test("remote exec carries its recovery reference through a failed execution read", async () => {
  const projectId = "project_1";
  const common = { projectId, status: "succeeded", phase: "done", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", effect: "applied", recovery: [] };
  const createOperation = { ...common, id: "op_create", kind: "create", sandboxId: "box_1", result: { kind: "create", sandboxId: "box_1" } };
  const execOperation = { ...common, id: "op_exec", kind: "exec", sandboxId: "box_1", executionId: "exec_1", result: { kind: "exec", executionId: "exec_1" } };
  const execution = { id: "exec_1", projectId, sandboxId: "box_1", operationId: "op_exec", status: "completed", exitCode: 0, outputAvailability: "captured", capturedBytes: 0, stdoutBase64: "", stderrBase64: "" };
  let creates = 0, execs = 0, failRead = true;
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    const path = target.pathname;
    if (init?.method === "POST" && path.endsWith("/sandboxes")) { creates++; return Response.json({ operation: createOperation }, { status: 202 }); }
    if (init?.method === "POST" && path.endsWith("/executions")) { execs++; return Response.json({ operation: execOperation, execution }, { status: 202 }); }
    if (path.includes("/invocations/")) return Response.json(target.searchParams.get("kind") === "exec" ? execOperation : createOperation);
    if (path.endsWith("/sandboxes/box_1")) return Response.json({ id: "box_1", projectId, connectionId: "conn_1", desiredState: "running", observedState: "running", revision: 1, environment: { kind: "prepared", imageId: "fake-starter" }, network: { policy: "blocked" }, labels: {} });
    if (path.endsWith("/executions/exec_1")) {
      if (failRead) { failRead = false; throw new TypeError("execution read disconnected"); }
      return Response.json(execution);
    }
    throw new Error(`Unexpected path: ${path}`);
  };
  const client = RemoteSandbar.connect({ url: "https://sandbar.example/", token: "secret", projectId, fetch: fetcher });
  const box = await client.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") });
  let reference: OutcomeUnknownError["reference"] | undefined;
  try { await box.exec({ command: { kind: "argv", argv: ["echo", "ok"] } }); }
  catch (error) { expect(error).toBeInstanceOf(OutcomeUnknownError); reference = (error as OutcomeUnknownError).reference; }
  expect(reference?.operationId).toBe("op_exec");
  const recovered = await client.recover(reference!);
  expect((await recovered.wait() as { exitCode: number }).exitCode).toBe(0);
  expect(creates).toBe(1);
  expect(execs).toBe(1);
});

test("remote create rejects disagreement between operation and result sandbox IDs", async () => {
  const projectId = "project_1";
  const mismatched = { id: "op_1", projectId, kind: "create", sandboxId: "box_other", status: "succeeded", phase: "done", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", effect: "applied", recovery: [], result: { kind: "create", sandboxId: "box_1" } };
  const fetcher: typeof fetch = async (_url, init) => init?.method === "POST" ? Response.json({ operation: mismatched }, { status: 202 }) : Response.json(mismatched);
  const client = RemoteSandbar.connect({ url: "https://sandbar.example/", token: "secret", projectId, fetch: fetcher });
  let reference: RecoveryReference | undefined;
  try {
    await client.sandboxes.submitCreate({ environment: RemoteImage.prepared("fake-starter") });
    throw new Error("Expected an uncertain admission");
  } catch (error) {
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    reference = (error as OutcomeUnknownError).reference;
  }
  await expect(client.recover(reference!)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

test("remote file reads stop at the SDK limit and cancel the response stream", async () => {
  const projectId = "project_1";
  const operation = { id: "op_1", projectId, kind: "create", sandboxId: "box_1", status: "succeeded", phase: "done", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", effect: "applied", recovery: [], result: { kind: "create", sandboxId: "box_1" } };
  let cancelled = 0;
  let declaredLength = false;
  const stream = () => new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(600_000)); controller.enqueue(new Uint8Array(600_000)); },
    cancel() { cancelled++; }
  });
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") return Response.json({ operation }, { status: 202 });
    if (path.includes("/invocations/")) return Response.json(operation);
    if (path.endsWith("/sandboxes/box_1")) return Response.json({ id: "box_1", projectId, connectionId: "conn_1", desiredState: "running", observedState: "running", revision: 1, environment: { kind: "prepared", imageId: "fake-starter" }, network: { policy: "blocked" }, labels: {} });
    if (path.endsWith("/files")) return new Response(stream(), { headers: { "content-type": "application/octet-stream", ...(declaredLength ? { "content-length": "1200000" } : {}) } });
    throw new Error(`Unexpected path: ${path}`);
  };
  const client = RemoteSandbar.connect({ url: "https://sandbar.example/", token: "secret", projectId, fetch: fetcher });
  const box = await client.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") });
  await expect(box.readFile("/large")).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  expect(cancelled).toBe(1);
  declaredLength = true;
  await expect(box.readFile("/large")).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  expect(cancelled).toBe(2);
});

test("remote close after service admission preserves the invocation reference", async () => {
  let started!: () => void, release!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let key = "";
  const projectId = "project_1";
  const operation = { id: "op_1", projectId, kind: "create", status: "queued", phase: "queued", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", effect: "none", recovery: [] };
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method !== "POST") throw new Error("Unexpected lookup");
    key = new Headers(init.headers).get("Idempotency-Key") ?? "";
    started();
    await gate;
    return Response.json({ operation }, { status: 202 });
  };
  const client = RemoteSandbar.connect({ url: "https://sandbar.example/", token: "secret", projectId, fetch: fetcher });
  const pending = client.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") });
  await dispatched;
  await client.close();
  try { await pending; throw new Error("Expected uncertain close"); }
  catch (error) { expect(error).toBeInstanceOf(OutcomeUnknownError); expect((error as OutcomeUnknownError).reference.invocationKey).toBe(key); }
  release();
});

test("remote abort after admission retains its invocation reference and cause", async () => {
  let started!: () => void, release!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let key = "";
  const projectId = "project_1";
  const operation = { id: "op_1", projectId, kind: "create", status: "queued", phase: "queued", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", effect: "none", recovery: [] };
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method !== "POST") throw new Error("Unexpected lookup");
    key = new Headers(init.headers).get("Idempotency-Key") ?? "";
    started();
    await gate;
    return Response.json({ operation }, { status: 202 });
  };
  const client = RemoteSandbar.connect({ url: "https://sandbar.example/", token: "secret", projectId, fetch: fetcher });
  const controller = new AbortController();
  const pending = client.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") }, { signal: controller.signal });
  await dispatched;
  const reason = new Error("stop waiting");
  controller.abort(reason);
  try { await pending; throw new Error("Expected abort"); }
  catch (error) { expect(error).toBeInstanceOf(WaitAbortedError); expect((error as WaitAbortedError).reference.invocationKey).toBe(key); expect((error as WaitAbortedError).cause).toBe(reason); }
  release();
});

test("remote refuses bearer transport over non-loopback HTTP", () => {
  expect(() => RemoteSandbar.connect({ url: "http://sandbar.example/", token: "secret", projectId: "project_1" })).toThrow();
  expect(() => RemoteSandbar.connect({ url: "http://127.0.0.1:8788/", token: "secret", projectId: "project_1" })).not.toThrow();
});

test("remote recovery rejects an incomplete execution observation", async () => {
  const projectId = "project_1";
  const operation = { id: "op_1", projectId, kind: "exec", sandboxId: "box_1", executionId: "exec_1", status: "succeeded", phase: "done", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", effect: "applied", recovery: [], result: { kind: "exec", executionId: "exec_1" } };
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("/invocations/")) return Response.json(operation);
    if (path.endsWith("/executions/exec_1")) return Response.json({ id: "exec_1", projectId, sandboxId: "box_1", operationId: "op_1", status: "unknown", outputAvailability: "captured", capturedBytes: 0, stdoutBase64: "", stderrBase64: "" });
    throw new Error(`Unexpected path: ${path}`);
  };
  const client = RemoteSandbar.connect({ url: "https://sandbar.example/", token: "secret", projectId, fetch: fetcher });
  const reference = { version: 1 as const, mode: "remote" as const, kind: "exec" as const, invocationKey: "0199f92e-1234-7000-8000-000000000001", operationId: "op_1", resourceId: "box_1", service: { url: "https://sandbar.example/", projectId } };
  const recovered = await client.recover(reference);
  await expect(recovered.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
});

test("remote recovery requires confirmed destroy and exact file receipts", async () => {
  const projectId = "project_1";
  const base = { id: "op_1", projectId, sandboxId: "box_1", status: "succeeded", phase: "done", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", effect: "applied", recovery: [] };
  let operation: unknown = { ...base, kind: "destroy", result: { kind: "destroy", computeStopped: false, retainedResources: [] } };
  const fetcher: typeof fetch = async () => Response.json(operation);
  const client = RemoteSandbar.connect({ url: "https://sandbar.example/", token: "secret", projectId, fetch: fetcher });
  const common = { version: 1 as const, mode: "remote" as const, invocationKey: "0199f92e-1234-7000-8000-000000000001", operationId: "op_1", resourceId: "box_1", service: { url: "https://sandbar.example/", projectId } };
  await expect((await client.recover({ ...common, kind: "destroy" })).observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
  operation = { ...base, kind: "file_write", effect: "partial", result: { kind: "file_write", receipt: { path: "/data", bytesWritten: 1, complete: false, effect: "partial" } } };
  await expect((await client.recover({ ...common, kind: "file_write", file: { path: "/data", bytes: 2 } })).observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
});

test("remote completed execution without an exit code has a distinct outcome", async () => {
  const projectId = "project_1";
  const operation = { id: "op_1", projectId, kind: "exec", sandboxId: "box_1", status: "succeeded", phase: "done", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", effect: "applied", recovery: [], result: { kind: "exec", executionId: "exec_1" } };
  const fetcher: typeof fetch = async (url) => new URL(String(url)).pathname.includes("/invocations/")
    ? Response.json(operation)
    : Response.json({ id: "exec_1", projectId, sandboxId: "box_1", operationId: "op_1", status: "completed", exitCode: null, outputAvailability: "captured", capturedBytes: 0, stdoutBase64: "", stderrBase64: "" });
  const client = RemoteSandbar.connect({ url: "https://sandbar.example/", token: "secret", projectId, fetch: fetcher });
  const reference = { version: 1 as const, mode: "remote" as const, kind: "exec" as const, invocationKey: "0199f92e-1234-7000-8000-000000000001", operationId: "op_1", resourceId: "box_1", service: { url: "https://sandbar.example/", projectId } };
  await expect((await client.recover(reference)).observe()).rejects.toBeInstanceOf(NoExitCodeError);
});
