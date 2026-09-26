import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@sandbar/core";
import { startFakeProviderServer } from "@sandbar/provider-fake";
import { openDomainRuntime } from "./runtime";

const transportToken = "fake-transport-test-token";
let server: Awaited<ReturnType<typeof startFakeProviderServer>> | undefined;
let directory: string | undefined;
afterEach(async () => { server?.stop(true); server = undefined; if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

test("runtime rejects remote fake provider endpoints before opening storage", async () => {
  await expect(openDomainRuntime({ databaseUrl: ":memory:", keyFile: "/missing", setupTokenFile: "/missing", fakeProviderUrl: "http://provider.example", fakeProviderToken: transportToken })).rejects.toThrow("loopback");
});

test("API persists ambiguous create and exec, then observes each once after restart", async () => {
  directory = await mkdtemp(join(tmpdir(), "sandbar-domain-"));
  const keyFile = join(directory, "key"), setupTokenFile = join(directory, "setup"), databaseUrl = join(directory, "control.sqlite");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32))); await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "test-setup-token-with-long-random-content"); await chmod(setupTokenFile, 0o600);
  server = await startFakeProviderServer({ hostname: "127.0.0.1", port: 0, statePath: join(directory, "fake.json"), token: transportToken, testMode: true });
  const config = { databaseUrl, keyFile, setupTokenFile, fakeProviderUrl: server.url.toString(), fakeProviderToken: transportToken, startRunner: false };
  let runtime = await openDomainRuntime(config);
  const json = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const response = await runtime.app.request(path, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { response, value: await response.json() as any };
  };
  const control = async (path: string, body?: unknown) => {
    const response = await fetch(new URL(path, server!.url), { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${transportToken}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return response.json() as Promise<any>;
  };
  try {
    const setup = await json("/v1/setup", "POST", { setupToken: "test-setup-token-with-long-random-content" });
    expect(setup.response.status).toBe(201);
    const bearer = { Authorization: `Bearer ${setup.value.token}` };
    expect(setup.response.headers.get("set-cookie")).toContain("HttpOnly");
    const project = (await json("/v1/projects", "POST", { name: "Demo" }, bearer)).value;
    for (const query of ["limit=NaN", "limit=1.5", "limit=0", `cursor=${Buffer.from("{}").toString("base64url")}`, `cursor=${Buffer.from(JSON.stringify({ createdAt: 1, id: 3 })).toString("base64url")}`]) {
      expect((await json(`/v1/projects/${project.id}/sandboxes?${query}`, "GET", undefined, bearer)).response.status).toBe(400);
    }
    const connection = (await json(`/v1/projects/${project.id}/provider-connections`, "POST", { provider: "fake", name: "Local" }, bearer)).value;
    expect(connection.encryptedCredentials).toBeUndefined();
    expect((await json(`/v1/projects/${project.id}/provider-connections/${connection.id}/verify`, "POST", {}, bearer)).value.status).toBe("verified");
    const createKey = Bun.randomUUIDv7();
    const create = await json(`/v1/projects/${project.id}/sandboxes`, "POST", { environment: { kind: "prepared", imageId: "fake-starter" }, connectionId: connection.id }, { ...bearer, "Idempotency-Key": createKey });
    expect(create.response.status).toBe(202);
    const opId = create.value.operation.id, boxId = create.value.operation.sandboxId;
    const createLookup = `/v1/projects/${project.id}/invocations/${createKey}?kind=create`;
    expect((await json(createLookup, "GET", undefined, bearer)).value.id).toBe(opId);
    expect((await json(createLookup)).response.status).toBe(401);
    expect((await json(`/v1/projects/${project.id}/invocations/${createKey}?kind=exec&sandboxId=${boxId}`, "GET", undefined, bearer)).response.status).toBe(404);
    const otherProject = (await json("/v1/projects", "POST", { name: "Other" }, bearer)).value;
    expect((await json(`/v1/projects/${otherProject.id}/invocations/${createKey}?kind=create`, "GET", undefined, bearer)).response.status).toBe(404);
    const op = await runtime.store.getOperation(project.id, opId);
    await control("/_test/seed", { submissionId: op!.provider_token, action: "create", behavior: "lost_after_effect" });
    await runtime.runner.tick();
    expect((await runtime.store.getOperation(project.id, opId))?.status).toBe("unknown");
    expect((await json(`/v1/projects/${project.id}/operations/${opId}`, "GET", undefined, bearer)).value.recovery).toEqual(["check_again"]);
    await runtime.close();
    runtime = await openDomainRuntime(config);
    expect((await json(`/v1/projects/${project.id}/operations/${opId}/reconcile`, "POST", {}, bearer)).response.status).toBe(200);
    await runtime.runner.tick();
    expect((await json(`/v1/projects/${project.id}/operations/${opId}`, "GET", undefined, bearer)).value.status).toBe("succeeded");
    expect((await json(`/v1/projects/${project.id}/sandboxes/${boxId}`, "GET", undefined, bearer)).value.observedState).toBe("running");
    const fleet = await json(`/v1/projects/${project.id}/sandboxes?state=running&q=${boxId}`, "GET", undefined, bearer);
    expect(fleet.value.items).toHaveLength(1);

    const execKey = Bun.randomUUIDv7();
    const exec = await json(`/v1/projects/${project.id}/sandboxes/${boxId}/executions`, "POST", { command: { kind: "argv", argv: ["fixture", "hello"] } }, { ...bearer, "Idempotency-Key": execKey });
    expect(exec.response.status).toBe(202);
    expect((await json(`/v1/projects/${project.id}/invocations/${execKey}?kind=exec&sandboxId=${boxId}`, "GET", undefined, bearer)).value.id).toBe(exec.value.operation.id);
    const execOp = await runtime.store.getOperation(project.id, exec.value.operation.id);
    expect(execOp!.request_json).toContain("encryptedRequest");
    expect(execOp!.request_json).not.toContain("fixture");
    await control("/_test/seed", { submissionId: execOp!.provider_token, action: "exec", behavior: "lost_after_effect", command: { command: { kind: "argv", argv: ["fixture", "hello"] }, exitCode: 7, stdoutBase64: Buffer.from("hello from fake").toString("base64") } });
    await runtime.runner.tick();
    expect((await runtime.store.getOperation(project.id, exec.value.operation.id))?.status).toBe("unknown");
    expect((await runtime.store.getOperation(project.id, exec.value.operation.id))?.request_json).not.toContain("encryptedRequest");
    await json(`/v1/projects/${project.id}/operations/${exec.value.operation.id}/reconcile`, "POST", {}, bearer);
    await runtime.runner.tick();
    const execution = (await json(`/v1/projects/${project.id}/executions/${exec.value.execution.id}`, "GET", undefined, bearer)).value;
    expect(execution.exitCode).toBe(7);
    expect(execution.stdout).toBe("hello from fake");
    expect((await runtime.store.getOperation(project.id, exec.value.operation.id))?.result_json).not.toContain("hello from fake");
    const bytes = Uint8Array.from([0, 255, 1]);
    const write = await runtime.app.request(`/v1/projects/${project.id}/sandboxes/${boxId}/files?path=/data/blob`, { method: "PUT", headers: { ...bearer, "Idempotency-Key": Bun.randomUUIDv7() }, body: bytes });
    expect(write.status).toBe(200);
    expect((await write.json() as any).bytesWritten).toBe(bytes.length);
    const read = await runtime.app.request(`/v1/projects/${project.id}/sandboxes/${boxId}/files?path=/data/blob`, { headers: bearer });
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
    await control("/_test/seed", { submissionId: "*", action: "file_write", behavior: "lost_after_effect" });
    const lostWriteKey = Bun.randomUUIDv7();
    const lostWrite = await runtime.app.request(`/v1/projects/${project.id}/sandboxes/${boxId}/files?path=/data/lost`, { method: "PUT", headers: { ...bearer, "Idempotency-Key": lostWriteKey }, body: bytes });
    expect(lostWrite.status).toBe(202);
    const lostOperation = (await lostWrite.json() as any).operation;
    expect((await json(`/v1/projects/${project.id}/invocations/${lostWriteKey}?kind=file_write&sandboxId=${boxId}`, "GET", undefined, bearer)).value.id).toBe(lostOperation.id);
    expect(lostOperation.status).toBe("unknown");
    await json(`/v1/projects/${project.id}/operations/${lostOperation.id}/reconcile`, "POST", {}, bearer);
    await runtime.runner.tick();
    const recoveredWrite = (await json(`/v1/projects/${project.id}/operations/${lostOperation.id}`, "GET", undefined, bearer)).value;
    expect(recoveredWrite.status).toBe("succeeded");
    expect(recoveredWrite.result.receipt.bytesWritten).toBe(bytes.length);
    const fakeState = await control("/_test/state");
    expect(fakeState.invocations.filter((item: any) => item.action === "create")).toHaveLength(1);
    expect(fakeState.invocations.filter((item: any) => item.action === "exec")).toHaveLength(1);
    expect(fakeState.invocations.filter((item: any) => item.action === "file_write")).toHaveLength(2);
  } finally { await runtime.close(); }
});

