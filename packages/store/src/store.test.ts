import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  bundledMigration,
  migrate,
  openMysqlBackend,
  openSqliteBackend,
  type Dialect,
} from "./backend";
import { ControlStore } from "./store";

test("operator setup rolls back when its first session cannot be stored", async () => {
  const store = new ControlStore(openSqliteBackend(":memory:"));

  try {
    await migrate(store.backend, bundledMigration("sqlite"));
    await store.backend.run(
      sql`CREATE TRIGGER fail_setup_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    await expect(
      store.setupOperator("first-token", "first-session", "first-csrf", Date.now() + 60_000),
    ).rejects.toThrow();
    expect(await store.hasOperator()).toBe(false);
    await store.backend.run(sql`DROP TRIGGER fail_setup_session`);
    await store.setupOperator("second-token", "second-session", "second-csrf", Date.now() + 60_000);
    expect(await store.authenticateBearer("second-token")).toBe(true);
    expect(await store.getSession("second-session")).toBeDefined();
  } finally {
    await store.close();
  }
});

test("SQLite evicts retained output after restart when capacity is needed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-output-quota-"));
  const path = join(directory, "control.sqlite");
  let store = new ControlStore(openSqliteBackend(path));

  try {
    await migrate(store.backend, bundledMigration("sqlite"));
    const project = await store.createProject("quota-restart");

    const connection = await store.createConnection({
      id: `conn_${crypto.randomUUID().replaceAll("-", "")}`,
      projectId: project.id,
      provider: "fake",
      name: "Fake",
      encryptedCredentials: "ciphertext",
    });

    await store.verifyConnection(project.id, connection.id, "fake-local");

    const created = await store.admitCreate({
      projectId: project.id,
      endpoint: "POST /sandboxes",
      key: Bun.randomUUIDv7(),
      intentHash: "create",
      request: { environment: { kind: "prepared", imageId: "fake-starter" } },
    });

    const createClaim = (await store.claimDue("setup", 1000, project.id))!;
    await store.complete(createClaim, {
      effect: "applied",
      value: {
        kind: "sandbox",
        observation: { ref: { nativeId: "native_restart" }, state: "running" },
      },
    });
    const sandboxId = created.sandbox.id;

    const admitted = await store.admitExec({
      projectId: project.id,
      sandboxId,
      endpoint: "POST /executions",
      key: Bun.randomUUIDv7(),
      intentHash: "capture",
      encryptedRequest: "sealed",
      captureBytes: 16 * 1024 * 1024,
    });

    const claim = (await store.claimDue("capture", 1000, project.id))!;
    await store.complete(claim, {
      effect: "applied",
      value: { kind: "execution", observation: { completed: true } },
      encryptedOutput: "sealed-output",
      outputBytes: 16 * 1024 * 1024,
    });
    expect((await store.getExecution(project.id, admitted.execution!.id))?.output_ciphertext).toBe(
      "sealed-output",
    );
    await store.close();
    store = new ControlStore(openSqliteBackend(path));
    expect((await store.getExecution(project.id, admitted.execution!.id))?.output_ciphertext).toBe(
      "sealed-output",
    );

    const refill = await store.admitExec({
      projectId: project.id,
      sandboxId,
      endpoint: "POST /executions",
      key: Bun.randomUUIDv7(),
      intentHash: "refill",
      encryptedRequest: "sealed",
      captureBytes: 1,
    });

    expect(refill.operation.status).toBe("queued");
    expect((await store.getExecution(project.id, admitted.execution!.id))?.output_state).toBe(
      "evicted",
    );
    expect(
      (await store.getExecution(project.id, admitted.execution!.id))?.output_ciphertext,
    ).toBeNull();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(dialect: Dialect) {
  const backend =
    dialect === "sqlite"
      ? openSqliteBackend(":memory:")
      : await openMysqlBackend(process.env.SANDBAR_TEST_MYSQL_URL!);

  await migrate(backend, bundledMigration(dialect));
  const store = new ControlStore(backend);
  const project = await store.createProject("test");

  const connection = await store.createConnection({
    id: `conn_${crypto.randomUUID().replaceAll("-", "")}`,
    projectId: project.id,
    provider: "fake",
    name: "Local fake",
    encryptedCredentials: "ciphertext",
  });

  await store.verifyConnection(project.id, connection.id, "fake-local");

  return { store, project, connection };
}

const dialects: Dialect[] = ["sqlite"];

if (process.env.SANDBAR_TEST_MYSQL_URL) dialects.push("mysql");

for (const dialect of dialects)
  describe(`${dialect} durable admission`, () => {
    test("unresolved admission quota counts queued and pending work while allowing lookup and cleanup", async () => {
      const { store, project, connection } = await fixture(dialect);
      const endpoint = "POST /sandboxes";
      const request = { environment: { kind: "prepared" as const, imageId: "fake-starter" } };
      const accepted: Awaited<ReturnType<typeof store.admitCreate>>[] = [];
      const keys: string[] = [];

      try {
        for (let index = 0; index < 100; index++) {
          const key = Bun.randomUUIDv7();
          keys.push(key);
          accepted.push(
            await store.admitCreate({
              projectId: project.id,
              endpoint,
              key,
              intentHash: `create-${index}`,
              request,
              connectionId: connection.id,
            }),
          );
        }

        const newCreate = () =>
          store.admitCreate({
            projectId: project.id,
            endpoint,
            key: Bun.randomUUIDv7(),
            intentHash: "overflow",
            request,
            connectionId: connection.id,
          });

        await expect(newCreate()).rejects.toThrow("Too many unresolved outcomes");
        expect(
          (
            await store.admitCreate({
              projectId: project.id,
              endpoint,
              key: keys[0]!,
              intentHash: "create-0",
              request,
              connectionId: connection.id,
            })
          ).repeated,
        ).toBe(true);
        expect(await store.lookupInvocation(project.id, endpoint, keys[0]!)).toBeDefined();

        const pending = (await store.claimDue("pending", 1000, project.id))!;
        expect(await store.beginSubmission(pending)).toBe(true);
        await store.reschedule(pending, "awaiting_observation", 60_000, undefined, true);
        expect((await store.getOperation(project.id, pending.operation.id))?.status).toBe(
          "running",
        );
        await expect(newCreate()).rejects.toThrow("Too many unresolved outcomes");

        const terminal = (await store.claimDue("terminal", 1000, project.id))!;
        await store.complete(terminal, {
          effect: "applied",
          value: {
            kind: "sandbox",
            observation: { ref: { nativeId: `native_${crypto.randomUUID()}` }, state: "running" },
          },
        });
        expect((await store.getOperation(project.id, terminal.operation.id))?.status).toBe(
          "succeeded",
        );
        expect((await newCreate()).operation.status).toBe("queued");

        await expect(
          store.admitExec({
            projectId: project.id,
            sandboxId: terminal.operation.sandbox_id,
            endpoint: "POST /executions",
            key: Bun.randomUUIDv7(),
            intentHash: "overflow-exec",
            encryptedRequest: "sealed",
            captureBytes: 0,
          }),
        ).rejects.toThrow("Too many unresolved outcomes");
        await expect(
          store.admitFileWrite({
            projectId: project.id,
            sandboxId: terminal.operation.sandbox_id,
            endpoint: "PUT /files",
            key: Bun.randomUUIDv7(),
            intentHash: "overflow-file",
            path: "/data/blob",
            overwrite: false,
            encryptedBytes: "sealed",
            bytes: 1,
          }),
        ).rejects.toThrow("Too many unresolved outcomes");

        const cleanup = await store.admitDestroy({
          projectId: project.id,
          sandboxId: accepted[0]!.sandbox.id,
          endpoint: `DELETE /sandboxes/${accepted[0]!.sandbox.id}`,
          key: Bun.randomUUIDv7(),
          intentHash: "cleanup",
        });

        expect(cleanup.operation.status).toBe("queued");
      } finally {
        await store.close();
      }
    });

    test("retained captures continue consuming sandbox and project capacity after completion", async () => {
      const { store, project, connection } = await fixture(dialect);
      const mebibyte = 1024 * 1024;

      try {
        async function runningSandbox() {
          const created = await store.admitCreate({
            projectId: project.id,
            endpoint: "POST /sandboxes",
            key: Bun.randomUUIDv7(),
            intentHash: "create",
            request: { environment: { kind: "prepared", imageId: "fake-starter" } },
            connectionId: connection.id,
          });

          const claim = (await store.claimDue("setup", 1000, project.id))!;
          await store.beginSubmission(claim);
          await store.complete(claim, {
            effect: "applied",
            value: {
              kind: "sandbox",
              observation: { ref: { nativeId: `native_${crypto.randomUUID()}` }, state: "running" },
            },
          });

          return created.sandbox.id;
        }

        async function capture(sandboxId: string, bytes: number) {
          const admitted = await store.admitExec({
            projectId: project.id,
            sandboxId,
            endpoint: `POST /sandboxes/${sandboxId}/executions`,
            key: Bun.randomUUIDv7(),
            intentHash: "capture",
            encryptedRequest: "sealed",
            captureBytes: bytes,
          });

          const claim = (await store.claimDue("capture", 1000, project.id))!;
          expect(claim.operation.id).toBe(admitted.operation.id);
          await store.beginSubmission(claim);
          await store.complete(claim, {
            effect: "applied",
            value: { kind: "execution", observation: { completed: true, exitCode: 0 } },
            encryptedOutput: "sealed-output",
            outputBytes: bytes,
          });
          expect(
            (await store.getExecution(project.id, admitted.execution!.id))?.output_ciphertext,
          ).toBe("sealed-output");

          return admitted.execution!.id;
        }

        const first = await runningSandbox();
        const oldestSandboxCapture = await capture(first, 16 * mebibyte);

        const refill = await store.admitExec({
          projectId: project.id,
          sandboxId: first,
          endpoint: "POST /executions",
          key: Bun.randomUUIDv7(),
          intentHash: "refill",
          encryptedRequest: "sealed",
          captureBytes: mebibyte,
        });

        expect(refill.operation.status).toBe("queued");
        expect((await store.getExecution(project.id, oldestSandboxCapture))?.output_state).toBe(
          "evicted",
        );
        expect(
          (await store.getExecution(project.id, oldestSandboxCapture))?.output_ciphertext,
        ).toBeNull();
        expect((await store.getExecution(project.id, oldestSandboxCapture))?.exit_code).toBe(0);
        const refillClaim = (await store.claimDue("refill", 1000, project.id))!;

        expect(refillClaim.operation.id).toBe(refill.operation.id);
        await store.beginSubmission(refillClaim);
        await store.complete(refillClaim, {
          effect: "applied",
          value: { kind: "execution", observation: { completed: true, exitCode: 0 } },
          encryptedOutput: "sealed-output",
          outputBytes: mebibyte,
        });

        // Keep the refill older than later captures in millisecond SQL ordering.
        await Bun.sleep(2);

        const oldestProjectCapture = await capture(await runningSandbox(), 16 * mebibyte);

        for (let index = 0; index < 14; index++)
          await capture(await runningSandbox(), 16 * mebibyte);
        const projectRefillSandbox = await runningSandbox();

        const projectRefill = await store.admitExec({
          projectId: project.id,
          sandboxId: projectRefillSandbox,
          endpoint: "POST /executions",
          key: Bun.randomUUIDv7(),
          intentHash: "project-refill",
          encryptedRequest: "sealed",
          captureBytes: 16 * mebibyte,
        });

        expect(projectRefill.operation.status).toBe("queued");
        expect((await store.getExecution(project.id, refill.execution!.id))?.output_state).toBe(
          "evicted",
        );
        expect((await store.getExecution(project.id, oldestProjectCapture))?.output_state).toBe(
          "captured",
        );
        const projectRefillClaim = (await store.claimDue("project-refill", 1000, project.id))!;

        expect(projectRefillClaim.operation.id).toBe(projectRefill.operation.id);
        await store.beginSubmission(projectRefillClaim);
        await store.complete(projectRefillClaim, {
          effect: "applied",
          value: { kind: "execution", observation: { completed: true, exitCode: 0 } },
          encryptedOutput: "sealed-output",
          outputBytes: 16 * mebibyte,
        });

        const activeSandbox = await runningSandbox();

        const active = await store.admitExec({
          projectId: project.id,
          sandboxId: activeSandbox,
          endpoint: "POST /executions",
          key: Bun.randomUUIDv7(),
          intentHash: "active",
          encryptedRequest: "sealed",
          captureBytes: 15 * mebibyte,
        });

        expect(active.operation.status).toBe("queued");

        const admission = () =>
          store.admitExec({
            projectId: project.id,
            sandboxId: activeSandbox,
            endpoint: "POST /executions",
            key: Bun.randomUUIDv7(),
            intentHash: "race",
            encryptedRequest: "sealed",
            captureBytes: mebibyte,
          });

        const race = await Promise.allSettled([admission(), admission()]);
        expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);

        const rejected = race.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );

        expect(rejected?.reason.code).toBe("OUTPUT_CAPACITY");
      } finally {
        await store.close();
      }
    });
    test("persists accepted intent and returns the same operation for a duplicate key", async () => {
      const { store, project, connection } = await fixture(dialect);

      try {
        const key = Bun.randomUUIDv7();
        const request = { environment: { kind: "prepared", imageId: "fake-starter" } };

        const first = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key,
          intentHash: "hash",
          request,
          connectionId: connection.id,
        });

        const second = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key,
          intentHash: "hash",
          request: { ...request, network: { policy: "different" } },
          connectionId: connection.id,
        });

        expect(first.operation.id).toBe(second.operation.id);
        expect(second.repeated).toBe(true);
        expect(JSON.parse(second.operation.request_json).network.policy).toBe("blocked");
        expect(await store.getOperation(project.id, first.operation.id)).toBeDefined();
        await expect(
          store.admitCreate({
            projectId: project.id,
            endpoint: "POST /sandboxes",
            key,
            intentHash: "changed",
            request,
            connectionId: connection.id,
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      } finally {
        await store.close();
      }
    });

    test("an expired lease after possible submission is observation only", async () => {
      const { store, project } = await fixture(dialect);

      try {
        const admission = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key: Bun.randomUUIDv7(),
          intentHash: "x",
          request: { environment: { kind: "prepared", imageId: "fake-starter" } },
        });

        const first = (await store.claimDue("runner", -1, project.id))!;
        expect(first.observeOnly).toBe(false);
        expect(await store.beginSubmission(first)).toBe(true);
        const second = (await store.claimDue("runner2", 1000, project.id))!;
        expect(second.operation.id).toBe(admission.operation.id);
        expect(second.observeOnly).toBe(true);
        expect(await store.beginSubmission(second)).toBe(false);
      } finally {
        await store.close();
      }
    });

    test("definitive destroy rejection reopens cleanup; unconfirmed stop never certifies deletion", async () => {
      const { store, project } = await fixture(dialect);

      try {
        const created = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key: Bun.randomUUIDv7(),
          intentHash: "create",
          request: { environment: { kind: "prepared", imageId: "fake-starter" } },
        });

        const createClaim = (await store.claimDue("create", 1000, project.id))!;
        await store.beginSubmission(createClaim);
        await store.complete(createClaim, {
          effect: "applied",
          value: {
            kind: "sandbox",
            observation: { ref: { nativeId: `native_${crypto.randomUUID()}` }, state: "running" },
          },
        });

        const destroy = await store.admitDestroy({
          projectId: project.id,
          sandboxId: created.sandbox.id,
          endpoint: `DELETE /sandboxes/${created.sandbox.id}`,
          key: Bun.randomUUIDv7(),
          intentHash: "destroy",
        });

        const destroyClaim = (await store.claimDue("destroy", 1000, project.id))!;
        await store.beginSubmission(destroyClaim);
        await store.failWithoutEffect(
          destroyClaim,
          { code: "CAPACITY", message: "Definitively rejected", effect: "none", retry: "never" },
          true,
        );
        expect((await store.getSandbox(project.id, created.sandbox.id))?.desired_state).toBe(
          "running",
        );

        const retry = await store.admitDestroy({
          projectId: project.id,
          sandboxId: created.sandbox.id,
          endpoint: `DELETE /sandboxes/${created.sandbox.id}`,
          key: Bun.randomUUIDv7(),
          intentHash: "destroy",
        });

        expect(retry.operation.id).not.toBe(destroy.operation.id);
        const retryClaim = (await store.claimDue("destroy-retry", 1000, project.id))!;
        await store.beginSubmission(retryClaim);
        await expect(
          store.complete(retryClaim, {
            effect: "partial",
            value: {
              kind: "destroy",
              observation: { computeStopped: false, retainedResources: [] },
            },
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect((await store.getSandbox(project.id, created.sandbox.id))?.observed_state).not.toBe(
          "destroyed",
        );
      } finally {
        await store.close();
      }
    });

    test("destroy cannot overtake queued or submitted sandbox work", async () => {
      const { store, project } = await fixture(dialect);

      try {
        const created = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key: Bun.randomUUIDv7(),
          intentHash: "create",
          request: { environment: { kind: "prepared", imageId: "fake-starter" } },
        });

        const createClaim = (await store.claimDue("create", 1000, project.id))!;
        await store.beginSubmission(createClaim);
        await store.complete(createClaim, {
          effect: "applied",
          value: {
            kind: "sandbox",
            observation: { ref: { nativeId: "native_ordered" }, state: "running" },
          },
        });
        const sandboxId = created.sandbox.id;

        const execution = await store.admitExec({
          projectId: project.id,
          sandboxId,
          endpoint: `POST /sandboxes/${sandboxId}/executions`,
          key: Bun.randomUUIDv7(),
          intentHash: "exec",
          encryptedRequest: "sealed-request",
          captureBytes: 0,
        });

        const destroyInput = {
          projectId: project.id,
          sandboxId,
          endpoint: `DELETE /sandboxes/${sandboxId}`,
          key: Bun.randomUUIDv7(),
          intentHash: "destroy",
        };

        await expect(store.admitDestroy(destroyInput)).rejects.toMatchObject({ code: "CONFLICT" });
        const execClaim = (await store.claimDue("exec", 1000, project.id))!;
        expect(execClaim.operation.id).toBe(execution.operation.id);
        expect(await store.beginSubmission(execClaim)).toBe(true);
        await expect(store.admitDestroy(destroyInput)).rejects.toMatchObject({ code: "CONFLICT" });
        await store.complete(execClaim, {
          effect: "applied",
          value: { kind: "execution", observation: { completed: true, exitCode: 0 } },
        });

        const file = await store.admitFileWrite({
          projectId: project.id,
          sandboxId,
          endpoint: `PUT /sandboxes/${sandboxId}/files`,
          key: Bun.randomUUIDv7(),
          intentHash: "file",
          path: "/data/test",
          overwrite: true,
          encryptedBytes: "sealed-bytes",
          bytes: 1,
        });

        await expect(store.admitDestroy(destroyInput)).rejects.toMatchObject({ code: "CONFLICT" });
        const fileClaim = (await store.claimDue("file", 1000, project.id))!;
        expect(fileClaim.operation.id).toBe(file.operation.id);
        await store.failWithoutEffect(fileClaim, {
          code: "UNSUPPORTED",
          message: "No effect",
          effect: "none",
          retry: "never",
        });
        expect((await store.admitDestroy(destroyInput)).operation.kind).toBe("destroy");
      } finally {
        await store.close();
      }
    });

    test("destroy completes locally after definitive create rejection", async () => {
      const { store, project } = await fixture(dialect);

      try {
        const created = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key: Bun.randomUUIDv7(),
          intentHash: "create",
          request: { environment: { kind: "prepared", imageId: "unsupported" } },
        });

        const createClaim = (await store.claimDue("create", 1000, project.id))!;
        await store.failWithoutEffect(createClaim, {
          code: "UNSUPPORTED",
          message: "Unsupported image",
          effect: "none",
          retry: "never",
        });
        const sandboxId = created.sandbox.id;

        const destroy = await store.admitDestroy({
          projectId: project.id,
          sandboxId,
          endpoint: `DELETE /sandboxes/${sandboxId}`,
          key: Bun.randomUUIDv7(),
          intentHash: "destroy",
        });

        expect(destroy.operation.status).toBe("succeeded");
        expect(destroy.operation.effect).toBe("none");
        expect(JSON.parse(destroy.operation.result_json!).observation.computeStopped).toBe(true);
        expect((await store.getSandbox(project.id, sandboxId))?.observed_state).toBe("destroyed");
        expect(await store.claimDue("destroy", 1000, project.id)).toBeUndefined();
      } finally {
        await store.close();
      }
    });

    test("queued destroy completes locally when create subsequently fails", async () => {
      const { store, project } = await fixture(dialect);

      try {
        const created = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key: Bun.randomUUIDv7(),
          intentHash: "create",
          request: { environment: { kind: "prepared", imageId: "unsupported" } },
        });

        const createClaim = (await store.claimDue("create", 1000, project.id))!;
        const sandboxId = created.sandbox.id;

        const destroy = await store.admitDestroy({
          projectId: project.id,
          sandboxId,
          endpoint: `DELETE /sandboxes/${sandboxId}`,
          key: Bun.randomUUIDv7(),
          intentHash: "destroy",
        });

        expect(destroy.operation.status).toBe("queued");
        await store.failWithoutEffect(createClaim, {
          code: "UNSUPPORTED",
          message: "Unsupported image",
          effect: "none",
          retry: "never",
        });
        const destroyClaim = (await store.claimDue("destroy", 1000, project.id))!;
        expect(destroyClaim.operation.id).toBe(destroy.operation.id);
        expect(await store.completeDestroyWithoutNative(destroyClaim)).toBe(true);
        expect((await store.getOperation(project.id, destroy.operation.id))?.status).toBe(
          "succeeded",
        );
        expect((await store.getSandbox(project.id, sandboxId))?.observed_state).toBe("destroyed");
      } finally {
        await store.close();
      }
    });

    test("rejected destroy preserves an unknown prior observation", async () => {
      const { store, project } = await fixture(dialect);

      try {
        const created = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key: Bun.randomUUIDv7(),
          intentHash: "create",
          request: { environment: { kind: "prepared", imageId: "fake-starter" } },
        });

        const createClaim = (await store.claimDue("create", 1000, project.id))!;
        await store.beginSubmission(createClaim);
        await store.complete(createClaim, {
          effect: "applied",
          value: {
            kind: "sandbox",
            observation: { ref: { nativeId: "native_uncertain" }, state: "unknown" },
          },
        });
        const sandboxId = created.sandbox.id;

        const destroy = await store.admitDestroy({
          projectId: project.id,
          sandboxId,
          endpoint: `DELETE /sandboxes/${sandboxId}`,
          key: Bun.randomUUIDv7(),
          intentHash: "destroy",
        });

        const destroyClaim = (await store.claimDue("destroy", 1000, project.id))!;
        expect(destroyClaim.operation.id).toBe(destroy.operation.id);
        await store.beginSubmission(destroyClaim);
        await store.failWithoutEffect(
          destroyClaim,
          { code: "UNAVAILABLE", message: "Definitively rejected", effect: "none", retry: "never" },
          true,
        );
        expect((await store.getSandbox(project.id, sandboxId))?.observed_state).toBe("unknown");
        expect((await store.getSandbox(project.id, sandboxId))?.desired_state).toBe("running");
      } finally {
        await store.close();
      }
    });

    test("destroy rejection keeps a create observation committed after deletion admission", async () => {
      const { store, project } = await fixture(dialect);

      try {
        const created = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key: Bun.randomUUIDv7(),
          intentHash: "create",
          request: { environment: { kind: "prepared", imageId: "fake-starter" } },
        });

        const createClaim = (await store.claimDue("create", 1000, project.id))!;
        await store.beginSubmission(createClaim);

        const destroy = await store.admitDestroy({
          projectId: project.id,
          sandboxId: created.sandbox.id,
          endpoint: `DELETE /sandboxes/${created.sandbox.id}`,
          key: Bun.randomUUIDv7(),
          intentHash: "destroy",
        });

        expect(JSON.parse(destroy.operation.request_json).previousObservedState).toBe("resolving");
        await store.complete(createClaim, {
          effect: "applied",
          value: {
            kind: "sandbox",
            observation: { ref: { nativeId: "native_late" }, state: "running" },
          },
        });
        const destroyClaim = (await store.claimDue("destroy", 1000, project.id))!;

        await store.beginSubmission(destroyClaim);
        await store.failWithoutEffect(
          destroyClaim,
          { code: "UNAVAILABLE", message: "Rejected", effect: "none", retry: "never" },
          true,
        );
        expect((await store.getSandbox(project.id, created.sandbox.id))?.observed_state).toBe(
          "running",
        );
        expect((await store.getSandbox(project.id, created.sandbox.id))?.desired_state).toBe(
          "running",
        );

        const execution = await store.admitExec({
          projectId: project.id,
          sandboxId: created.sandbox.id,
          endpoint: `POST /sandboxes/${created.sandbox.id}/executions`,
          key: Bun.randomUUIDv7(),
          intentHash: "usable-after-rejection",
          encryptedRequest: "sealed",
          captureBytes: 0,
        });

        expect(execution.operation.status).toBe("queued");
      } finally {
        await store.close();
      }
    });
  });
