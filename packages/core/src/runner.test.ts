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
    let rejectCode: "invalid" | "unsupported" | "unauthorized" | "not_found" | "conflict" | "capacity" | "rate_limit" | "unavailable" | "timeout" | "internal" | null = null;
    const observedAt = new Date().toISOString();
    const executionResult = (completed: boolean, submissionId: string): DriverResult => ({ status: "completed", effect: "applied", submissionId, value: { kind: "execution", observation: { ref: { scope, nativeId: "native_execution", kind: "execution" }, sandbox: wrongIdentity ? { ...sandbox, nativeId: "another_sandbox" } : sandbox, completed, exitCode: completed ? 7 : null, stdoutBase64: completed ? Buffer.from("done").toString("base64") : undefined, observedAt } } });
    const unsupported = async () => { throw new Error("Unexpected driver call"); };
    const fileResult = (submissionId: string): DriverResult => ({ status: "completed", effect: "partial", submissionId, value: { kind: "file_write", observation: { sandbox, path: "/partial", bytesWritten: 1, complete: true } } });
    const driver: ProviderDriver = {
      name: "fake", capabilities: unsupported, prepare: unsupported, create: unsupported, inspect: unsupported,
      inventory: unsupported, exec: async input => rejectCode ? { status: "rejected", effect: "none", error: { code: rejectCode, message: "secret-in-provider-error", effect: "none", retry: "never" } } : executionResult(!wrongIdentity ? false : true, input.identity.submissionId),
      readFile: unsupported, writeFile: async input => fileResult(input.identity.submissionId), destroy: unsupported,
      observe: async input => executionResult(true, input.submissionId),
    };
    const secrets = await SecretBox.fromFile(keyFile);
    const runner = new DurableRunner({ store, driver, secrets });
    const firstKey = Bun.randomUUIDv7();
    const first = await store.admitExec({ projectId: project.id, sandboxId: create.sandbox.id, endpoint: `POST /sandboxes/${create.sandbox.id}/executions`, key: firstKey, intentHash: "first", encryptedRequest: await secrets.seal("execution-request", `${create.sandbox.id}:${firstKey}`, JSON.stringify({ command: { kind: "argv", argv: ["fixture"] }, env: { API_KEY: "sensitive-value" } })), captureBytes: 1024 });
    expect(first.operation.request_json).not.toContain("sensitive-value");
    await runner.tick();
    expect((await store.getOperation(project.id, first.operation.id))?.status).toBe("running");
    expect((await store.getOperation(project.id, first.operation.id))?.request_json).not.toContain("encryptedRequest");
    expect((await store.getExecution(project.id, first.execution!.id))?.status).toBe("running");
    await store.requestReconcile(project.id, first.operation.id);
    await runner.tick();
    expect((await store.getExecution(project.id, first.execution!.id))?.exit_code).toBe(7);

    wrongIdentity = true;
    const secondKey = Bun.randomUUIDv7();
    const second = await store.admitExec({ projectId: project.id, sandboxId: create.sandbox.id, endpoint: `POST /sandboxes/${create.sandbox.id}/executions`, key: secondKey, intentHash: "second", encryptedRequest: await secrets.seal("execution-request", `${create.sandbox.id}:${secondKey}`, JSON.stringify({ command: { kind: "argv", argv: ["fixture"] } })), captureBytes: 1024 });
    await runner.tick();
    expect((await store.getOperation(project.id, second.operation.id))?.status).toBe("unknown");
    expect((await store.getExecution(project.id, second.execution!.id))?.exit_code).toBeNull();

    const rejectionCodes = { invalid: "INVALID_ARGUMENT", unsupported: "UNSUPPORTED", unauthorized: "UNAUTHENTICATED", not_found: "NOT_FOUND", conflict: "CONFLICT", capacity: "CAPACITY", rate_limit: "RATE_LIMIT", unavailable: "UNAVAILABLE", timeout: "TIMEOUT", internal: "INTERNAL" } as const;
    for (const [driverCode, publicCode] of Object.entries(rejectionCodes)) {
      rejectCode = driverCode as keyof typeof rejectionCodes;
      const rejectedKey = Bun.randomUUIDv7();
      const rejected = await store.admitExec({ projectId: project.id, sandboxId: create.sandbox.id, endpoint: `POST /sandboxes/${create.sandbox.id}/executions`, key: rejectedKey, intentHash: "rejected", encryptedRequest: await secrets.seal("execution-request", `${create.sandbox.id}:${rejectedKey}`, JSON.stringify({ command: { kind: "argv", argv: ["fixture"] } })), captureBytes: 0 });
      await runner.tick();
      const rejectedOperation = await store.getOperation(project.id, rejected.operation.id);
      expect(rejectedOperation?.status).toBe("failed");
      expect(JSON.parse(rejectedOperation!.error_json!)).toMatchObject({ code: publicCode, effect: "none", retry: "never" });
      expect(rejectedOperation?.error_json).not.toContain("secret-in-provider-error");
    }

    const fileKey = Bun.randomUUIDv7();
    const file = await store.admitFileWrite({ projectId: project.id, sandboxId: create.sandbox.id, endpoint: `PUT /sandboxes/${create.sandbox.id}/files`, key: fileKey, intentHash: "partial-file", path: "/partial", overwrite: true, bytes: 2, encryptedBytes: await secrets.seal("file-write-input", `${create.sandbox.id}:${fileKey}`, Buffer.from("ab").toString("base64")) });
    await runner.tick();
    const partial = await store.getOperation(project.id, file.operation.id);
    expect(partial?.status).toBe("unknown");
    expect(partial?.result_json).toBeNull();
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("polling continues after a transient claim error", async () => {
  let claims = 0;
  const store = { claimDue: async () => { claims++; if (claims === 1) throw new Error("transient"); return undefined; } } as unknown as ControlStore;
  const runner = new DurableRunner({ store, driver: {} as ProviderDriver, secrets: {} as SecretBox, pollMs: 5 });
  runner.start();
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(claims).toBeGreaterThan(1);
  } finally { runner.stop(); }
});

