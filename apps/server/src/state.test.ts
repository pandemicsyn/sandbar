import { expect, test } from "bun:test";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineAdapter, type SnapshotProfile } from "sandbar-adapter";
import { Sandbar as Direct, Image } from "sandbar-sdk";
import { Sandbar } from "../../../packages/service/src/client";
import { openDomainRuntime } from "./runtime";

const profile: SnapshotProfile = {
  id: "memory",
  preserve: "filesystem+memory",
  sourceStates: ["running"],
  interruption: "pause",
  sourceAfter: "unchanged",
  connections: "dropped",
  consistency: "crash-consistent",
  mountHandling: "none",
  minimumRetentionSeconds: 900,
};

test("service and direct read checks agree, admission and runtime reject before effects, recovery never replays", async () => {
  let creates = 0;
  let destroys = 0;
  let captures = 0;
  let status: "supported" | "unsupported" | "unknown" | "unavailable" = "supported";
  let reason = "fixture evidence";

  const adapter = defineAdapter({
    name: "fixture.state",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          recovery: { version: 1, token: z.strictObject({ job: z.string() }) },
          async submit(_input, ctx) {
            creates++;

            return ctx.pending({ job: "job1" }, { pollAfterMs: 0 });
          },
          async observe() {
            return { id: "box1", state: "running" as const };
          },
        },
        async destroy() {
          destroys++;

          return { computeStopped: true, retainedResources: [] };
        },
        async inspect(box) {
          return { id: box.id, state: "running" };
        },
        async snapshotProfiles() {
          return status === "supported"
            ? { status, value: { profiles: [profile] } }
            : { status, reason };
        },
        async snapshotCapture() {
          captures++;
          throw new Error("future feature slice");
        },
      };
    },
  });

  const directory = await mkdtemp(join(tmpdir(), "sandbar-state-"));

  const keyFile = join(directory, "key"),
    setupTokenFile = join(directory, "setup");

  await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await chmod(keyFile, 0o600);
  await writeFile(setupTokenFile, "long-state-fixture-setup-token");
  await chmod(setupTokenFile, 0o600);

  const config = {
    databaseUrl: join(directory, "store.sqlite"),
    keyFile,
    setupTokenFile,
    startRunner: false,
    adapters: [adapter],
  };

  let runtime = await openDomainRuntime(config);
  const direct = await Direct.connect({ adapter, config: {}, credentials: {} });
  let bearer = "";

  const request = async (
    path: string,
    method = "GET",
    body?: z.infer<ReturnType<typeof z.json>>,
    key?: string,
  ) => {
    const headers = new Headers({ Authorization: `Bearer ${bearer}` });

    if (body) headers.set("Content-Type", "application/json");

    if (key) headers.set("Idempotency-Key", key);

    const response = await runtime.app.request(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    return { status: response.status, value: await response.json() };
  };

  try {
    bearer = (await request("/v1/setup", "POST", { setupToken: "long-state-fixture-setup-token" }))
      .value.token;
    const projectId = (await request("/v1/projects", "POST", { name: "State" })).value.id;
    const base = `/v1/projects/${projectId}`;

    const connectionId = (
      await request(`${base}/provider-connections`, "POST", {
        provider: adapter.name,
        name: "Fixture",
        credentials: {},
        configuration: {},
      })
    ).value.id;

    expect(
      (await request(`${base}/provider-connections/${connectionId}/verify`, "POST")).status,
    ).toBe(200);

    const client = Sandbar.connect({
      url: "http://127.0.0.1",
      projectId,
      token: bearer,
      fetch: Object.assign(
        async (url: string | URL | Request, init?: RequestInit) =>
          runtime.app.request(new Request(url, init)),
        { preconnect() {} },
      ),
    });

    const input = {
      environment: Image.prepared("base"),
      requirements: { snapshot: { preserve: "filesystem+memory" as const } },
    };

    const remoteCaps = await client.capabilities();
    const directCaps = await direct.capabilities();
    expect({ ...remoteCaps, observedAt: "dated" }).toEqual({ ...directCaps, observedAt: "dated" });
    expect(await client.sandboxes.checkCreate(input)).toEqual(
      await direct.sandboxes.checkCreate(input),
    );
    expect(
      (
        await client.sandboxes.checkCreate({
          ...input,
          requirements: { snapshot: { preserve: "filesystem" } },
        })
      ).status,
    ).toBe("unsupported");
    await expect(
      client.sandboxes.create({ ...input, requirements: { snapshot: { preserve: "filesystem" } } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", effect: "none" });

    for (const value of ["unknown", "unavailable"] as const) {
      status = value;
      expect(await client.sandboxes.checkCreate(input)).toEqual(
        await direct.sandboxes.checkCreate(input),
      );
      await expect(client.sandboxes.create(input)).rejects.toMatchObject({
        code: "UNAVAILABLE",
        effect: "none",
      });
    }

    status = "unsupported";
    reason = "x".repeat(1024);
    expect(await client.sandboxes.checkCreate(input)).toMatchObject({
      status: "unsupported",
      reason,
    });
    await expect(client.sandboxes.create(input)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      effect: "none",
      feature: "create",
      unmetRequirements: [reason],
    });
    reason = "fixture evidence";
    expect(creates).toBe(0);
    status = "supported";
    const changed = await client.sandboxes.submitCreate(input);
    status = "unknown";
    await runtime.runner.tick();
    expect(creates).toBe(0);
    expect(
      (await runtime.store.getOperation(projectId, changed.reference.operationId!))
        ?.submission_possible,
    ).toBe(0);
    status = "supported";
    const unsupported = await client.sandboxes.submitCreate(input);
    status = "unsupported";
    await runtime.runner.tick();
    const failed = await runtime.store.getOperation(projectId, unsupported.reference.operationId!);
    expect(failed).toMatchObject({ status: "failed", effect: "none", submission_possible: 0 });
    await expect(unsupported.wait()).rejects.toMatchObject({ code: "UNSUPPORTED", effect: "none" });
    expect(creates).toBe(0);
    status = "supported";
    const operation = await client.sandboxes.submitCreate(input);
    await runtime.runner.tick();
    expect(creates).toBe(1);
    await runtime.close();
    runtime = await openDomainRuntime(config);
    await request(`${base}/operations/${operation.reference.operationId}/reconcile`, "POST", {});
    await runtime.runner.tick();

    const box = await (
      await client.recover(JSON.parse(JSON.stringify(operation.reference)))
    ).wait();

    const parsedBox = z
      .custom<{
        id: string;
        checkSnapshot: (request: { preserve: "filesystem+memory" }) => Promise<object>;
      }>()
      .parse(box);

    expect(await parsedBox.checkSnapshot({ preserve: "filesystem+memory" })).toMatchObject({
      status: "supported",
    });
    const directBox = new (await import("sandbar-sdk")).AdapterSandbox(direct, "box1");
    expect(await parsedBox.checkSnapshot({ preserve: "filesystem+memory" })).toEqual(
      await directBox.checkSnapshot({ preserve: "filesystem+memory" }),
    );
    expect(creates).toBe(1);
    expect(captures).toBe(0);
    expect(destroys).toBe(0);
    await client.close();
  } finally {
    await direct.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
