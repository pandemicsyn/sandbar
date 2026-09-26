import { afterEach, describe, expect, test } from "bun:test";
import { Sandbar as DirectSandbar, Image as DirectImage } from "@sandbar/sdk/direct";
import { Sandbar as RemoteSandbar, Image as RemoteImage } from "@sandbar/sdk/remote";
import type { SandbarClient, SandboxHandle } from "@sandbar/sdk";
import { fakeProvider } from "@sandbar/provider-fake/client";
import { ProcessFixture } from "./processes";

type Backend = "direct" | "remote";
const fixtures: ProcessFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())); });

async function post(url: string, token: string | undefined, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}

async function backend(kind: Backend) {
  const fixture = new ProcessFixture();
  fixtures.push(fixture);
  await fixture.startFake();
  if (kind === "direct") {
    const client = DirectSandbar.direct({ provider: await fakeProvider({ url: fixture.fakeUrl!, token: fixture.fakeToken }) });
    return { fixture, client: client as SandbarClient, image: DirectImage.prepared("fake-starter") };
  }
  await fixture.startService();
  const setup = await post(`${fixture.serviceUrl}/v1/setup`, undefined, { setupToken: fixture.setupToken });
  const project = await post(`${fixture.serviceUrl}/v1/projects`, setup.token, { name: "SDK parity" });
  const connection = await post(`${fixture.serviceUrl}/v1/projects/${project.id}/provider-connections`, setup.token, { provider: "fake", name: "Local fake" });
  await post(`${fixture.serviceUrl}/v1/projects/${project.id}/provider-connections/${connection.id}/verify`, setup.token, {});
  const client = RemoteSandbar.connect({ url: fixture.serviceUrl!, token: setup.token, projectId: project.id });
  return { fixture, client: client as SandbarClient, image: RemoteImage.prepared("fake-starter") };
}

for (const kind of ["direct", "remote"] as const) {
  describe(`${kind} public SDK resources`, () => {
    test("create, inspect, exec, binary file and destroy", async () => {
      const { fixture, client, image } = await backend(kind);
      const command = { kind: "argv" as const, argv: ["fixture", "binary"] };
      const stdout = Uint8Array.from([0xff, 0x00, 0x80, 0x61]);
      const stderr = Uint8Array.from([0xfe, 0x62]);
      await fixture.fakeControl("/_test/seed", {
        submissionId: "*", action: "exec", behavior: "normal",
        command: { command, exitCode: 0, stdoutBase64: Buffer.from(stdout).toString("base64"), stderrBase64: Buffer.from(stderr).toString("base64") },
      });
      try {
        const box = await client.sandboxes.create({ environment: image });
        expect((await box.inspect()).state).toBe("running");
        const execution = await box.exec({ command });
        expect(execution.exitCode).toBe(0);
        expect(execution.stdout).toEqual(stdout);
        expect(execution.stderr).toEqual(stderr);
        const file = Uint8Array.from([0x00, 0xff, 0x81, 0x61]);
        await box.writeFile("/data/binary", file);
        expect(await box.readFile("/data/binary")).toEqual(file);
        await box.destroy();
        expect((await box.inspect()).state).toBe("destroyed");
      } finally { await client.close(); }
    }, 30_000);

    test("nonzero process exit preserves bounded binary output", async () => {
      const { fixture, client, image } = await backend(kind);
      const command = { kind: "argv" as const, argv: ["fixture", "nonzero"] };
      await fixture.fakeControl("/_test/seed", {
        submissionId: "*", action: "exec", behavior: "normal",
        command: {
          command, exitCode: 7,
          stdoutBase64: Buffer.from([0xff, 0x00]).toString("base64"),
          stderrBase64: Buffer.from([0x80, 0x01]).toString("base64"),
        },
      });
      try {
        const box = await client.sandboxes.create({ environment: image });
        try {
          await expect(box.exec({ command })).rejects.toMatchObject({
            name: "NonzeroExitError",
            result: { exitCode: 7, stdout: Uint8Array.from([0xff, 0x00]), stderr: Uint8Array.from([0x80, 0x01]) },
          });
        } finally { await box.destroy(); }
      } finally { await client.close(); }
    }, 30_000);
  });
}

