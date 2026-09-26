import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderDriver, DriverResult, NativeRef, NativeScope } from "@sandbar/provider-spi";
import { ControlStore, bundledMigration, migrate, openSqliteBackend } from "@sandbar/store";
import { SecretBox } from "./crypto";
import { DurableRunner } from "./runner";

test("nonterminal execution stays running; cross-wired observation remains unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-runner-"));
  const keyFile = join(directory, "key");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32))); await chmod(keyFile, 0o600);
  const backend = openSqliteBackend(":memory:");
  await migrate(backend, bundledMigration("sqlite"));
  const store = new ControlStore(backend);
  try {
    const project = await store.createProject("Runner test");
    const connection = await store.createConnection({ id: "conn_runner", projectId: project.id, provider: "fake", name: "Fake", encryptedCredentials: "ciphertext" });
    await store.verifyConnection(project.id, connection.id, "fake-local");
    const create = await store.admitCreate({ projectId: project.id, endpoint: "POST /sandboxes", key: Bun.randomUUIDv7(), intentHash: "create", request: { environment: { kind: "prepared", imageId: "fake-starter" } }, connectionId: connection.id });
    const scope: NativeScope = { provider: "fake", connectionId: connection.id, accountId: "fake-local", region: "local" };
    const sandbox: NativeRef = { scope, nativeId: "native_runner", kind: "sandbox" };
    const createClaim = (await store.claimDue("setup", 1000, project.id))!;
    await store.beginSubmission(createClaim);
    await store.complete(createClaim, { effect: "applied", value: { kind: "sandbox", observation: { ref: sandbox, state: "running" } } });
    let wrongIdentity = false;
    const observedAt = new Date().toISOString();
    const executionResult = (completed: boolean): DriverResult => ({ status: "completed", effect: "applied", value: { kind: "execution", observation: { ref: { scope, nativeId: "native_execution", kind: "execution" }, sandbox: wrongIdentity ? { ...sandbox, nativeId: "another_sandbox" } : sandbox, completed, exitCode: completed ? 7 : null, stdoutBase64: completed ? Buffer.from("done").toString("base64") : undefined, observedAt } } });
    const unsupported = async () => { throw new Error("Unexpected driver call"); };
    const driver: ProviderDriver = {
      name: "fake", capabilities: unsupported, prepare: unsupported, create: unsupported, inspect: unsupported,
      inventory: unsupported, exec: async () => executionResult(!wrongIdentity ? false : true),
      readFile: unsupported, writeFile: unsupported, destroy: unsupported,
      observe: async () => executionResult(true),
    };
    const runner = new DurableRunner({ store, driver, secrets: await SecretBox.fromFile(keyFile) });
    const first = await store.admitExec({ projectId: project.id, sandboxId: create.sandbox.id, endpoint: `POST /sandboxes/${create.sandbox.id}/executions`, key: Bun.randomUUIDv7(), intentHash: "first", request: { command: { kind: "argv", argv: ["fixture"] } }, captureBytes: 1024 });
    await runner.tick();
    expect((await store.getOperation(project.id, first.operation.id))?.status).toBe("running");
    expect((await store.getExecution(project.id, first.execution!.id))?.status).toBe("running");
    await store.requestReconcile(project.id, first.operation.id);
    await runner.tick();
    expect((await store.getExecution(project.id, first.execution!.id))?.exit_code).toBe(7);

    wrongIdentity = true;
    const second = await store.admitExec({ projectId: project.id, sandboxId: create.sandbox.id, endpoint: `POST /sandboxes/${create.sandbox.id}/executions`, key: Bun.randomUUIDv7(), intentHash: "second", request: { command: { kind: "argv", argv: ["fixture"] } }, captureBytes: 1024 });
    await runner.tick();
    expect((await store.getOperation(project.id, second.operation.id))?.status).toBe("unknown");
    expect((await store.getExecution(project.id, second.execution!.id))?.exit_code).toBeNull();
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