test("a create observation with another submission ID cannot bind a native sandbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-create-identity-"));
  const keyFile = join(directory, "key");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32))); await chmod(keyFile, 0o600);
  const backend = openSqliteBackend(":memory:");
  await migrate(backend, bundledMigration("sqlite"));
  const store = new ControlStore(backend);
  try {
    const project = await store.createProject("Create identity");
    const connection = await store.createConnection({ id: "conn_identity", projectId: project.id, provider: "fake", name: "Fake", encryptedCredentials: "ciphertext" });
    await store.verifyConnection(project.id, connection.id, "fake-local");
    const created = await store.admitCreate({ projectId: project.id, endpoint: "POST /sandboxes", key: Bun.randomUUIDv7(), intentHash: "create", request: { environment: { kind: "prepared", imageId: "fake-starter" } }, connectionId: connection.id });
    const scope: NativeScope = { provider: "fake", connectionId: connection.id, accountId: "fake-local", region: "local" };
    const unsupported = async () => { throw new Error("Unexpected driver call"); };
    const driver: ProviderDriver = {
      name: "fake", capabilities: unsupported, prepare: async () => ({ supported: true, effectiveImage: "fake-starter" }),
      create: async () => ({ status: "completed", effect: "applied", submissionId: "sub_other", value: { kind: "sandbox", observation: { ref: { scope, nativeId: "native_other", kind: "sandbox" }, state: "running", observedAt: new Date().toISOString() } } }),
      inspect: unsupported, inventory: unsupported, exec: unsupported, readFile: unsupported, writeFile: unsupported, destroy: unsupported, observe: unsupported,
    };
    await new DurableRunner({ store, driver, secrets: await SecretBox.fromFile(keyFile) }).tick();
    expect((await store.getOperation(project.id, created.operation.id))?.status).toBe("unknown");
    expect((await store.getSandbox(project.id, created.sandbox.id))?.native_id).toBeNull();
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