describe("direct recovery evidence", () => {
  test("a separately configured caller observes a lost create without submitting again", async () => {
    const { fixture, client, image } = await backend("direct");
    await fixture.fakeControl("/_test/seed", { submissionId: "*", action: "create", behavior: "lost_after_effect" });
    try {
      const operation = await client.sandboxes.submitCreate({ environment: image });
      const reference = structuredClone(operation.reference);
      const serialized = JSON.stringify(reference);
      expect(serialized).not.toContain(fixture.fakeToken);
      expect(serialized).not.toContain("fake-starter");
      await client.close();
      const next = DirectSandbar.direct({ provider: await fakeProvider({ url: fixture.fakeUrl!, token: fixture.fakeToken }) });
      try {
        const box = await (await next.recover(reference)).wait() as SandboxHandle;
        expect((await box.inspect()).state).toBe("running");
        const state = await fixture.fakeControl("/_test/state");
        expect(state.invocations.filter((entry: any) => entry.action === "create")).toHaveLength(1);
        await box.destroy();
      } finally { await next.close(); }
    } finally { await client.close(); }
  }, 30_000);

  test("missing native discovery leaves an ambiguous create unknown without replay", async () => {
    const { fixture, client, image } = await backend("direct");
    await fixture.fakeControl("/_test/profile", {
      nativeIdempotency: { create: false, exec: false, destroy: false, writeFile: false },
      discoveryBySubmission: false,
    });
    await fixture.fakeControl("/_test/seed", { submissionId: "*", action: "create", behavior: "lost_after_effect" });
    try {
      const operation = await client.sandboxes.submitCreate({ environment: image });
      await expect(operation.wait()).rejects.toMatchObject({ name: "OutcomeUnknownError" });
      await expect(operation.observe()).rejects.toMatchObject({ name: "OutcomeUnknownError" });
      const state = await fixture.fakeControl("/_test/state");
      expect(state.invocations.filter((entry: any) => entry.action === "create")).toHaveLength(1);
      expect(state.resources.filter((entry: any) => entry.state === "running")).toHaveLength(1);
    } finally { await client.close(); }
  }, 30_000);

  test("lost exec and file write responses remain one effect each without native replay", async () => {
    const { fixture, client, image } = await backend("direct");
    await fixture.fakeControl("/_test/profile", {
      nativeIdempotency: { create: false, exec: false, destroy: false, writeFile: false },
      discoveryBySubmission: false,
    });
    try {
      const box = await client.sandboxes.create({ environment: image });
      const command = { kind: "argv" as const, argv: ["fixture", "uncertain"] };
      await fixture.fakeControl("/_test/seed", {
        submissionId: "*", action: "exec", behavior: "lost_after_effect",
        command: { command, exitCode: 0, stdoutBase64: Buffer.from([0x7f]).toString("base64") },
      });
      await expect(box.exec({ command })).rejects.toMatchObject({ name: "OutcomeUnknownError" });
      await fixture.fakeControl("/_test/seed", { submissionId: "*", action: "file_write", behavior: "lost_after_effect" });
      await expect(box.writeFile("/data/uncertain", Uint8Array.from([0xff]))).rejects.toMatchObject({ name: "OutcomeUnknownError" });
      const state = await fixture.fakeControl("/_test/state");
      expect(state.invocations.filter((entry: any) => entry.action === "exec")).toHaveLength(1);
      expect(state.invocations.filter((entry: any) => entry.action === "file_write")).toHaveLength(1);
      expect(await box.readFile("/data/uncertain")).toEqual(Uint8Array.from([0xff]));
      await box.destroy();
    } finally { await client.close(); }
  }, 30_000);

  test("aborting a wait leaves provider compute running, and a foreign scope cannot recover it", async () => {
    const { fixture, client, image } = await backend("direct");
    await fixture.fakeControl("/_test/seed", { submissionId: "*", action: "create", behavior: "normal", delayObservations: 100 });
    try {
      const operation = await client.sandboxes.submitCreate({ environment: image });
      const controller = new AbortController();
      const waiting = operation.wait({ signal: controller.signal, pollMs: 1_000 });
      const outcome = waiting.then(() => ({ completed: true as const }), error => ({ completed: false as const, error }));
      let observed = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        const state = await fixture.fakeControl("/_test/state");
        if (state.ledger.some((entry: any) => entry.action === "create" && entry.remaining < 100)) { observed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(observed).toBe(true);
      controller.abort(new DOMException("Wait cancelled", "AbortError"));
      expect(await outcome).toMatchObject({ completed: false, error: { name: "AbortError" } });
      const state = await fixture.fakeControl("/_test/state");
      expect(state.resources.filter((entry: any) => entry.state === "running")).toHaveLength(1);
      expect(state.invocations.filter((entry: any) => entry.action === "create")).toHaveLength(1);
      await expect(client.recover({ ...operation.reference, scope: { ...operation.reference.scope!, accountId: "other" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await client.close();
      const afterClose = await fixture.fakeControl("/_test/state");
      expect(afterClose.resources.filter((entry: any) => entry.state === "running")).toHaveLength(1);
    } finally { await client.close(); }
  }, 30_000);

  test("a cross-wired observation stays unknown and does not replay create", async () => {
    const fixture = new ProcessFixture();
    fixtures.push(fixture);
    await fixture.startFake();
    const registration = await fakeProvider({ url: fixture.fakeUrl!, token: fixture.fakeToken });
    const driver = new Proxy(registration.driver, {
      get(target, property) {
        if (property === "observe") return async (input: Parameters<typeof target.observe>[0]) => {
          const result = await target.observe(input);
          return result?.status === "completed" ? { ...result, submissionId: "wrong_submission" } : result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const client = DirectSandbar.direct({ provider: { ...registration, driver } });
    await fixture.fakeControl("/_test/seed", { submissionId: "*", action: "create", behavior: "lost_after_effect" });
    try {
      const operation = await client.sandboxes.submitCreate({ environment: DirectImage.prepared("fake-starter") });
      await expect(operation.wait()).rejects.toMatchObject({ name: "OutcomeUnknownError" });
      const state = await fixture.fakeControl("/_test/state");
      expect(state.invocations.filter((entry: any) => entry.action === "create")).toHaveLength(1);
    } finally { await client.close(); }
  }, 30_000);
});
