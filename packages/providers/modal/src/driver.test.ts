import { expect, test } from "bun:test";
import { Image, Sandbar, OutcomeUnknownError, type RecoveryReference } from "@sandbar/sdk/direct";
import { createModalRegistration, modalProvider, MODAL_ENDPOINT, type ModalTransport } from "./index";
import { ProviderReadError, type NativeRef } from "@sandbar/provider-spi";

const options = { tokenId: "ak-fixture", tokenSecret: "as-fixture", appName: "existing", environment: "main", region: "us-east-1", timeoutSeconds: 300 };
const identity = { projectId: "direct", operationId: "op_1", invocationKey: "01996553-a795-7a33-8bf1-73305942cdde", submissionId: "sub_1" };

class Fixture implements ModalTransport {
  readonly records = new Map<string, { id: string; tags: Record<string, string>; running: boolean }>();
  creates = 0;
  terminates = 0;
  writes = 0;
  throwAfterCreate = false;
  throwAfterTerminate = false;
  malformedCreateId = false;
  appId = "ap-fixture";
  file = Uint8Array.from([0, 255, 128, 42]);
  async lookupApp(appName: string, environment: string) {
    if (appName !== "existing" || environment !== "main") throw new Error("Wrong app scope");
    return this.appId;
  }
  async imageExists(imageId: string) { return imageId === "im-fixture"; }
  async create(input: { appId: string; imageId: string; name: string; tags: Record<string, string>; timeoutMs: number; regions?: string[] }) {
    if (input.appId !== this.appId || input.imageId !== "im-fixture" || input.timeoutMs !== 300_000 || input.regions?.[0] !== "us-east-1") throw new Error("Wrong native create input");
    this.creates++;
    const id = this.malformedCreateId ? "bad!" : `sb-${this.creates}`;
    this.records.set(input.name, { id, tags: input.tags, running: true });
    if (this.throwAfterCreate) throw new Error("lost response after apply");
    return id;
  }
  async findByName(_appName: string, _environment: string, name: string) { return this.records.get(name) ?? null; }
  async *list(appId: string) {
    if (appId !== this.appId) throw new Error("Wrong app inventory scope");
    for (const record of this.records.values()) if (record.running) yield record;
  }
  async terminate(sandboxId: string) {
    this.terminates++;
    for (const record of this.records.values()) if (record.id === sandboxId) record.running = false;
    if (this.throwAfterTerminate) throw new Error("lost response after apply");
    return true;
  }
  async readBytes(_sandboxId: string, _path: string, maxBytes: number) {
    if (this.file.length > maxBytes) throw new Error("too large");
    return this.file;
  }
  close() {}
}

test("factory binds server App identity, environment and fixed endpoint", async () => {
  const fixture = new Fixture();
  const provider = await modalProvider(options, fixture);
  const scope = provider.scope as unknown as { resourceScope: { kind: string; id: string }; accountId?: string; endpoint?: string };
  expect(scope.resourceScope).toEqual({ kind: "app", id: "ap-fixture" });
  expect(scope.accountId).toBeUndefined();
  expect(scope.endpoint).toBe(MODAL_ENDPOINT);
  expect(provider.scope.region).toBe("us-east-1");
  expect(provider.ownership).toBe("owned");
  provider.release();
});

