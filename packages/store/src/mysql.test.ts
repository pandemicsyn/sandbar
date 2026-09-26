import { expect, test } from "bun:test";
import { bundledMigration, migrate, openMysqlBackend } from "./backend";
import { ControlStore } from "./store";

const url = process.env.SANDBAR_TEST_MYSQL_URL;
test.skipIf(!url)("MySQL 8.4 runs the same admission, lease and observation invariants", async () => {
  const backend = await openMysqlBackend(url!);
  try {
    await migrate(backend, bundledMigration("mysql"));
    const store = new ControlStore(backend);
    const project = await store.createProject(`mysql-test-${crypto.randomUUID()}`);
    const connection = await store.createConnection({ id: `conn_${crypto.randomUUID().replaceAll("-", "")}`, projectId: project.id, provider: "fake", name: "Fake", encryptedCredentials: "ciphertext" });
    await store.verifyConnection(project.id, connection.id, "fake-local");
    const key = Bun.randomUUIDv7();
    const request = { environment: { kind: "prepared", imageId: "fake-starter" } };
    const first = await store.admitCreate({ projectId: project.id, endpoint: "POST /sandboxes", key, intentHash: "x", request, connectionId: connection.id });
    const same = await store.admitCreate({ projectId: project.id, endpoint: "POST /sandboxes", key, intentHash: "x", request, connectionId: connection.id });
    expect(same.operation.id).toBe(first.operation.id);
    await expect(store.admitCreate({ projectId: project.id, endpoint: "POST /sandboxes", key, intentHash: "different", request, connectionId: connection.id })).rejects.toMatchObject({ code: "CONFLICT" });
    const claim = (await store.claimDue("mysql-runner", -1, project.id))!;
    expect(claim.observeOnly).toBe(false);
    expect(await store.beginSubmission(claim)).toBe(true);
    const recovered = (await store.claimDue("mysql-recovery", 1000, project.id))!;
    expect(recovered.operation.id).toBe(first.operation.id);
    expect(recovered.observeOnly).toBe(true);
    await store.complete(recovered, { effect: "applied", value: { kind: "sandbox", observation: { ref: { nativeId: "native_mysql" }, state: "running" } } });
    expect((await store.getSandbox(project.id, first.sandbox.id))?.observed_state).toBe("running");
  } finally { await backend.close(); }
});
