import { describe, expect, test } from "bun:test";
import { bundledMigration, migrate, openSqliteBackend } from "./backend";
import { ControlStore, StoreError } from "./store";

async function fixture() {
  const backend = openSqliteBackend(":memory:");
  await migrate(backend, bundledMigration("sqlite"));
  const store = new ControlStore(backend);
  const project = await store.createProject("test");
  const connection = await store.createConnection({ id: "conn_test", projectId: project.id, provider: "fake", name: "Local fake", encryptedCredentials: "ciphertext" });
  await store.verifyConnection(project.id, connection.id, "fake-local");
  return { store, project, connection };
}

describe("durable admission", () => {
  test("persists accepted intent and returns the same operation for a duplicate key", async () => {
    const { store, project, connection } = await fixture();
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
    const { store, project } = await fixture();
    try {
      const admission = await store.admitCreate({ projectId: project.id, endpoint: "POST /sandboxes", key: Bun.randomUUIDv7(), intentHash: "x", request: { environment: { kind: "prepared", imageId: "fake-starter" } } });
      const first = (await store.claimDue("runner", -1))!;
      expect(first.observeOnly).toBe(false);
      expect(await store.beginSubmission(first)).toBe(true);
      const second = (await store.claimDue("runner2", 1000))!;
      expect(second.operation.id).toBe(admission.operation.id);
      expect(second.observeOnly).toBe(true);
      expect(await store.beginSubmission(second)).toBe(false);
    } finally { await store.close(); }
  });
});
