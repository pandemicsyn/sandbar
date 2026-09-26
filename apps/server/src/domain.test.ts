import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeProviderServer } from "@sandbar/provider-fake";
import { openDomainRuntime } from "./runtime";

const transportToken = "fake-transport-test-token";
let server: Awaited<ReturnType<typeof startFakeProviderServer>> | undefined;
let directory: string | undefined;
afterEach(async () => { server?.stop(true); server = undefined; if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

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
    const connection = (await json(`/v1/projects/${project.id}/provider-connections`, "POST", { provider: "fake", name: "Local" }, bearer)).value;
    expect(connection.encryptedCredentials).toBeUndefined();
    expect((await json(`/v1/projects/${project.id}/provider-connections/${connection.id}/verify`, "POST", {}, bearer)).value.status).toBe("verified");
    const create = await json(`/v1/projects/${project.id}/sandboxes`, "POST", { environment: { kind: "prepared", imageId: "fake-starter" }, connectionId: connection.id }, { ...bearer, "Idempotency-Key": Bun.randomUUIDv7() });
    expect(create.response.status).toBe(202);
    const opId = create.value.operation.id, boxId = create.value.operation.sandboxId;
    const op = await runtime.store.getOperation(project.id, opId);
    await control("/_test/seed", { submissionId: op!.provider_token, action: "create", behavior: "lost_after_effect" });
    await runtime.runner.tick();
    expect((await runtime.store.getOperation(project.id, opId))?.status).toBe("unknown");
    await runtime.close();
    runtime = await openDomainRuntime(config);
    expect((await json(`/v1/projects/${project.id}/operations/${opId}/reconcile`, "POST", {}, bearer)).response.status).toBe(200);
    await runtime.runner.tick();
    expect((await json(`/v1/projects/${project.id}/operations/${opId}`, "GET", undefined, bearer)).value.status).toBe("succeeded");
    expect((await json(`/v1/projects/${project.id}/sandboxes/${boxId}`, "GET", undefined, bearer)).value.observedState).toBe("running");
    const fleet = await json(`/v1/projects/${project.id}/sandboxes?state=running&q=${boxId}`, "GET", undefined, bearer);
    expect(fleet.value.items).toHaveLength(1);

    const exec = await json(`/v1/projects/${project.id}/sandboxes/${boxId}/executions`, "POST", { command: { kind: "argv", argv: ["fixture", "hello"] } }, { ...bearer, "Idempotency-Key": Bun.randomUUIDv7() });
    expect(exec.response.status).toBe(202);
    const execOp = await runtime.store.getOperation(project.id, exec.value.operation.id);
    await control("/_test/seed", { submissionId: execOp!.provider_token, action: "exec", behavior: "lost_after_effect", command: { command: { kind: "argv", argv: ["fixture", "hello"] }, exitCode: 7, stdoutBase64: Buffer.from("hello from fake").toString("base64") } });
    await runtime.runner.tick();
    expect((await runtime.store.getOperation(project.id, exec.value.operation.id))?.status).toBe("unknown");
    await json(`/v1/projects/${project.id}/operations/${exec.value.operation.id}/reconcile`, "POST", {}, bearer);
    await runtime.runner.tick();
    const execution = (await json(`/v1/projects/${project.id}/executions/${exec.value.execution.id}`, "GET", undefined, bearer)).value;
    expect(execution.exitCode).toBe(7);
    expect(execution.stdout).toBe("hello from fake");
    expect((await runtime.store.getOperation(project.id, exec.value.operation.id))?.result_json).not.toContain("hello from fake");
    const bytes = Uint8Array.from([0, 255, 1]);
    const write = await runtime.app.request(`/v1/projects/${project.id}/sandboxes/${boxId}/files?path=/data/blob`, { method: "PUT", headers: { ...bearer, "Idempotency-Key": Bun.randomUUIDv7() }, body: bytes });
    expect([200, 202]).toContain(write.status);
    const read = await runtime.app.request(`/v1/projects/${project.id}/sandboxes/${boxId}/files?path=/data/blob`, { headers: bearer });
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
    await control("/_test/seed", { submissionId: "*", action: "file_write", behavior: "lost_after_effect" });
    const lostWrite = await runtime.app.request(`/v1/projects/${project.id}/sandboxes/${boxId}/files?path=/data/lost`, { method: "PUT", headers: { ...bearer, "Idempotency-Key": Bun.randomUUIDv7() }, body: bytes });
    expect(lostWrite.status).toBe(202);
    const lostOperation = (await lostWrite.json() as any).operation;
    expect(lostOperation.status).toBe("unknown");
    await json(`/v1/projects/${project.id}/operations/${lostOperation.id}/reconcile`, "POST", {}, bearer);
    await runtime.runner.tick();
    expect((await json(`/v1/projects/${project.id}/operations/${lostOperation.id}`, "GET", undefined, bearer)).value.status).toBe("succeeded");
    const fakeState = await control("/_test/state");
    expect(fakeState.invocations.filter((item: any) => item.action === "create")).toHaveLength(1);
    expect(fakeState.invocations.filter((item: any) => item.action === "exec")).toHaveLength(1);
    expect(fakeState.invocations.filter((item: any) => item.action === "file_write")).toHaveLength(2);
  } finally { await runtime.close(); }
});
