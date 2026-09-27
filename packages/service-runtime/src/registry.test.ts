import { expect, test } from "bun:test";
import type { ProviderDriver } from "@sandbar/provider-spi";
import type { ConnectionRow, ControlStore } from "@sandbar/store";
import { bundledMigration, migrate, openSqliteBackend } from "@sandbar/store";
import { ProviderRegistry, storedScope, type ProviderRegistration } from "./registry";
import type { SecretBox } from "./crypto";
import { DurableRunner } from "./runner";

test("registry releases an owned transport on scope mismatch and keeps borrowed transports untouched", async () => {
  const scope = { provider: "modal", connectionId: "conn_1", resourceScope: { kind: "app" as const, id: "app-1" }, region: "prod", endpoint: "https://api.modal.com" };
  let releases = 0;
  const driver = { name: "modal" } as ProviderDriver;
  const registration: ProviderRegistration = {
    provider: "modal", validate: input => input,
    async connect() { return { driver, scope, ownership: "owned" as const, release: async () => { releases++; } }; },
  };
  const secrets = { open: async () => JSON.stringify({ credentials: {}, configuration: {} }) } as unknown as SecretBox;
  const registry = new ProviderRegistry({} as ControlStore, secrets, [registration]);
  const row = { id: "conn_1", provider: "modal", encrypted_credentials: "cipher", scope: storedScope(scope) } as ConnectionRow;
  const lease = await registry.connect(row);
  expect(releases).toBe(0);
  if (lease.ownership === "owned") await lease.release();
  expect(releases).toBe(1);
  await expect(registry.connect({ ...row, scope: storedScope({ ...scope, resourceScope: { kind: "app", id: "app-other" } }) })).rejects.toThrow("scope");
  expect(releases).toBe(2);
});

test("runner releases an owned provider lease after an unknown mutation without replay", async () => {
  const backend = openSqliteBackend(":memory:");
  await migrate(backend, bundledMigration("sqlite"));
  const store = new (await import("@sandbar/store")).ControlStore(backend);
  try {
    const project = await store.createProject("Lease test");
    const scope = { provider: "fake", connectionId: "conn_owned", accountId: "fake-local", region: "local" };
    await store.createConnection({ id: "conn_owned", projectId: project.id, provider: "fake", name: "Owned", encryptedCredentials: "cipher" });
    await store.verifyConnection(project.id, "conn_owned", storedScope(scope));
    const secrets = { open: async () => JSON.stringify({ credentials: {}, configuration: {} }) } as unknown as SecretBox;
    let submissions = 0, releases = 0;
    const unsupported = async () => { throw new Error("unexpected call"); };
    const driver: ProviderDriver = { name: "fake", capabilities: unsupported, prepare: async () => ({ supported: true, effectiveImage: "fake-starter" }), create: async input => { submissions++; return { status: "unknown", effect: "possible", submissionId: input.identity.submissionId, reason: "lost" }; }, inspect: unsupported, inventory: unsupported, exec: unsupported, readFile: unsupported, writeFile: unsupported, destroy: unsupported, observe: async () => null };
    const registration: ProviderRegistration = { provider: "fake", validate: input => input, async connect() { return { driver, scope, ownership: "owned", release: async () => { releases++; } }; } };
    const registry = new ProviderRegistry(store, secrets, [registration]);
    const admitted = await store.admitCreate({ projectId: project.id, endpoint: "POST /sandboxes", key: Bun.randomUUIDv7(), intentHash: "owned", request: { environment: { kind: "prepared", imageId: "fake-starter" } }, connectionId: "conn_owned" });
    await new DurableRunner({ store, registry, secrets }).tick();
    expect((await store.getOperation(project.id, admitted.operation.id))?.status).toBe("unknown");
    expect(submissions).toBe(1);
    expect(releases).toBe(1);
  } finally { await store.close(); }
});