test("single-use setup, hashed credentials, session CSRF and logout", async () => {
  directory = await mkdtemp(join(tmpdir(), "sandbar-auth-"));
  const keyFile = join(directory, "key"), setupTokenFile = join(directory, "setup");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32))); await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-single-use-setup-token-for-test"); await chmod(setupTokenFile, 0o600);
  const runtime = await openDomainRuntime({ databaseUrl: join(directory, "control.sqlite"), keyFile, setupTokenFile, fakeProviderUrl: "http://127.0.0.1:8789", fakeProviderToken: transportToken, startRunner: false });
  try {
    const setupRequest = () => runtime.app.request("http://localhost/v1/setup", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost" }, body: JSON.stringify({ setupToken: "long-single-use-setup-token-for-test" }) });
    const results = await Promise.all([setupRequest(), setupRequest()]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    const success = results.find(r => r.status === 201)!;
    const { token, csrfToken } = await success.json() as { token: string; csrfToken: string };
    const cookie = success.headers.get("set-cookie")!.split(";")[0];
    expect(await runtime.store.authenticateBearer(token)).toBe(false);
    expect(await runtime.store.authenticateBearer(await sha256(token))).toBe(true);
    const projectBody = JSON.stringify({ name: "Private" });
    const mutate = (headers: Record<string, string>) => runtime.app.request("http://localhost/v1/projects", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, ...headers }, body: projectBody });
    expect((await mutate({ Origin: "http://localhost" })).status).toBe(403);
    expect((await mutate({ Origin: "http://evil.invalid", "X-CSRF-Token": csrfToken })).status).toBe(403);
    expect((await mutate({ Origin: "http://localhost", "X-CSRF-Token": csrfToken })).status).toBe(201);
    const refreshed = await runtime.app.request("http://localhost/v1/session", { headers: { Cookie: cookie } });
    expect(refreshed.status).toBe(200);
    const nextCsrf = (await refreshed.json() as { csrfToken: string }).csrfToken;
    expect(nextCsrf).not.toBe(csrfToken);
    expect((await mutate({ Origin: "http://localhost", "X-CSRF-Token": csrfToken })).status).toBe(403);
    const logout = await runtime.app.request("http://localhost/v1/sessions/logout", { method: "POST", headers: { Cookie: cookie, Origin: "http://localhost", "X-CSRF-Token": nextCsrf } });
    expect(logout.status).toBe(204);
    expect((await runtime.app.request("http://localhost/v1/session", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await runtime.app.request("http://localhost/v1/projects", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  } finally { await runtime.close(); }
});

test("hard process kill after submission marker never replays create", async () => {
  directory = await mkdtemp(join(tmpdir(), "sandbar-crash-"));
  const keyFile = join(directory, "key"), setupTokenFile = join(directory, "setup"), databaseUrl = join(directory, "control.sqlite");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32))); await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-crash-test-setup-token-content"); await chmod(setupTokenFile, 0o600);
  server = await startFakeProviderServer({ hostname: "127.0.0.1", port: 0, statePath: join(directory, "fake.json"), token: transportToken, testMode: true });
  const config = { databaseUrl, keyFile, setupTokenFile, fakeProviderUrl: server.url.toString(), fakeProviderToken: transportToken, startRunner: false };
  let runtime = await openDomainRuntime(config);
  let projectId: string, operationId: string;
  try {
    const setup = await runtime.app.request("/v1/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setupToken: "long-crash-test-setup-token-content" }) });
    const token = (await setup.json() as any).token;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const project = await runtime.app.request("/v1/projects", { method: "POST", headers, body: JSON.stringify({ name: "Crash" }) });
    projectId = (await project.json() as any).id;
    const connection = await runtime.app.request(`/v1/projects/${projectId}/provider-connections`, { method: "POST", headers, body: JSON.stringify({ provider: "fake", name: "Fake" }) });
    const connectionId = (await connection.json() as any).id;
    await runtime.app.request(`/v1/projects/${projectId}/provider-connections/${connectionId}/verify`, { method: "POST", headers, body: "{}" });
    const admission = await runtime.app.request(`/v1/projects/${projectId}/sandboxes`, { method: "POST", headers: { ...headers, "Idempotency-Key": Bun.randomUUIDv7() }, body: JSON.stringify({ environment: { kind: "prepared", imageId: "fake-starter" }, connectionId }) });
    expect(admission.status).toBe(202);
    operationId = (await admission.json() as any).operation.id;
  } finally { await runtime.close(); }

  const child = Bun.spawn([process.execPath, join(import.meta.dir, "test-support/crash-after-submission.ts"), databaseUrl], { cwd: join(import.meta.dir, "../../.."), stdout: "ignore", stderr: "pipe" });
  const exitCode = await child.exited;
  expect(exitCode).not.toBe(0);
  runtime = await openDomainRuntime(config);
  try {
    expect(await runtime.runner.tick()).toBe(true);
    const op = await runtime.store.getOperation(projectId!, operationId!);
    expect(op?.status).toBe("unknown");
    const stateResponse = await fetch(new URL("/_test/state", server.url), { headers: { Authorization: `Bearer ${transportToken}` } });
    const state = await stateResponse.json() as { invocations: unknown[] };
    expect(state.invocations).toHaveLength(0);
  } finally { await runtime.close(); }
});
