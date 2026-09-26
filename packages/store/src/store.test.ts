import { describe, expect, test } from "bun:test";
import { bundledMigration, migrate, openMysqlBackend, openSqliteBackend, type Dialect } from "./backend";
import { ControlStore } from "./store";

async function fixture(dialect: Dialect) {
  const backend = dialect === "sqlite" ? openSqliteBackend(":memory:") : await openMysqlBackend(process.env.SANDBAR_TEST_MYSQL_URL!);
  await migrate(backend, bundledMigration(dialect));
  const store = new ControlStore(backend);
  const project = await store.createProject("test");
  const connection = await store.createConnection({ id: `conn_${crypto.randomUUID().replaceAll("-", "")}`, projectId: project.id, provider: "fake", name: "Local fake", encryptedCredentials: "ciphertext" });
  await store.verifyConnection(project.id, connection.id, "fake-local");
  return { store, project, connection };
}

for (const dialect of (["sqlite", ...(process.env.SANDBAR_TEST_MYSQL_URL ? ["mysql"] : [])] as Dialect[])) describe(`${dialect} durable admission`, () => {
  test("persists accepted intent and returns the same operation for a duplicate key", async () => {
    const { store, project, connection } = await fixture(dialect);
    try {
      const key = Bun.randomUUIDv7();
      const request = { environment: { kind: "prepared", imageId: "fake-starter" } };
      const first = await store.admitCreate({ projectId: project.id, endpoint: "POST /sandboxes", key, intentHash: "hash", request, connectionId: connection.id });
      const second = await store.admitCreate({ projectId: project.id, endpoint: "POST /sandboxes", key, intentHash: "hash", request: { ...request, network: { policy: "different" } }, connectionId: connection.id });
      expect(first.operation.id).toBe(second.operation.id);
      expect(second.repeated).toBe(true);
      expect(JSON.parse(second.operation.request_json).network.policy).toBe("blocked");
      expect(await store.getOperation(project.id, first.operation.id)).toBeDefined();
      await expect(store.admitCreate({ projectId: project.id, endpoint: "POST /sandboxes", key, intentHash: "changed", request, connectionId: connection.id })).rejects.toMatchObject({ code: "CONFLICT" });
    } finally { await store.close(); }
  });

  test("an expired lease after possible submission is observation only", async () => {
    const { store, project } = await fixture(dialect);
    try {
      const admission = await store.admitCreate({ projectId: project.id, endpoint: "POST /sandboxes", key: Bun.randomUUIDv7(), intentHash: "x", request: { environment: { kind: "prepared", imageId: "fake-starter" } } });
      const first = (await store.claimDue("runner", -1, project.id))!;
      expect(first.observeOnly).toBe(false);
      expect(await store.beginSubmission(first)).toBe(true);
      const second = (await store.claimDue("runner2", 1000, project.id))!;
      expect(second.operation.id).toBe(admission.operation.id);
      expect(second.observeOnly).toBe(true);
      expect(await store.beginSubmission(second)).toBe(false);
    } finally { await store.close(); }
  });

  test("definitive destroy rejection reopens cleanup; unconfirmed stop never certifies deletion", async () => {
    const { store, project } = await fixture(dialect);
    try {
      const created = await store.admitCreate({ projectId: project.id, endpoint: "POST /sandboxes", key: Bun.randomUUIDv7(), intentHash: "create", request: { environment: { kind: "prepared", imageId: "fake-starter" } } });
      const createClaim = (await store.claimDue("create", 1000, project.id))!;
      await store.beginSubmission(createClaim);
      await store.complete(createClaim, { effect: "applied", value: { kind: "sandbox", observation: { ref: { nativeId: `native_${crypto.randomUUID()}` }, state: "running" } } });
      const destroy = await store.admitDestroy({ projectId: project.id, sandboxId: created.sandbox.id, endpoint: `DELETE /sandboxes/${created.sandbox.id}`, key: Bun.randomUUIDv7(), intentHash: "destroy" });
      const destroyClaim = (await store.claimDue("destroy", 1000, project.id))!;
      await store.beginSubmission(destroyClaim);
      await store.failWithoutEffect(destroyClaim, { code: "CAPACITY", message: "Definitively rejected", effect: "none", retry: "never" }, true);
      expect((await store.getSandbox(project.id, created.sandbox.id))?.desired_state).toBe("running");
      const retry = await store.admitDestroy({ projectId: project.id, sandboxId: created.sandbox.id, endpoint: `DELETE /sandboxes/${created.sandbox.id}`, key: Bun.randomUUIDv7(), intentHash: "destroy" });
      expect(retry.operation.id).not.toBe(destroy.operation.id);
      const retryClaim = (await store.claimDue("destroy-retry", 1000, project.id))!;
      await store.beginSubmission(retryClaim);
      await expect(store.complete(retryClaim, { effect: "partial", value: { kind: "destroy", observation: { computeStopped: false, retainedResources: [] } } })).rejects.toMatchObject({ code: "CONFLICT" });
      expect((await store.getSandbox(project.id, created.sandbox.id))?.observed_state).not.toBe("destroyed");
    } finally { await store.close(); }
  });
});
