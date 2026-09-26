import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProviderDriver } from "./index";
import { FakeProviderEngine } from "./engine";
import { startFakeProviderServer } from "./server";

const token = "local-test-token-12345";
const scope = { provider: "fake", connectionId: "conn_1", accountId: "fake-local", region: "local" };
const identity = (submissionId: string) => ({ projectId: "project_1", operationId: submissionId, invocationKey: `key_${submissionId}`, submissionId });
const command = { kind: "argv" as const, argv: ["fixture", "hello"] };
let server: Awaited<ReturnType<typeof startFakeProviderServer>> | undefined;
let directory: string | undefined;

async function setup(statePath?: string) {
  directory ??= await mkdtemp(join(tmpdir(), "sandbar-fake-"));
  server = await startFakeProviderServer({ hostname: "127.0.0.1", port: 0, statePath: statePath ?? join(directory, "provider.json"), token, testMode: true });
  const baseUrl = server.url.toString();
  const driver = new FakeProviderDriver({ baseUrl, token });
  const control = async (path: string, body?: unknown) => {
    const response = await fetch(new URL(path, baseUrl), { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return response.json();
  };
  return { driver, control, statePath: statePath ?? join(directory, "provider.json") };
}
afterEach(async () => { server?.stop(true); server = undefined; if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

describe("independent fake provider", () => {
  test("lost create and exec responses remain observable across Sandbar-facing restart without duplicate effects", async () => {
    const { driver, control, statePath } = await setup();
    await control("/_test/seed", { submissionId: "create_1", action: "create", behavior: "lost_after_effect" });
    const first = await driver.create({ scope, identity: identity("create_1"), image: "fake-starter", networkPolicy: "blocked" });
    expect(first.status).toBe("unknown");
    server?.stop(true);
    server = undefined;
    const restarted = await setup(statePath);
    const recovered = await restarted.driver.observe({ scope, submissionId: "create_1" });
    expect(recovered?.status).toBe("completed");
    if (recovered?.status !== "completed" || recovered.value.kind !== "sandbox") throw new Error("No sandbox observation");
    const sandbox = recovered.value.observation.ref;
    await restarted.control("/_test/seed", { submissionId: "exec_1", action: "exec", behavior: "lost_after_effect", command: { command, exitCode: 7, stdoutBase64: Buffer.from("fixture output").toString("base64") } });
    const execution = await restarted.driver.exec({ sandbox, identity: identity("exec_1"), command, deadlineSeconds: 30, maxOutputBytes: 1024 });
    expect(execution.status).toBe("unknown");
    const observedExec = await restarted.driver.observe({ scope, submissionId: "exec_1" });
    expect(observedExec?.status).toBe("completed");
    if (observedExec?.status !== "completed" || observedExec.value.kind !== "execution") throw new Error("No execution observation");
    expect(observedExec.value.observation.exitCode).toBe(7);
    expect(Buffer.from(observedExec.value.observation.stdoutBase64 ?? "", "base64").toString()).toBe("fixture output");
    const state = await restarted.control("/_test/state");
    expect(state.resources).toHaveLength(1);
    expect(state.invocations.filter((x: { action: string }) => x.action === "create")).toHaveLength(1);
    expect(state.invocations.filter((x: { action: string }) => x.action === "exec")).toHaveLength(1);
  });

  test("non-idempotent and undiscoverable ambiguous submission cannot be treated as safe to replay", async () => {
    const { driver, control } = await setup();
    await control("/_test/profile", { nativeIdempotency: { create: false, exec: false, destroy: false }, discoveryBySubmission: false });
    await control("/_test/seed", { submissionId: "create_2", action: "create", behavior: "lost_after_effect" });
    expect((await driver.create({ scope, identity: identity("create_2"), image: "fake-starter", networkPolicy: "blocked" })).status).toBe("unknown");
    expect(await driver.observe({ scope, submissionId: "create_2" })).toBeNull();
    const before = await control("/_test/state");
    expect(before.resources).toHaveLength(1);
    // A deliberate direct redispatch demonstrates why the control runner must not do this.
    await driver.create({ scope, identity: identity("create_2"), image: "fake-starter", networkPolicy: "blocked" });
    const after = await control("/_test/state");
    expect(after.resources).toHaveLength(2);
    expect(after.invocations).toHaveLength(2);
  });

  test("explicit command fixtures, binary files, and definitive rejection have honest effects", async () => {
    const { driver, control } = await setup();
    const created = await driver.create({ scope, identity: identity("create_3"), image: "fake-starter", networkPolicy: "blocked" });
    if (created.status !== "completed" || created.value.kind !== "sandbox") throw new Error("Create failed");
    const sandbox = created.value.observation.ref;
    const unsupported = await driver.exec({ sandbox, identity: identity("exec_unsupported"), command, deadlineSeconds: 30, maxOutputBytes: 1024 });
    expect(unsupported.status).toBe("rejected");
    expect(unsupported.effect).toBe("none");
    const data = Uint8Array.from([0, 255, 1]);
    const written = await driver.writeFile({ sandbox, identity: identity("write_1"), path: "/data/blob", bytes: data, overwrite: false });
    expect(written.status).toBe("completed");
    expect(await driver.readFile({ sandbox, path: "/data/blob" })).toEqual(data);
    await control("/_test/seed", { submissionId: "destroy_1", action: "destroy", behavior: "reject", rejectCode: "capacity" });
    const rejected = await driver.destroy({ sandbox, identity: identity("destroy_1") });
    expect(rejected.status).toBe("rejected");
    expect((await driver.inspect(sandbox))?.state).toBe("running");
  });

  test("delayed observation and duplicate out-of-order events are deterministic test controls", async () => {
    const { driver, control } = await setup();
    await control("/_test/seed", { submissionId: "create_delayed", action: "create", delayObservations: 2 });
    const submitted = await driver.create({ scope, identity: identity("create_delayed"), image: "fake-starter", networkPolicy: "blocked" });
    expect(submitted.status).toBe("pending");
    expect((await driver.observe({ scope, submissionId: "create_delayed" }))?.status).toBe("pending");
    expect((await driver.observe({ scope, submissionId: "create_delayed" }))?.status).toBe("pending");
    const completed = await driver.observe({ scope, submissionId: "create_delayed" });
    if (completed?.status !== "completed" || completed.value.kind !== "sandbox") throw new Error("Missing delayed create");
    const ref = completed.value.observation.ref;
    const occurredAt = "2026-01-01T00:00:00Z";
    await control("/_test/events/seed", [
      { eventId: "event_2", ref, sequence: 2, state: "destroyed", occurredAt },
      { eventId: "event_1", ref, sequence: 1, state: "running", occurredAt },
      { eventId: "event_2", ref, sequence: 2, state: "destroyed", occurredAt },
    ]);
    expect((await driver.events(scope)).map(x => x.eventId)).toEqual(["event_2", "event_1", "event_2"]);
  });

  test("test controls are absent when test mode is disabled", async () => {
    const { statePath } = await setup();
    server?.stop(true);
    server = await startFakeProviderServer({ hostname: "127.0.0.1", port: 0, statePath, token, testMode: false });
    const response = await fetch(new URL("/_test/state", server.url), { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(404);
  });

  test("wildcard scenario queue consumes one matching action without knowing allocated submission IDs", async () => {
    const { driver, control } = await setup();
    await control("/_test/seed", { submissionId: "*", action: "create", behavior: "lost_after_effect" });
    await control("/_test/seed", { submissionId: "*", action: "create", behavior: "reject", rejectCode: "capacity" });
    expect((await driver.create({ scope, identity: identity("opaque_1"), image: "fake-starter", networkPolicy: "blocked" })).status).toBe("unknown");
    expect((await driver.create({ scope, identity: identity("opaque_2"), image: "fake-starter", networkPolicy: "blocked" })).status).toBe("rejected");
    expect((await driver.create({ scope, identity: identity("opaque_3"), image: "fake-starter", networkPolicy: "blocked" })).status).toBe("completed");
    expect((await control("/_test/state")).resources).toHaveLength(2);
  });

  test("exec translates cwd, environment, deadline and rejects cross-action submission reuse", async () => {
    const { driver, control } = await setup();
    const created = await driver.create({ scope, identity: identity("shared_sub"), image: "fake-starter", networkPolicy: "blocked" });
    if (created.status !== "completed" || created.value.kind !== "sandbox") throw new Error("Create failed");
    const sandbox = created.value.observation.ref;
    const collision = await driver.exec({ sandbox, identity: identity("shared_sub"), command, deadlineSeconds: 30, maxOutputBytes: 32 });
    expect(collision.status).toBe("rejected");
    expect(collision.effect).toBe("none");
    await control("/_test/seed", { submissionId: "exec_scoped", action: "exec", command: { command, cwd: "/workspace", env: { LANG: "C" }, deadlineSeconds: 30, exitCode: 0 } });
    const wrong = await driver.exec({ sandbox, identity: identity("exec_scoped"), command, cwd: "/wrong", env: { LANG: "C" }, deadlineSeconds: 30, maxOutputBytes: 32 });
    expect(wrong.status).toBe("rejected");
    const correct = await driver.exec({ sandbox, identity: identity("exec_scoped"), command, cwd: "/workspace", env: { LANG: "C" }, deadlineSeconds: 30, maxOutputBytes: 32 });
    expect(correct.status).toBe("completed");
    expect((await control("/_test/state")).ledger.filter((x: { action: string }) => x.action === "exec")).toHaveLength(1);
  });

  test("authentication rejection before dispatch is definitive", async () => {
    const { control } = await setup();
    const wrongTokenDriver = new FakeProviderDriver({ baseUrl: server!.url.toString(), token: "wrong-token-123456" });
    const result = await wrongTokenDriver.create({ scope, identity: identity("unauthorized_1"), image: "fake-starter", networkPolicy: "blocked" });
    expect(result.status).toBe("rejected");
    expect(result.effect).toBe("none");
    expect((await control("/_test/state")).invocations).toHaveLength(0);
  });

  test("lost file-write response is recovered through the independent effect ledger", async () => {
    const { driver, control } = await setup();
    const created = await driver.create({ scope, identity: identity("file_parent"), image: "fake-starter", networkPolicy: "blocked" });
    if (created.status !== "completed" || created.value.kind !== "sandbox") throw new Error("Create failed");
    const sandbox = created.value.observation.ref;
    await control("/_test/seed", { submissionId: "*", action: "file_write", behavior: "lost_after_effect" });
    const bytes = Uint8Array.from([1, 0, 255]);
    expect((await driver.writeFile({ sandbox, identity: identity("file_write_1"), path: "/blob", bytes, overwrite: true })).status).toBe("unknown");
    const observed = await driver.observe({ scope, submissionId: "file_write_1" });
    expect(observed?.status).toBe("completed");
    expect(await driver.readFile({ sandbox, path: "/blob" })).toEqual(bytes);
    expect((await control("/_test/state")).invocations.filter((x: { action: string }) => x.action === "file_write")).toHaveLength(1);
  });

  test("same-action submission reuse with different operation or payload is rejected without replay", async () => {
    const { driver, control } = await setup();
    const created = await driver.create({ scope, identity: identity("create_fingerprint"), image: "fake-starter", networkPolicy: "blocked" });
    expect(created.status).toBe("completed");
    const conflicting = await driver.create({ scope, identity: { ...identity("create_fingerprint"), operationId: "another_operation" }, image: "fake-starter", networkPolicy: "blocked" });
    expect(conflicting.status).toBe("rejected");
    expect(conflicting.effect).toBe("none");
    if (created.status !== "completed" || created.value.kind !== "sandbox") throw new Error("Create failed");
    const sandbox = created.value.observation.ref;
    const original = await driver.writeFile({ sandbox, identity: identity("write_fingerprint"), path: "/blob", bytes: Uint8Array.from([1]), overwrite: true });
    expect(original.status).toBe("completed");
    const changed = await driver.writeFile({ sandbox, identity: identity("write_fingerprint"), path: "/blob", bytes: Uint8Array.from([2]), overwrite: true });
    expect(changed.status).toBe("rejected");
    expect(await driver.readFile({ sandbox, path: "/blob" })).toEqual(Uint8Array.from([1]));
    expect((await control("/_test/state")).invocations).toHaveLength(2);
  });

  test("diagnostic invocation history remains bounded after repeated definitive rejections", async () => {
    directory = await mkdtemp(join(tmpdir(), "sandbar-fake-"));
    const engine = new FakeProviderEngine(join(directory, "provider.json"), true);
    await engine.load();
    const missing = { scope, kind: "sandbox" as const, nativeId: "missing" };
    for (let index = 0; index < 520; index++) {
      const result = await engine.exec({ sandbox: missing, identity: identity(`missing_${index}`), command, deadlineSeconds: 30, maxOutputBytes: 0 });
      expect(result.result.status).toBe("rejected");
    }
    expect(engine.snapshot().invocations).toHaveLength(512);
    const reloaded = new FakeProviderEngine(join(directory, "provider.json"), true);
    await reloaded.load();
    expect(reloaded.snapshot().invocations).toHaveLength(512);
  });
});
