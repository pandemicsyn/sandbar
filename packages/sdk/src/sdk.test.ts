import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider } from "@sandbar/provider-fake/client";
import { startFakeProviderServer } from "@sandbar/provider-fake/server";
import { Image as DirectImage, Sandbar as DirectSandbar, NonzeroExitError, NoExitCodeError, OutcomeUnknownError } from "./direct";
import { Image as RemoteImage, Sandbar as RemoteSandbar } from "./remote";

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

test("direct resource flow preserves binary files and nonzero output", async () => {
  const { client, control } = await fixture();
  const box = await client.sandboxes.create({ environment: DirectImage.prepared("fake-starter") });
  expect((await box.inspect()).state).toBe("running");
  const file = Uint8Array.of(0, 255, 128, 42);
  await box.writeFile("/binary", file);
  expect(await box.readFile("/binary")).toEqual(file);
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
  release();
  try { await pending; throw new Error("Expected uncertain close"); }
  catch (error) { expect(error).toBeInstanceOf(OutcomeUnknownError); expect((error as OutcomeUnknownError).reference.submissionId).toStartWith("sdk_"); }
  expect((await control("/_test/state")).resources).toHaveLength(1);
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
  await expect(client.recover({ ...common, kind: "destroy", file: { path: "/data", bytes: 2 } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  provider.driver.observe = async () => ({ status: "completed", effect: "applied", submissionId: "sid_1", value: { kind: "execution", observation: { ref: { scope: provider.scope, nativeId: "fake_execution_1", kind: "execution" }, sandbox, completed: true, exitCode: null, stdoutBase64: "", stderrBase64: "", observedAt: "2026-01-01T00:00:00Z" } } });
  await expect((await client.recover({ ...common, kind: "exec", maxOutputBytes: 1024 })).observe()).rejects.toBeInstanceOf(NoExitCodeError);
});

test("remote lost acceptance is resolved by invocation lookup under one key", async () => {
  let posts = 0;
  let key = "";
  const projectId = "project_1";
  const base = { id: "op_1", projectId, kind: "create", status: "succeeded", phase: "done", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", effect: "applied", recovery: [], result: { kind: "create", sandboxId: "box_1" } };
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") { posts++; key = new Headers(init.headers).get("Idempotency-Key") ?? ""; throw new TypeError("response lost"); }
    if (path.includes("/invocations/")) return Response.json(base);
    if (path.includes("/operations/")) return Response.json(base);
    if (path.includes("/sandboxes/box_1")) return Response.json({ id: "box_1", projectId, connectionId: "conn_1", desiredState: "running", observedState: "running", revision: 1, environment: { kind: "prepared", imageId: "fake-starter" }, network: { policy: "blocked" }, labels: {} });
    throw new Error(`Unexpected path: ${path}`);
  };
  const client = RemoteSandbar.connect({ url: "https://sandbar.example/", token: "secret", projectId, fetch: fetcher });
  const operation = await client.sandboxes.submitCreate({ environment: RemoteImage.prepared("fake-starter") });
  const box = await operation.wait();
  expect(box.id).toBe("box_1");
  await expect(box.writeFile("/too-large", new Uint8Array(1_048_577))).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  expect(posts).toBe(1);
  expect(operation.reference.invocationKey).toBe(key);
  expect(JSON.stringify(operation.reference)).not.toContain("secret");
  await expect(client.recover({ ...operation.reference, operationId: "op_other" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  await expect(RemoteSandbar.connect({ url: "https://other.example/", token: "secret", projectId, fetch: fetcher }).recover(operation.reference)).rejects.toMatchObject({ code: "FORBIDDEN" });
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
  release();
  try { await pending; throw new Error("Expected uncertain close"); }
  catch (error) { expect(error).toBeInstanceOf(OutcomeUnknownError); expect((error as OutcomeUnknownError).reference.invocationKey).toBe(key); }
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
  operation = { ...base, kind: "file_write", result: { kind: "file_write", receipt: { path: "/data", bytesWritten: 1, complete: false, effect: "partial" } } };
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
