import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProviderDriver } from "./index";
import { FakeProviderEngine } from "./engine";
import { startFakeProviderServer } from "./server";
import { ProviderReadError } from "@sandbar/provider-spi";

const token = "local-test-token-12345";

const scope = {
  provider: "fake",
  connectionId: "conn_1",
  accountId: "fake-local",
  region: "local",
};

const identity = (submissionId: string) => ({
  projectId: "project_1",
  operationId: submissionId,
  invocationKey: `key_${submissionId}`,
  submissionId,
});

const command = { kind: "argv" as const, argv: ["fixture", "hello"] };

type FileReadPayload = { bytesBase64: string | number | null; extra?: boolean };

type InventoryPayload = { items: never[] | string; nextCursor?: string | number; extra?: boolean };

const fetchStub = (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch => Object.assign(handler, { preconnect: fetch.preconnect });

let server: Awaited<ReturnType<typeof startFakeProviderServer>> | undefined;

let directory: string | undefined;

async function setup(statePath?: string) {
  directory ??= await mkdtemp(join(tmpdir(), "sandbar-fake-"));
  server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: statePath ?? join(directory, "provider.json"),
    token,
    testMode: true,
  });
  const baseUrl = server.url.toString();
  const driver = new FakeProviderDriver({ baseUrl, token });

  const control = async <T>(path: string, body?: T) => {
    const response = await fetch(new URL(path, baseUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    expect(response.ok).toBe(true);

    return response.json();
  };

  return { driver, control, statePath: statePath ?? join(directory, "provider.json") };
}

afterEach(async () => {
  server?.stop(true);
  server = undefined;

  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("independent fake provider", () => {
  test("lost create and exec responses remain observable across Sandbar-facing restart without duplicate effects", async () => {
    const { driver, control, statePath } = await setup();
    await control("/_test/seed", {
      submissionId: "create_1",
      action: "create",
      behavior: "lost_after_effect",
    });

    const first = await driver.create({
      scope,
      identity: identity("create_1"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    expect(first.status).toBe("unknown");
    server?.stop(true);
    server = undefined;
    const restarted = await setup(statePath);
    const recovered = await restarted.driver.observe({ scope, submissionId: "create_1" });
    expect(recovered?.status).toBe("completed");

    if (recovered?.status !== "completed" || recovered.value.kind !== "sandbox")
      throw new Error("No sandbox observation");
    const sandbox = recovered.value.observation.ref;
    await restarted.control("/_test/seed", {
      submissionId: "exec_1",
      action: "exec",
      behavior: "lost_after_effect",
      command: {
        command,
        exitCode: 7,
        stdoutBase64: Buffer.from("fixture output").toString("base64"),
      },
    });

    const execution = await restarted.driver.exec({
      sandbox,
      identity: identity("exec_1"),
      command,
      deadlineSeconds: 30,
      maxOutputBytes: 1024,
    });

    expect(execution.status).toBe("unknown");
    const observedExec = await restarted.driver.observe({ scope, submissionId: "exec_1" });
    expect(observedExec?.status).toBe("completed");

    if (observedExec?.status !== "completed" || observedExec.value.kind !== "execution")
      throw new Error("No execution observation");
    expect(observedExec.value.observation.exitCode).toBe(7);
    expect(
      Buffer.from(observedExec.value.observation.stdoutBase64 ?? "", "base64").toString(),
    ).toBe("fixture output");
    const state = await restarted.control("/_test/state");
    expect(state.resources).toHaveLength(1);
    expect(state.invocations.filter((x: { action: string }) => x.action === "create")).toHaveLength(
      1,
    );
    expect(state.invocations.filter((x: { action: string }) => x.action === "exec")).toHaveLength(
      1,
    );
  });

  test("non-idempotent and undiscoverable ambiguous submission cannot be treated as safe to replay", async () => {
    const { driver, control } = await setup();
    await control("/_test/profile", {
      nativeIdempotency: { create: false, exec: false, destroy: false },
      discoveryBySubmission: false,
    });
    await control("/_test/seed", {
      submissionId: "create_2",
      action: "create",
      behavior: "lost_after_effect",
    });
    expect(
      (
        await driver.create({
          scope,
          identity: identity("create_2"),
          image: "fake-starter",
          networkPolicy: "blocked",
        })
      ).status,
    ).toBe("unknown");
    expect(await driver.observe({ scope, submissionId: "create_2" })).toBeNull();
    const before = await control("/_test/state");
    expect(before.resources).toHaveLength(1);
    // A deliberate direct redispatch demonstrates why the control runner must not do this.
    await driver.create({
      scope,
      identity: identity("create_2"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });
    const after = await control("/_test/state");
    expect(after.resources).toHaveLength(2);
    expect(after.invocations).toHaveLength(2);
  });

  test("explicit command fixtures, binary files, and definitive rejection have honest effects", async () => {
    const { driver, control } = await setup();

    const created = await driver.create({
      scope,
      identity: identity("create_3"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    if (created.status !== "completed" || created.value.kind !== "sandbox")
      throw new Error("Create failed");
    const sandbox = created.value.observation.ref;

    const unsupported = await driver.exec({
      sandbox,
      identity: identity("exec_unsupported"),
      command,
      deadlineSeconds: 30,
      maxOutputBytes: 1024,
    });

    expect(unsupported.status).toBe("rejected");
    expect(unsupported.effect).toBe("none");
    const data = Uint8Array.from([0, 255, 1]);

    const written = await driver.writeFile({
      sandbox,
      identity: identity("write_1"),
      path: "/data/blob",
      bytes: data,
      overwrite: false,
    });

    expect(written.status).toBe("completed");
    expect(await driver.readFile({ sandbox, path: "/data/blob" })).toEqual(data);
    await control("/_test/seed", {
      submissionId: "destroy_1",
      action: "destroy",
      behavior: "reject",
      rejectCode: "capacity",
    });
    const rejected = await driver.destroy({ sandbox, identity: identity("destroy_1") });
    expect(rejected.status).toBe("rejected");
    expect((await driver.inspect(sandbox))?.state).toBe("running");
  });

  test("delayed observation and duplicate out-of-order events are deterministic test controls", async () => {
    const { driver, control } = await setup();
    await control("/_test/seed", {
      submissionId: "create_delayed",
      action: "create",
      delayObservations: 2,
    });

    const submitted = await driver.create({
      scope,
      identity: identity("create_delayed"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    expect(submitted.status).toBe("pending");
    expect((await driver.observe({ scope, submissionId: "create_delayed" }))?.status).toBe(
      "pending",
    );
    expect((await driver.observe({ scope, submissionId: "create_delayed" }))?.status).toBe(
      "pending",
    );
    const completed = await driver.observe({ scope, submissionId: "create_delayed" });

    if (completed?.status !== "completed" || completed.value.kind !== "sandbox")
      throw new Error("Missing delayed create");
    const ref = completed.value.observation.ref;
    const occurredAt = "2026-01-01T00:00:00Z";
    await control("/_test/events/seed", [
      { eventId: "event_2", ref, sequence: 2, state: "destroyed", occurredAt },
      { eventId: "event_1", ref, sequence: 1, state: "running", occurredAt },
      { eventId: "event_2", ref, sequence: 2, state: "destroyed", occurredAt },
    ]);
    expect((await driver.events(scope)).map((x) => x.eventId)).toEqual([
      "event_2",
      "event_1",
      "event_2",
    ]);
  });

  test("test controls are absent when test mode is disabled", async () => {
    const { statePath } = await setup();
    server?.stop(true);
    server = await startFakeProviderServer({
      hostname: "127.0.0.1",
      port: 0,
      statePath,
      token,
      testMode: false,
    });

    const response = await fetch(new URL("/_test/state", server.url), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(404);
  });

  test("exported fake server refuses non-loopback binds at runtime", async () => {
    directory = await mkdtemp(join(tmpdir(), "sandbar-fake-"));
    // SAFETY: This test deliberately passes a disallowed hostname to verify the runtime guard rejects it before binding a socket.
    await expect(
      startFakeProviderServer({
        hostname: "0.0.0.0" as "127.0.0.1",
        port: 0,
        statePath: join(directory, "state.json"),
        token,
        testMode: true,
      }),
    ).rejects.toThrow("loopback");
  });

  test("fake driver refuses remote destinations before sending its transport token", () => {
    let calls = 0;

    const transport = fetchStub(async () => {
      calls++;
      throw new Error("must not be called");
    });

    expect(
      () => new FakeProviderDriver({ baseUrl: "https://example.com", token, fetch: transport }),
    ).toThrow("loopback");
    expect(calls).toBe(0);
  });

  test("fake driver retains the validated endpoint, token, and transport after options mutate", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];

    const transport = fetchStub(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("Authorization"),
      });

      return Response.json({
        provider: "fake",
        nativeIdempotency: { create: true, exec: true, destroy: true, writeFile: true },
        discoveryBySubmission: true,
        supports: { argv: true, shell: true, fileBytes: true, inventory: true },
        maxFileBytes: 1048576,
        maxOutputBytes: 1048576,
        networkPolicies: ["blocked"],
      });
    });

    let changedTransportCalls = 0;
    const options = { baseUrl: "http://127.0.0.1:8789", token, fetch: transport };
    const driver = new FakeProviderDriver(options);
    options.baseUrl = "https://example.com";
    options.token = "changed-token";
    options.fetch = fetchStub(async () => {
      changedTransportCalls++;
      throw new Error("changed transport called");
    });
    expect((await driver.capabilities(scope)).provider).toBe("fake");
    expect(requests).toEqual([
      { url: "http://127.0.0.1:8789/v1/action", authorization: `Bearer ${token}` },
    ]);
    expect(changedTransportCalls).toBe(0);
  });

  test("fake driver rejects malformed file read envelopes before decoding", async () => {
    let payload: FileReadPayload = { bytesBase64: "not-base64" };
    const transport = fetchStub(async () => Response.json(payload));

    const driver = new FakeProviderDriver({
      baseUrl: "http://127.0.0.1:8789",
      token,
      fetch: transport,
    });

    const input = {
      sandbox: { scope, nativeId: "fake_sandbox_1", kind: "sandbox" as const },
      path: "/blob",
    };

    for (payload of [
      { bytesBase64: "not-base64" },
      { bytesBase64: 4 },
      { bytesBase64: "AA==", extra: true },
      { bytesBase64: "A".repeat(1_398_104) },
    ]) {
      await expect(driver.readFile(input)).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        name: "ProviderReadError",
      });
    }

    payload = { bytesBase64: null };
    await expect(driver.readFile(input)).rejects.toBeInstanceOf(ProviderReadError);
    await expect(driver.readFile(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    payload = { bytesBase64: "AP8B" };
    expect(await driver.readFile(input)).toEqual(Uint8Array.from([0, 255, 1]));
  });

  test("fake driver validates the complete inventory response envelope", async () => {
    let payload: InventoryPayload = { items: [], nextCursor: 4 };
    const transport = fetchStub(async () => Response.json(payload));

    const driver = new FakeProviderDriver({
      baseUrl: "http://127.0.0.1:8789",
      token,
      fetch: transport,
    });

    const input = { scope, limit: 10 };

    for (payload of [
      { items: [], nextCursor: 4 },
      { items: "invalid" },
      { items: [], extra: true },
    ]) {
      await expect(driver.inventory(input)).rejects.toThrow();
    }

    payload = { items: [], nextCursor: "10" };
    expect(await driver.inventory(input)).toEqual({ items: [], nextCursor: "10" });
  });

  test("fake driver does not forward mutation bodies across redirects", async () => {
    let forwarded = 0;

    const capture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        forwarded++;

        return Response.json({ ok: true });
      },
    });

    const redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.redirect(capture.url.toString(), 307);
      },
    });

    try {
      const driver = new FakeProviderDriver({ baseUrl: redirect.url.toString(), token });

      const result = await driver.create({
        scope,
        identity: identity("redirect_1"),
        image: "fake-starter",
        networkPolicy: "blocked",
      });

      expect(result.status).toBe("unknown");
      expect(forwarded).toBe(0);
    } finally {
      redirect.stop(true);
      capture.stop(true);
    }
  });

  test("fake server rejects foreign provider scope before mutation or read", async () => {
    const { driver, control } = await setup();

    const created = await driver.create({
      scope,
      identity: identity("scope_parent"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    if (created.status !== "completed" || created.value.kind !== "sandbox")
      throw new Error("Create failed");
    const foreignScope = { ...scope, provider: "other" };
    const foreignRef = { ...created.value.observation.ref, scope: foreignScope };

    const foreignCreate = await driver.create({
      scope: foreignScope,
      identity: identity("foreign_create"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    const foreignExec = await driver.exec({
      sandbox: foreignRef,
      identity: identity("foreign_exec"),
      command,
      deadlineSeconds: 30,
      maxOutputBytes: 0,
    });

    const foreignWrite = await driver.writeFile({
      sandbox: foreignRef,
      identity: identity("foreign_write"),
      path: "/blob",
      bytes: Uint8Array.of(1),
      overwrite: true,
    });

    const foreignDestroy = await driver.destroy({
      sandbox: foreignRef,
      identity: identity("foreign_destroy"),
    });

    for (const outcome of [foreignCreate, foreignExec, foreignWrite, foreignDestroy]) {
      expect(outcome.status).toBe("rejected");
      expect(outcome.effect).toBe("none");
    }

    await expect(driver.inspect(foreignRef)).rejects.toThrow("400");
    await expect(driver.inventory({ scope: foreignScope, limit: 10 })).rejects.toThrow("400");
    await expect(driver.readFile({ sandbox: foreignRef, path: "/blob" })).rejects.toThrow("400");
    await expect(
      driver.observe({ scope: foreignScope, submissionId: "scope_parent" }),
    ).rejects.toThrow("400");
    expect((await control("/_test/state")).invocations).toHaveLength(1);
  });

  test("wildcard scenario queue consumes one matching action without knowing allocated submission IDs", async () => {
    const { driver, control } = await setup();
    await control("/_test/seed", {
      submissionId: "*",
      action: "create",
      behavior: "lost_after_effect",
    });
    await control("/_test/seed", {
      submissionId: "*",
      action: "create",
      behavior: "reject",
      rejectCode: "capacity",
    });
    expect(
      (
        await driver.create({
          scope,
          identity: identity("opaque_1"),
          image: "fake-starter",
          networkPolicy: "blocked",
        })
      ).status,
    ).toBe("unknown");
    expect(
      (
        await driver.create({
          scope,
          identity: identity("opaque_2"),
          image: "fake-starter",
          networkPolicy: "blocked",
        })
      ).status,
    ).toBe("rejected");
    expect(
      (
        await driver.create({
          scope,
          identity: identity("opaque_3"),
          image: "fake-starter",
          networkPolicy: "blocked",
        })
      ).status,
    ).toBe("completed");
    expect((await control("/_test/state")).resources).toHaveLength(2);
  });

  test("exec translates cwd, environment, deadline and rejects cross-action submission reuse", async () => {
    const { driver, control } = await setup();

    const created = await driver.create({
      scope,
      identity: identity("shared_sub"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    if (created.status !== "completed" || created.value.kind !== "sandbox")
      throw new Error("Create failed");
    const sandbox = created.value.observation.ref;

    const collision = await driver.exec({
      sandbox,
      identity: identity("shared_sub"),
      command,
      deadlineSeconds: 30,
      maxOutputBytes: 32,
    });

    expect(collision.status).toBe("rejected");
    expect(collision.effect).toBe("none");
    await control("/_test/seed", {
      submissionId: "exec_scoped",
      action: "exec",
      command: { command, cwd: "/workspace", env: { LANG: "C" }, deadlineSeconds: 30, exitCode: 0 },
    });

    const wrong = await driver.exec({
      sandbox,
      identity: identity("exec_scoped"),
      command,
      cwd: "/wrong",
      env: { LANG: "C" },
      deadlineSeconds: 30,
      maxOutputBytes: 32,
    });

    expect(wrong.status).toBe("rejected");

    const correct = await driver.exec({
      sandbox,
      identity: identity("exec_scoped"),
      command,
      cwd: "/workspace",
      env: { LANG: "C" },
      deadlineSeconds: 30,
      maxOutputBytes: 32,
    });

    expect(correct.status).toBe("completed");
    await control("/_test/seed", {
      submissionId: "exec_default_fields",
      action: "exec",
      command: { command, exitCode: 0 },
    });

    const nondefault = await driver.exec({
      sandbox,
      identity: identity("exec_default_fields"),
      command,
      env: { LANG: "C" },
      deadlineSeconds: 30,
      maxOutputBytes: 32,
    });

    expect(nondefault.status).toBe("rejected");

    const defaultFields = await driver.exec({
      sandbox,
      identity: identity("exec_default_fields"),
      command,
      deadlineSeconds: 30,
      maxOutputBytes: 32,
    });

    expect(defaultFields.status).toBe("completed");
    expect(
      (await control("/_test/state")).ledger.filter((x: { action: string }) => x.action === "exec"),
    ).toHaveLength(2);
  });

  test("authentication rejection before dispatch is definitive", async () => {
    const { control } = await setup();

    const wrongTokenDriver = new FakeProviderDriver({
      baseUrl: server!.url.toString(),
      token: "wrong-token-123456",
    });

    const result = await wrongTokenDriver.create({
      scope,
      identity: identity("unauthorized_1"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    expect(result.status).toBe("rejected");
    expect(result.effect).toBe("none");
    expect((await control("/_test/state")).invocations).toHaveLength(0);
  });

  test("lost file-write response is recovered through the independent effect ledger", async () => {
    const { driver, control } = await setup();

    const created = await driver.create({
      scope,
      identity: identity("file_parent"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    if (created.status !== "completed" || created.value.kind !== "sandbox")
      throw new Error("Create failed");
    const sandbox = created.value.observation.ref;
    await control("/_test/seed", {
      submissionId: "*",
      action: "file_write",
      behavior: "lost_after_effect",
    });
    const bytes = Uint8Array.from([1, 0, 255]);
    expect(
      (
        await driver.writeFile({
          sandbox,
          identity: identity("file_write_1"),
          path: "/blob",
          bytes,
          overwrite: true,
        })
      ).status,
    ).toBe("unknown");
    const observed = await driver.observe({ scope, submissionId: "file_write_1" });
    expect(observed?.status).toBe("completed");
    expect(await driver.readFile({ sandbox, path: "/blob" })).toEqual(bytes);
    expect(
      (await control("/_test/state")).invocations.filter(
        (x: { action: string }) => x.action === "file_write",
      ),
    ).toHaveLength(1);
  });

  test("destroy removes virtual files and reports no retained resources", async () => {
    const { driver, control } = await setup();

    const created = await driver.create({
      scope,
      identity: identity("destroy_files_parent"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    if (created.status !== "completed" || created.value.kind !== "sandbox")
      throw new Error("Create failed");
    const sandbox = created.value.observation.ref;
    await driver.writeFile({
      sandbox,
      identity: identity("destroy_files_write"),
      path: "/private",
      bytes: Uint8Array.from([7]),
      overwrite: true,
    });
    const destroyed = await driver.destroy({ sandbox, identity: identity("destroy_files") });
    expect(destroyed.status).toBe("completed");

    if (destroyed.status !== "completed" || destroyed.value.kind !== "destroy")
      throw new Error("Destroy failed");
    expect(destroyed.value.observation.retainedResources).toEqual([]);
    expect((await driver.inspect(sandbox))?.state).toBe("destroyed");
    await expect(driver.readFile({ sandbox, path: "/private" })).rejects.toThrow("not found");
    expect((await control("/_test/state")).resources[0].files).toEqual({});
  });

  test("same-action submission reuse with different operation or payload is rejected without replay", async () => {
    const { driver, control } = await setup();

    const created = await driver.create({
      scope,
      identity: identity("create_fingerprint"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    expect(created.status).toBe("completed");

    const conflicting = await driver.create({
      scope,
      identity: { ...identity("create_fingerprint"), operationId: "another_operation" },
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    expect(conflicting.status).toBe("rejected");
    expect(conflicting.effect).toBe("none");

    if (created.status !== "completed" || created.value.kind !== "sandbox")
      throw new Error("Create failed");
    const sandbox = created.value.observation.ref;

    const original = await driver.writeFile({
      sandbox,
      identity: identity("write_fingerprint"),
      path: "/blob",
      bytes: Uint8Array.from([1]),
      overwrite: true,
    });

    expect(original.status).toBe("completed");

    const changed = await driver.writeFile({
      sandbox,
      identity: identity("write_fingerprint"),
      path: "/blob",
      bytes: Uint8Array.from([2]),
      overwrite: true,
    });

    expect(changed.status).toBe("rejected");
    expect(await driver.readFile({ sandbox, path: "/blob" })).toEqual(Uint8Array.from([1]));
    expect((await control("/_test/state")).invocations).toHaveLength(2);
  });

  test("diagnostic invocation history remains bounded after repeated definitive rejections", async () => {
    directory = await mkdtemp(join(tmpdir(), "sandbar-fake-"));
    const engine = new FakeProviderEngine(join(directory, "provider.json"), true);
    await engine.load();
    const missing = { scope, kind: "sandbox" as const, nativeId: "missing" };

    for (let index = 0; index < 520; index++) {
      const result = await engine.exec({
        sandbox: missing,
        identity: identity(`missing_${index}`),
        command,
        deadlineSeconds: 30,
        maxOutputBytes: 0,
      });

      expect(result.result.status).toBe("rejected");
    }

    expect(engine.snapshot().invocations).toHaveLength(512);
    const reloaded = new FakeProviderEngine(join(directory, "provider.json"), true);
    await reloaded.load();
    expect(reloaded.snapshot().invocations).toHaveLength(512);
  });

  test("fake state recovery rejects malformed or unknown-version evidence without rewriting it", async () => {
    directory = await mkdtemp(join(tmpdir(), "sandbar-fake-"));
    const statePath = join(directory, "provider.json");
    const engine = new FakeProviderEngine(statePath, true);
    await engine.load();
    expect(
      (
        await engine.create({
          scope,
          identity: identity("saved_create"),
          image: "fake-starter",
          networkPolicy: "blocked",
        })
      ).result.status,
    ).toBe("completed");
    expect((await engine.observe(scope, "saved_create"))?.status).toBe("completed");
    expect((await engine.observe(scope, "saved_create"))?.status).toBe("completed");
    expect(engine.snapshot().ledger[0]?.remaining).toBe(0);
    const valid = await readFile(statePath, "utf8");
    const recovered = new FakeProviderEngine(statePath, true);
    await recovered.load();
    expect(recovered.snapshot().ledger).toHaveLength(1);
    const source = JSON.parse(valid);
    const wrongLedgerRef = structuredClone(source.ledger[0]);
    wrongLedgerRef.result.value.observation.ref.kind = "execution";

    for (const damaged of [
      { ...source, version: 2 },
      {
        ...source,
        ledger: [
          {
            ...source.ledger[0],
            result: {
              status: "unknown",
              effect: "possible",
              submissionId: "saved_create",
              reason: "lost",
            },
          },
        ],
      },
      { ...source, ledger: [{ ...source.ledger[0], action: "destroy" }] },
      { ...source, ledger: [{ ...source.ledger[0], remaining: -1 }] },
      { ...source, ledger: [wrongLedgerRef] },
      {
        ...source,
        ledger: [{ ...source.ledger[0], scope: { ...scope, connectionId: "foreign" } }],
      },
      { ...source, resources: [{ ...source.resources[0], files: { "/blob": "not-base64" } }] },
      {
        ...source,
        resources: [
          { ...source.resources[0], ref: { ...source.resources[0].ref, kind: "execution" } },
        ],
      },
      {
        ...source,
        resources: [{ ...source.resources[0], files: { "/blob": "A".repeat(1_398_104) } }],
      },
    ]) {
      const serialized = JSON.stringify(damaged);
      await writeFile(statePath, serialized);
      await expect(new FakeProviderEngine(statePath, true).load()).rejects.toThrow(
        "Invalid fake provider state",
      );
      expect(await readFile(statePath, "utf8")).toBe(serialized);
    }

    await writeFile(statePath, "{");
    await expect(new FakeProviderEngine(statePath, true).load()).rejects.toThrow(
      "Invalid fake provider state JSON",
    );
  });

  test("full effect ledger rejects the 513th mutation before changing provider state while preserving replay evidence", async () => {
    directory = await mkdtemp(join(tmpdir(), "sandbar-fake-"));
    const engine = new FakeProviderEngine(join(directory, "provider.json"), true);
    await engine.load();

    const created = await engine.create({
      scope,
      identity: identity("ledger_create"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    if (created.result.status !== "completed" || created.result.value.kind !== "sandbox")
      throw new Error("Create failed");
    const sandbox = created.result.value.observation.ref;

    for (let index = 0; index < 511; index++) {
      const result = await engine.writeFile({
        sandbox,
        identity: identity(`ledger_write_${index}`),
        path: "/blob",
        bytesBase64: Buffer.from(String(index)).toString("base64"),
        overwrite: true,
      });

      expect(result.result.status).toBe("completed");
    }

    expect(engine.snapshot().ledger).toHaveLength(512);

    const overflow = await engine.writeFile({
      sandbox,
      identity: identity("ledger_write_511"),
      path: "/blob",
      bytesBase64: Buffer.from("overflow").toString("base64"),
      overwrite: true,
    });

    expect(overflow.result.status).toBe("rejected");
    expect(overflow.result.effect).toBe("none");
    expect(Buffer.from(engine.readFile(sandbox, "/blob") ?? "", "base64").toString()).toBe("510");

    const replay = await engine.writeFile({
      sandbox,
      identity: identity("ledger_write_0"),
      path: "/blob",
      bytesBase64: Buffer.from("0").toString("base64"),
      overwrite: true,
    });

    expect(replay.result.status).toBe("completed");
    expect(engine.snapshot().ledger).toHaveLength(512);
  });

  test("state byte limit returns definitive capacity without persisting a large execution effect", async () => {
    directory = await mkdtemp(join(tmpdir(), "sandbar-fake-"));
    const engine = new FakeProviderEngine(join(directory, "provider.json"), true);
    await engine.load();

    const created = await engine.create({
      scope,
      identity: identity("large_parent"),
      image: "fake-starter",
      networkPolicy: "blocked",
    });

    if (created.result.status !== "completed" || created.result.value.kind !== "sandbox")
      throw new Error("Create failed");
    const sandbox = created.result.value.observation.ref;
    await engine.setProfile({
      nativeIdempotency: { create: true, exec: false, destroy: true, writeFile: true },
      discoveryBySubmission: true,
    });
    await engine.seed({
      submissionId: "large_exec",
      action: "exec",
      command: { command, exitCode: 0, stdoutBase64: Buffer.alloc(700000, 65).toString("base64") },
    });
    let rejected = false;

    for (let index = 0; index < 12; index++) {
      const before = engine.snapshot();

      const result = await engine.exec({
        sandbox,
        identity: identity("large_exec"),
        command,
        deadlineSeconds: 30,
        maxOutputBytes: 700000,
      });

      if (result.result.status === "rejected") {
        expect(result.result.error.code).toBe("capacity");
        expect(result.result.effect).toBe("none");
        expect(engine.snapshot().ledger).toHaveLength(before.ledger.length);
        expect(engine.snapshot().nextId).toBe(before.nextId);
        rejected = true;
        break;
      }

      expect(result.result.status).toBe("completed");
    }

    expect(rejected).toBe(true);
  });
});
