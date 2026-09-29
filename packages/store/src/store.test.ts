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

test("SQLite evicts retained output under pressure and expires aged output on read after restart", async () => {
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

    const refillClaim = (await store.claimDue("refill", 1000, project.id))!;
    await store.beginSubmission(refillClaim);
    await store.complete(refillClaim, {
      effect: "applied",
      value: { kind: "execution", observation: { completed: true, exitCode: 7 } },
      encryptedOutput: "fresh-ciphertext",
      outputBytes: 1,
    });
    await store.backend.run(
      sql`UPDATE executions SET completed_at=${Date.now() - 24 * 60 * 60 * 1000 - 60_000} WHERE id=${refill.execution!.id}`,
    );
    await store.close();
    store = new ControlStore(openSqliteBackend(path));

    const expired = await store.getExecution(project.id, refill.execution!.id);

    expect(expired?.output_state).toBe("expired");
    expect(expired?.output_ciphertext).toBeNull();
    expect(expired?.output_bytes).toBe(1);
    expect(expired?.exit_code).toBe(7);

    const reservation = await store.backend.row<{ state: string }>(
      sql`SELECT state FROM reservations WHERE operation_id=${refill.operation.id} AND kind='output'`,
    );

    expect(reservation?.state).toBe("released");
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
    test("adapter checkpoints retain the lease and reject a stale generation", async () => {
      const { store, project, connection } = await fixture(dialect);

      try {
        const accepted = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key: Bun.randomUUIDv7(),
          intentHash: "checkpoint",
          request: { environment: { kind: "prepared", imageId: "fake-starter" } },
          connectionId: connection.id,
        });

        const claim = (await store.claimDue("first", 1000, project.id))!;
        await expect(store.checkpointAdapterToken(claim, "before-marker")).rejects.toMatchObject({
          code: "CONFLICT",
        });
        expect(await store.beginSubmission(claim)).toBe(true);
        await store.checkpointAdapterToken(claim, "first-encrypted-token");
        const saved = await store.getOperation(project.id, accepted.operation.id);
        expect(saved?.adapter_token_ciphertext).toBe("first-encrypted-token");
        expect(saved?.lease_owner).toBe("first");
        expect(Number(saved?.lease_generation)).toBe(claim.generation);
        expect(saved?.status).toBe("running");
        expect(saved?.next_attempt_at).toBeNull();
        expect(await store.claimDue("second", 1000, project.id)).toBeUndefined();
        await store.backend.run(
          sql`UPDATE operations SET lease_expires_at=0 WHERE id=${accepted.operation.id}`,
        );
        const replacement = (await store.claimDue("second", 1000, project.id))!;
        expect(replacement.observeOnly).toBe(true);
        expect(replacement.operation.adapter_token_ciphertext).toBe("first-encrypted-token");
        await expect(store.checkpointAdapterToken(claim, "stale-token")).rejects.toMatchObject({
          code: "CONFLICT",
        });
        expect(
          (await store.getOperation(project.id, accepted.operation.id))?.adapter_token_ciphertext,
        ).toBe("first-encrypted-token");
      } finally {
        await store.close();
      }
    });

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
            sandboxId: terminal.operation.sandbox_id!,
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
            sandboxId: terminal.operation.sandbox_id!,
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
    test("completed output expires at the age cutoff without a new admission", async () => {
      const { store, project, connection } = await fixture(dialect);

      try {
        const created = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key: Bun.randomUUIDv7(),
          intentHash: "create",
          request: { environment: { kind: "prepared", imageId: "fake-starter" } },
          connectionId: connection.id,
        });

        const createClaim = (await store.claimDue("setup", 1000, project.id))!;
        await store.beginSubmission(createClaim);
        await store.complete(createClaim, {
          effect: "applied",
          value: {
            kind: "sandbox",
            observation: { ref: { nativeId: "native_retention" }, state: "running" },
          },
        });

        const capture = async (name: string) => {
          const admitted = await store.admitExec({
            projectId: project.id,
            sandboxId: created.sandbox.id,
            endpoint: "POST /executions",
            key: Bun.randomUUIDv7(),
            intentHash: name,
            encryptedRequest: "sealed",
            captureBytes: 1,
          });

          const claim = (await store.claimDue(name, 1000, project.id))!;
          await store.beginSubmission(claim);
          await store.complete(claim, {
            effect: "applied",
            value: { kind: "execution", observation: { completed: true, exitCode: 7 } },
            encryptedOutput: "sealed-output",
            outputBytes: 1,
          });

          return admitted;
        };

        const aged = await capture("aged");
        const fresh = await capture("fresh");

        const pending = await store.admitExec({
          projectId: project.id,
          sandboxId: created.sandbox.id,
          endpoint: "POST /executions",
          key: Bun.randomUUIDv7(),
          intentHash: "pending",
          encryptedRequest: "sealed",
          captureBytes: 1,
        });

        const pendingClaim = (await store.claimDue("pending", 1000, project.id))!;
        await store.beginSubmission(pendingClaim);
        await store.reschedule(pendingClaim, "outcome_unknown", 5_000, "DRIVER_ERROR");

        const at = Date.now() + 60 * 60 * 1000;
        const cutoff = at - 24 * 60 * 60 * 1000;
        await store.backend.run(
          sql`UPDATE executions SET completed_at=${cutoff - 1} WHERE id=${aged.execution!.id}`,
        );
        await store.backend.run(
          sql`UPDATE executions SET completed_at=${cutoff + 1} WHERE id=${fresh.execution!.id}`,
        );

        expect(await store.expireOutputs(at)).toBe(1);
        expect(await store.expireOutputs(at)).toBe(0);
        const agedRow = await store.getExecution(project.id, aged.execution!.id);
        const freshRow = await store.getExecution(project.id, fresh.execution!.id);

        expect(agedRow).toMatchObject({
          output_state: "expired",
          output_ciphertext: null,
          output_bytes: 1,
          exit_code: 7,
          status: "completed",
        });
        expect(freshRow?.output_state).toBe("captured");
        expect(freshRow?.output_ciphertext).toBe("sealed-output");

        const reservations = await store.backend.rows<{
          operation_id: string;
          state: string;
        }>(
          sql`SELECT operation_id,state FROM reservations WHERE project_id=${project.id} AND kind='output'`,
        );

        expect(reservations.find((row) => row.operation_id === aged.operation.id)?.state).toBe(
          "released",
        );
        expect(reservations.find((row) => row.operation_id === fresh.operation.id)?.state).toBe(
          "active",
        );
        expect(reservations.find((row) => row.operation_id === pending.operation.id)?.state).toBe(
          "active",
        );
        expect((await store.getOperation(project.id, pending.operation.id))?.status).toBe(
          "unknown",
        );
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
        const prematureDestroy = (await store.claimDue("early-destroy", 1000, project.id))!;
        expect(prematureDestroy.operation.id).toBe(destroy.operation.id);
        expect(await store.completeDestroyWithoutNative(prematureDestroy)).toBe(false);
        await store.reschedule(prematureDestroy, "waiting_for_native_identity", 5_000);
        expect(await store.claimDue("before-create-fails", 1000, project.id)).toBeUndefined();
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
