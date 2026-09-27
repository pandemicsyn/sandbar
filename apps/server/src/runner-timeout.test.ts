import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SecretBox, DurableRunner } from "@sandbar/core";
import type { NativeScope } from "@sandbar/provider-spi";
import { FakeProviderDriver } from "@sandbar/provider-fake";
import { ControlStore, bundledMigration, migrate, openSqliteBackend } from "@sandbar/store";

test("timed-out fake submission releases the runner and recovers only by observation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-runner-timeout-"));
  const keyFile = join(directory, "key");
  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  const databasePath = join(directory, "control.sqlite");
  const backend = openSqliteBackend(databasePath);
  await migrate(backend, bundledMigration("sqlite"));
  const store = new ControlStore(backend);

  try {
    const project = await store.createProject("Timeout recovery");

    const connection = await store.createConnection({
      id: "conn_timeout",
      projectId: project.id,
      provider: "fake",
      name: "Fake",
      encryptedCredentials: "ciphertext",
    });

    await store.verifyConnection(project.id, connection.id, "fake-local");

    const first = await store.admitCreate({
      projectId: project.id,
      endpoint: "POST /sandboxes",
      key: Bun.randomUUIDv7(),
      intentHash: "first",
      request: { environment: { kind: "prepared", imageId: "fake-starter" } },
      connectionId: connection.id,
    });

    await Bun.sleep(2);

    const second = await store.admitCreate({
      projectId: project.id,
      endpoint: "POST /sandboxes",
      key: Bun.randomUUIDv7(),
      intentHash: "second",
      request: { environment: { kind: "prepared", imageId: "fake-starter" } },
      connectionId: connection.id,
    });

    let firstCreateCalls = 0;
    let secondCreateCalls = 0;
    let observationCalls = 0;
    let aborted = 0;

    const completed = (scope: NativeScope, submissionId: string, nativeId: string) => ({
      status: "completed",
      effect: "applied",
      submissionId,
      value: {
        kind: "sandbox",
        observation: {
          ref: { scope, nativeId, kind: "sandbox" },
          state: "running",
          observedAt: new Date().toISOString(),
        },
      },
    });

    const transport = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        // SAFETY: This test controls every JSON action submitted to the injected transport.
        const action = JSON.parse(String(init?.body)) as {
          kind: string;
          scope: NativeScope;
          identity: { submissionId: string };
          submissionId: string;
        };

        if (action.kind === "capabilities")
          return Response.json({
            provider: "fake",
            nativeIdempotency: { create: false, exec: false, destroy: false, writeFile: false },
            discoveryBySubmission: true,
            supports: { argv: true, shell: true, fileBytes: true, inventory: true },
            maxFileBytes: 1_048_576,
            maxOutputBytes: 1_048_576,
            networkPolicies: ["blocked"],
          });

        if (action.kind === "create") {
          if (action.identity.submissionId === first.operation.provider_token) {
            firstCreateCalls++;

            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  aborted++;
                  reject(init.signal?.reason);
                },
                { once: true },
              );
            });
          }

          secondCreateCalls++;

          return Response.json(
            completed(action.scope, action.identity.submissionId, "native_second"),
          );
        }

        if (action.kind === "observe") {
          observationCalls++;

          return Response.json(completed(action.scope, action.submissionId, "native_first"));
        }

        throw new Error(`Unexpected fake action ${action.kind}`);
      },
      { preconnect: fetch.preconnect },
    );

    const driver = new FakeProviderDriver({
      baseUrl: "http://127.0.0.1:8789",
      token: "local-test-token",
      fetch: transport,
      timeoutMs: 20,
    });

    const runner = new DurableRunner({ store, driver, secrets: await SecretBox.fromFile(keyFile) });

    expect(await runner.tick()).toBe(true);
    expect((await store.getOperation(project.id, first.operation.id))?.status).toBe("unknown");
    expect((await store.getOperation(project.id, first.operation.id))?.effect).toBe("possible");
    expect(aborted).toBe(1);
    expect(firstCreateCalls).toBe(1);

    expect(await runner.tick()).toBe(true);
    expect((await store.getOperation(project.id, second.operation.id))?.status).toBe("succeeded");
    expect(secondCreateCalls).toBe(1);

    await store.requestReconcile(project.id, first.operation.id);
    expect(await runner.tick()).toBe(true);
    expect((await store.getOperation(project.id, first.operation.id))?.status).toBe("succeeded");
    expect((await store.getSandbox(project.id, first.sandbox.id))?.native_id).toBe("native_first");
    expect(firstCreateCalls).toBe(1);
    expect(observationCalls).toBe(1);

    const execution = await store.admitExec({
      projectId: project.id,
      sandboxId: first.sandbox.id,
      endpoint: "POST /executions",
      key: Bun.randomUUIDv7(),
      intentHash: "retained-output",
      encryptedRequest: "sealed",
      captureBytes: 1,
    });

    const executionClaim = (await store.claimDue("manual-completion", 1000, project.id))!;
    await store.beginSubmission(executionClaim);
    await store.complete(executionClaim, {
      effect: "applied",
      value: { kind: "execution", observation: { completed: true, exitCode: 0 } },
      encryptedOutput: "sealed-output",
      outputBytes: 1,
    });
    const native = new Database(databasePath);

    try {
      native
        .query("UPDATE executions SET completed_at=? WHERE id=?")
        .run(Date.now() - 24 * 60 * 60 * 1000 - 60_000, execution.execution!.id);
    } finally {
      native.close();
    }

    expect(await runner.tick()).toBe(false);
    expect((await store.getExecution(project.id, execution.execution!.id))?.output_state).toBe(
      "expired",
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