test("service registration validates secret/config maps and pins stored connection ID", async () => {
  const fixture = new Fixture();
  let transportCreations = 0;
  const registration = createModalRegistration(() => { transportCreations++; return fixture; });
  expect(() => registration.validate({ credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture", extra: "hidden" }, configuration: { appName: "existing", environment: "main" } })).toThrow();
  await expect(registration.connect({ connectionId: "conn_modal", credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" }, configuration: { appName: "existing", environment: "main", timeoutSeconds: "1" } })).rejects.toThrow();
  expect(transportCreations).toBe(0);
  const lease = await registration.connect({ connectionId: "conn_modal", credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" }, configuration: { appName: "existing", environment: "main", region: "us-east-1", timeoutSeconds: "300" } });
  expect(transportCreations).toBe(1);
  expect(lease.scope.connectionId).toBe("conn_modal");
  expect(lease.scope.region).toBe("us-east-1");
  lease.release();
});

test("prepare rejects OCI and nonblocked network before any create", async () => {
  const fixture = new Fixture();
  const { driver, scope } = await modalProvider(options, fixture);
  expect((await driver.prepare({ scope, image: { kind: "oci", value: "alpine:latest" }, networkPolicy: "blocked" })).supported).toBe(false);
  expect((await driver.prepare({ scope, image: { kind: "prepared", value: "im-fixture" }, networkPolicy: "open" })).supported).toBe(false);
  expect((await driver.prepare({ scope, image: { kind: "prepared", value: "im-fixture" }, networkPolicy: "blocked", region: "us-east-1" })).supported).toBe(true);
  expect(fixture.creates).toBe(0);
});

test("lost create response is observed by submission name after a fresh provider factory, without replay", async () => {
  const fixture = new Fixture();
  fixture.throwAfterCreate = true;
  const first = await modalProvider(options, fixture);
  const result = await first.driver.create({ scope: first.scope, identity, image: "im-fixture", networkPolicy: "blocked" });
  expect(result.status).toBe("unknown");
  expect(fixture.creates).toBe(1);
  const restarted = await modalProvider(options, fixture);
  expect(restarted.scope).toEqual(first.scope);
  const observed = await restarted.driver.observe({ scope: restarted.scope, submissionId: identity.submissionId, operationId: identity.operationId });
  expect(observed?.status).toBe("completed");
  expect(await restarted.driver.observe({ scope: restarted.scope, submissionId: identity.submissionId, operationId: "op_other" })).toBeNull();
  expect(fixture.creates).toBe(1);
});

test("malformed post-create identity remains unknown and is never replayed", async () => {
  const fixture = new Fixture();
  fixture.malformedCreateId = true;
  const { driver, scope } = await modalProvider(options, fixture);
  expect((await driver.create({ scope, identity, image: "im-fixture", networkPolicy: "blocked" })).status).toBe("unknown");
  expect(fixture.creates).toBe(1);
});

test("scope mismatch blocks reads and destructive operations before effects", async () => {
  const fixture = new Fixture();
  const { driver, scope } = await modalProvider(options, fixture);
  const wrong: NativeRef = { kind: "sandbox", nativeId: "sb-outside", scope: { ...scope, resourceScope: { kind: "app", id: "ap-outside" } } as NativeRef["scope"] };
  await expect(driver.inspect(wrong)).rejects.toThrow();
  expect((await driver.destroy({ sandbox: wrong, identity })).status).toBe("rejected");
  expect(fixture.terminates).toBe(0);
});

test("binary reads work; exec and writes reject before provider mutation", async () => {
  const fixture = new Fixture();
  const { driver, scope } = await modalProvider(options, fixture);
  const created = await driver.create({ scope, identity, image: "im-fixture", networkPolicy: "blocked" });
  if (created.status !== "completed" || created.value.kind !== "sandbox") throw new Error("Fixture create failed");
  const ref = created.value.observation.ref;
  expect(await driver.readFile({ sandbox: ref, path: "/tmp/blob" })).toEqual(fixture.file);
  fixture.file = Uint8Array.from({ length: 1_048_577 }, () => 1);
  await expect(driver.readFile({ sandbox: ref, path: "/tmp/blob" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  fixture.file = Uint8Array.from([0, 255, 128, 42]);
  expect((await driver.exec({ sandbox: ref, identity, command: { kind: "argv", argv: ["true"] }, deadlineSeconds: 30, maxOutputBytes: 1024 })).status).toBe("rejected");
  expect((await driver.writeFile({ sandbox: ref, identity, path: "/tmp/blob", bytes: fixture.file, overwrite: true })).status).toBe("rejected");
  expect(fixture.writes).toBe(0);
  expect(fixture.terminates).toBe(0);
});

test("native not-found file evidence is kept distinct from malformed data", async () => {
  const fixture = new Fixture();
  fixture.readBytes = async () => { throw new ProviderReadError("NOT_FOUND", "File absent"); };
  const { driver, scope } = await modalProvider(options, fixture);
  const created = await driver.create({ scope, identity, image: "im-fixture", networkPolicy: "blocked" });
  if (created.status !== "completed" || created.value.kind !== "sandbox") throw new Error("Fixture create failed");
  await expect(driver.readFile({ sandbox: created.value.observation.ref, path: "/tmp/absent" })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("lost termination response stays unknown and is not retried", async () => {
  const fixture = new Fixture();
  const { driver, scope } = await modalProvider(options, fixture);
  const created = await driver.create({ scope, identity, image: "im-fixture", networkPolicy: "blocked" });
  if (created.status !== "completed" || created.value.kind !== "sandbox") throw new Error("Fixture create failed");
  fixture.throwAfterTerminate = true;
  const result = await driver.destroy({ sandbox: created.value.observation.ref, identity: { ...identity, submissionId: "sub_destroy" } });
  expect(result.status).toBe("unknown");
  expect(fixture.terminates).toBe(1);
});

test("direct SDK uses the same package and returns recovery reference after an applied lost response", async () => {
  const fixture = new Fixture();
  fixture.throwAfterCreate = true;
  const provider = await modalProvider(options, fixture);
  const client = Sandbar.direct({ provider });
  let reference: RecoveryReference | undefined;
  try {
    await client.sandboxes.create({ environment: Image.prepared("im-fixture"), networkPolicy: "blocked", region: "us-east-1" });
    throw new Error("Expected uncertain create");
  } catch (error) {
    if (!(error instanceof OutcomeUnknownError)) throw error;
    reference = error.reference;
  }
  if (!reference) throw new Error("Missing recovery reference");
  expect(fixture.creates).toBe(1);
  const resumed = Sandbar.direct({ provider: await modalProvider(options, fixture) });
  const box = await (await resumed.recover(reference)).wait({ pollMs: 50 });
  expect(box).toHaveProperty("id");
  expect(fixture.creates).toBe(1);
  await resumed.close();
  await client.close();
});

test("pre-aborted direct create has no provider submission", async () => {
  const fixture = new Fixture();
  const client = Sandbar.direct({ provider: await modalProvider(options, fixture) });
  const abort = new AbortController();
  abort.abort();
  await expect(client.sandboxes.create({ environment: Image.prepared("im-fixture"), networkPolicy: "blocked", region: "us-east-1" }, { signal: abort.signal })).rejects.toThrow();
  expect(fixture.creates).toBe(0);
  await client.close();
});
