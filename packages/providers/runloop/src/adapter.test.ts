import { afterEach, expect, test } from "bun:test";
import { adapterSuite } from "@sandbar-sdk/adapter/testing";
import { Image, NonzeroExitError, OutcomeUnknownError, Sandbar } from "sandbar-sdk";
import type { z } from "zod";
import { createRunloopAdapter, uuidv7 } from "./adapter";
import { runloopFixture } from "./fixture.test-support";

const fixtures: ReturnType<typeof runloopFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const internet = { network: "internet" } as const;

function setup() {
  const fixture = runloopFixture();
  fixtures.push(fixture);

  const adapter = createRunloopAdapter({
    fetch: fixture.fetch,
    pollIntervalMs: 1,
    settleSeconds: 1,
  });

  const connect = (config: z.input<typeof adapter.config> = internet) =>
    Sandbar.connect({ adapter, config, credentials: { apiKey: "fixture-main" } });

  return { fixture, adapter, connect };
}

// Copies: Bun's toMatchObject writes asymmetric matchers into the object it checks.
const createBodies = (fixture: ReturnType<typeof runloopFixture>) =>
  fixture.calls
    .filter((call) => call.method === "POST" && call.path === "/v1/devboxes")
    .map((call) => ({ ...call, body: structuredClone(call.body) }));

test("Runloop conformance: one native attempt, distinct accounts, lost and late responses", async () => {
  const { fixture, adapter } = setup();

  const report = await adapterSuite({
    adapter,
    fixture: {
      config: internet,
      credentials: { apiKey: "fixture-main" },
      alternate: { config: internet, credentials: { apiKey: "fixture-alt" } },
      createInput: {
        image: { kind: "prepared", value: "runloop-default" },
        networkPolicy: "internet",
      },
      counters: () => ({ ...fixture.effects }),
      expectedReleasesPerConnection: 0,
      loseNextCreateResponse: fixture.loseNextCreateResponse,
      holdNextCreateResponse: fixture.holdNextCreateResponse,
      releaseHeldCreateResponse: fixture.releaseHeldCreateResponse,
      assertNativeRetriesDisabled() {
        expect(fixture.count("POST", /^\/v1\/devboxes$/)).toBe(0);
      },
    },
  });

  expect(report.counters).toEqual({ create: 3, destroy: 1, release: 0 });
  // Each create effect came from exactly one outbound request.
  expect(fixture.count("POST", /^\/v1\/devboxes$/)).toBe(3);
});

test("setup verifies an enabled account and rejects unsupported inputs before any effect", async () => {
  const { fixture, adapter, connect } = setup();

  await expect(
    Sandbar.connect({ adapter, config: {}, credentials: { apiKey: "fixture-disabled" } }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    Sandbar.connect({
      adapter,
      config: { lifecycle: { lifetimeSeconds: 600, idleSeconds: 300 } },
      credentials: { apiKey: "fixture-main" },
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

  const client = await connect({});

  try {
    expect((await client.capabilities()).network).toEqual(["blocked", "internet"]);
    await expect(
      client.sandboxes.create({ environment: Image.oci("ubuntu:24.04") }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(client.sandboxes.create({ region: "us" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(fixture.effects.create).toBe(0);
  } finally {
    await client.close();
  }
});

test("blocked egress finds or creates one deny-all policy and attaches it", async () => {
  const { fixture, connect } = setup();
  // A policy with the right name but open egress is never used for blocked.
  const open = fixture.addPolicy("sandbar-blocked", true);
  const client = await connect({});

  try {
    const first = await client.sandboxes.create();
    const second = await client.sandboxes.create();
    const policies = [...fixture.policies.values()].filter((policy) => policy !== open);

    expect(policies).toHaveLength(1);
    expect(fixture.count("POST", /^\/v1\/network-policies$/)).toBe(1);
    expect(policies[0]?.egress).toMatchObject({ allow_all: false, allowed_hostnames: [] });

    for (const body of createBodies(fixture))
      expect(body.body).toMatchObject({
        launch_parameters: { network_policy_id: policies[0]?.id },
      });

    // A cached policy that is gone is found again by name rather than failing the create.
    fixture.failNext(/^GET \/v1\/network-policies\/[^/]+$/, fixture.error(404, "not found"));
    const third = await client.sandboxes.create();
    expect(createBodies(fixture).at(-1)?.body).toMatchObject({
      launch_parameters: { network_policy_id: policies[0]?.id },
    });
    expect(fixture.count("GET", /^\/v1\/network-policies$/)).toBe(2);

    const open2 = await client.sandboxes.create({ networkPolicy: "internet" });
    expect(createBodies(fixture).at(-1)?.body).not.toHaveProperty(
      "launch_parameters.network_policy_id",
    );

    await Promise.all([first.destroy(), second.destroy(), third.destroy(), open2.destroy()]);
  } finally {
    await client.close();
  }
});

test("a refused policy create rejects the sandbox create without creating a devbox", async () => {
  const { fixture, connect } = setup();
  const client = await connect({});

  try {
    fixture.failNext(/^POST \/v1\/network-policies$/, fixture.error(403, "policies disabled"));
    await expect(client.sandboxes.create()).rejects.toMatchObject({ code: "FORBIDDEN" });

    fixture.failNext(/^POST \/v1\/network-policies$/, "lost");
    await expect(client.sandboxes.create()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fixture.effects.create).toBe(0);
  } finally {
    await client.close();
  }
});

test("create records the attempt, sets lifetime, tunnel and env, and resolves blueprints", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create({ env: { TOKEN: "secret value" } });
    const body = createBodies(fixture)[0]?.body;

    expect(body).toMatchObject({
      launch_parameters: { keep_alive_time_seconds: 900 },
      tunnel: { auth_mode: "authenticated" },
      environment_variables: { TOKEN: "secret value" },
      metadata: {
        sandbar_operation: expect.any(String),
        sandbar_submission: expect.any(String),
      },
    });
    expect(body).not.toHaveProperty("blueprint_id");
    expect(body).not.toHaveProperty("blueprint_name");

    const info = await box.inspect();
    expect(info.state).toBe("running");
    expect(info.expires).toMatchObject({ status: "known", action: "destroy" });
    expect(info.idleStop).toEqual({ status: "known", value: null });
    expect(info.resources).toEqual({ status: "known", value: { vcpus: 1, memoryMiB: 2048 } });

    await client.sandboxes.create({ environment: Image.prepared("bpt_known") });
    expect(createBodies(fixture).at(-1)?.body).toMatchObject({ blueprint_id: "bpt_known" });
    await client.sandboxes.create({ environment: Image.prepared("python-tools") });
    expect(createBodies(fixture).at(-1)?.body).toMatchObject({ blueprint_name: "python-tools" });
  } finally {
    await client.close();
  }
});

test("resources pick the smallest Runloop size; idle windows replace the lifetime", async () => {
  const { fixture, adapter } = setup();

  const client = await Sandbar.connect({
    adapter,
    config: { ...internet, resources: { vcpus: 3 }, lifecycle: { idleSeconds: 600 } },
    credentials: { apiKey: "fixture-main" },
  });

  try {
    const box = await client.sandboxes.create();
    expect(createBodies(fixture)[0]?.body).toMatchObject({
      launch_parameters: {
        resource_size_request: "X_LARGE",
        lifecycle: { after_idle: { idle_time_seconds: 600, on_idle: "suspend" } },
      },
    });
    expect(createBodies(fixture)[0]?.body).not.toHaveProperty(
      "launch_parameters.keep_alive_time_seconds",
    );
    const info = await box.inspect();
    expect(info.resources).toEqual({ status: "known", value: { vcpus: 4, memoryMiB: 16384 } });
    expect(info.idleStop).toEqual({ status: "known", value: { seconds: 600, action: "suspend" } });
    expect(info.expires).toEqual({ status: "none" });
  } finally {
    await client.close();
  }

  const custom = await Sandbar.connect({
    adapter,
    config: { ...internet, resources: { vcpus: 12, memoryMiB: 40000 } },
    credentials: { apiKey: "fixture-main" },
  });

  try {
    const box = await custom.sandboxes.create();
    expect(createBodies(fixture).at(-1)?.body).toMatchObject({
      launch_parameters: {
        resource_size_request: "CUSTOM_SIZE",
        custom_cpu_cores: 16,
        custom_gb_memory: 64,
      },
    });
    expect((await box.inspect()).resources).toEqual({
      status: "known",
      value: { vcpus: 16, memoryMiB: 65536 },
    });
  } finally {
    await custom.close();
  }

  const before = fixture.calls.length;
  await expect(
    Sandbar.connect({
      adapter,
      config: { ...internet, resources: { vcpus: 32 } },
      credentials: { apiKey: "fixture-main" },
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
    message: expect.stringContaining("largest is 16 vCPU / 65536 MiB"),
  });
  expect(fixture.calls).toHaveLength(before);
});

test("create refusals reject; 5xx and lost responses stay unknown and are found by their marker", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.failNext(/^POST \/v1\/devboxes$/, fixture.error(429, "slow down"));
    await expect(client.sandboxes.create()).rejects.toMatchObject({ code: "RATE_LIMIT" });
    fixture.failNext(/^POST \/v1\/devboxes$/, fixture.error(502, "bad gateway"));
    await expect(client.sandboxes.create()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(fixture.effects.create).toBe(0);
  } finally {
    await client.close();
  }
});

test("recovery checks the requested network policy, with or without the create token", async () => {
  const { fixture, connect } = setup();
  const client = await connect({});

  try {
    // Token saved: the devbox came up without its deny-all policy, so recovery never accepts it.
    fixture.dropPolicyOnNextCreate();
    const dropped = await client.sandboxes.submitCreate();
    await expect(dropped.observe()).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      outcome: { kind: "create", status: "partial" },
    });
    await expect((await client.recover(dropped.reference)).observe()).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      outcome: { kind: "create", status: "partial" },
    });

    // Response lost: the egress marker on the devbox stands in for the token.
    fixture.dropPolicyOnNextCreate();
    fixture.loseNextCreateResponse();
    const lost = await client.sandboxes.submitCreate();
    await expect(lost.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
    await expect((await client.recover(lost.reference)).observe()).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      outcome: { kind: "create", status: "partial" },
    });

    fixture.loseNextCreateResponse();
    const intact = await client.sandboxes.submitCreate();
    await expect(intact.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
    const recovered = await (await client.recover(intact.reference)).observe();
    expect(recovered).toMatchObject({
      reference: { nativeId: [...fixture.devboxes.keys()].at(-1) },
    });
    expect(fixture.effects.create).toBe(3);
  } finally {
    await client.close();
  }
});

test("slow provisioning keeps one create effect and completes through observation", async () => {
  const { fixture, connect } = setup();
  fixture.setSettlePolls(Number.MAX_SAFE_INTEGER);
  const client = await connect();

  try {
    setTimeout(() => fixture.setSettlePolls(0), 50);
    const box = await client.sandboxes.create();
    expect((await box.inspect()).state).toBe("running");
    expect(fixture.effects.create).toBe(1);
    expect(fixture.count("POST", /^\/v1\/devboxes$/)).toBe(1);
  } finally {
    await client.close();
  }
});

test("exec keeps argv as arguments and stdout, stderr and stdin as exact bytes", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();

    const argv = await box.exec({
      command: { kind: "argv", argv: ["printf", "%s|%s", "with spaces", "$(false)'quote"] },
    });

    expect(new TextDecoder().decode(argv.stdout)).toBe("with spaces|$(false)'quote");

    const failed = await box
      .exec({
        command: {
          kind: "shell",
          script: "printf '\\000\\377\\200'; printf 'warn\\377' >&2; exit 3",
        },
      })
      .then(
        () => undefined,
        (error: Error) => error,
      );

    if (!(failed instanceof NonzeroExitError)) throw failed ?? Error("Expected exit 3");
    expect(failed.result.stdout).toEqual(Uint8Array.of(0, 255, 128));
    expect(failed.result.stderr).toEqual(Uint8Array.of(119, 97, 114, 110, 255));
    expect(failed.result.exitCode).toBe(3);

    const stdin = Uint8Array.of(0, 1, 255, 10, 66);
    const echoed = await box.exec({ command: { kind: "argv", argv: ["cat"] }, stdin });
    expect(echoed.stdout).toEqual(stdin);
    expect(fixture.count("POST", /\/upload_file$/)).toBe(1);

    const env = await box.exec({
      command: { kind: "shell", script: 'printf %s "$GREETING"' },
      env: { GREETING: "it's $HOME" },
      cwd: fixture.workdir,
    });

    expect(new TextDecoder().decode(env.stdout)).toBe("it's $HOME");

    const bounded = await box.exec({
      command: { kind: "shell", script: "head -c 5000 /dev/zero" },
      maxOutputBytes: 10,
    });

    expect(bounded.stdout).toEqual(new Uint8Array(10));
    expect(bounded.truncated).toBe(true);
  } finally {
    await client.close();
  }
});

test("large output is downloaded as bytes and its guest directory removed", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();

    const result = await box.exec({
      command: { kind: "shell", script: "head -c 100000 /dev/urandom | tee /dev/stderr" },
    });

    expect(result.stdout.byteLength).toBe(100000);
    expect(result.stderr).toEqual(result.stdout);
    expect(result.truncated).toBe(false);
    expect(fixture.count("POST", /\/download_file$/)).toBe(2);
    expect(fixture.commands.at(-1)).toMatch(/^rm -rf -- '\/tmp\/sandbar-exec\.[A-Za-z0-9]{8}'$/);
    expect(fixture.commands.filter((command) => command.startsWith("sandbar_d="))).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("a failed download keeps the confirmed exit code and reports truncation", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    fixture.failNext(/\/download_file$/, fixture.error(503, "unavailable"));

    const result = await box.exec({
      command: { kind: "shell", script: "head -c 40000 /dev/zero; printf warn >&2" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual(new Uint8Array());
    expect(new TextDecoder().decode(result.stderr)).toBe("warn");
    expect(result.truncated).toBe(true);
    // The output directory stays in the guest instead of being deleted.
    expect(fixture.commands.filter((command) => command.startsWith("rm -rf"))).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test("long commands are awaited across windows; a passed deadline kills and is unknown", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    fixture.setCommandWaits(2);
    fixture.timeoutNextWaits(1);
    const slow = await box.exec({ command: { kind: "argv", argv: ["printf", "done"] } });
    expect(new TextDecoder().decode(slow.stdout)).toBe("done");
    expect(fixture.count("POST", /\/wait_for_status$/)).toBe(3);

    fixture.setCommandWaits(Number.MAX_SAFE_INTEGER);
    await expect(
      box.exec({ command: { kind: "argv", argv: ["true"] }, deadlineSeconds: 1 }),
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      message: expect.stringContaining("was killed"),
    });
    expect(fixture.count("POST", /\/kill$/)).toBe(1);

    fixture.failNext(/\/kill$/, fixture.error(503, "unavailable"));
    await expect(
      box.exec({ command: { kind: "argv", argv: ["true"] }, deadlineSeconds: 1 }),
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      message: expect.stringContaining("may still be running"),
    });
  } finally {
    await client.close();
  }
});

test("exec refusals before running reject; lost, truncated or imitated results are unknown and never replayed", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const command = { kind: "argv" as const, argv: ["true"] };

    await expect(box.exec({ command, env: { "BAD-NAME": "x" } })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(fixture.commands).toHaveLength(0);

    fixture.failNext(/\/execute$/, fixture.error(400, "bad command"));
    await expect(box.exec({ command })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    fixture.failNext(/\/execute$/, fixture.error(500, "boom"));
    await expect(box.exec({ command })).rejects.toBeInstanceOf(OutcomeUnknownError);
    fixture.failNext(/\/execute$/, "lost");
    await expect(box.exec({ command })).rejects.toBeInstanceOf(OutcomeUnknownError);

    fixture.overrideCommands(() => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: true,
    }));
    await expect(box.exec({ command })).rejects.toBeInstanceOf(OutcomeUnknownError);

    // User output that imitates the record cannot become a result.
    fixture.overrideCommands(() => ({
      exitCode: 0,
      stdout: "SANDBAR-EXEC-1 inline 0 1 0\nQQ==\n\nextra",
      stderr: "",
    }));
    await expect(box.exec({ command })).rejects.toBeInstanceOf(OutcomeUnknownError);
    fixture.overrideCommands(undefined);
    expect(fixture.count("POST", /\/execute$/)).toBe(5);
  } finally {
    await client.close();
  }
});

test("files round-trip binary bytes, reject no-clobber and enforce the read bound", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const bytes = Uint8Array.of(0, 255, 128, 10);
    await box.writeFile("/home/user/data.bin", bytes, { overwrite: true });
    expect(await box.readFile("/home/user/data.bin")).toEqual(bytes);
    expect(fixture.devboxes.get(box.id)?.files.get("/home/user/data.bin")).toEqual(bytes);

    await expect(
      box.writeFile("/home/user/new.bin", bytes, { overwrite: false }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(box.readFile("/home/user/missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(box.readFile("/home/user/data.bin", { maxBytes: 2 })).rejects.toMatchObject({
      code: "CAPACITY",
    });
    expect(fixture.count("POST", /\/upload_file$/)).toBe(1);
  } finally {
    await client.close();
  }
});

test("suspend keeps the disk; resume starts fresh compute; a reference reopens with new credentials", async () => {
  const { fixture, connect } = setup();
  let client = await connect();

  try {
    const box = await client.sandboxes.create();
    const reference = JSON.parse(JSON.stringify(box.reference));
    await client.close();
    client = await connect();
    const reopened = await client.sandboxes.get(reference);

    expect(await reopened.suspend()).toMatchObject({
      preserve: "filesystem",
      processes: "terminated",
    });
    expect((await reopened.inspect()).state).toBe("suspended");
    await expect(
      reopened.exec({ command: { kind: "argv", argv: ["true"] } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await reopened.resume()).toMatchObject({ execution: "fresh", connections: "dropped" });
    expect((await reopened.inspect()).state).toBe("running");
    expect(fixture.count("POST", /\/(suspend|resume)$/)).toBe(2);
  } finally {
    await client.close();
  }
});

test("destroy confirms shutdown once; a snapshot in progress is a clean conflict", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    fixture.setSettlePolls(Number.MAX_SAFE_INTEGER);
    const capture = box.snapshot().catch((error: Error) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(box.destroy()).rejects.toMatchObject({ code: "CONFLICT" });
    fixture.setSettlePolls(0);
    await capture;

    expect(await box.destroy()).toMatchObject({ computeStopped: true });
    expect(fixture.devboxes.get(box.id)?.status).toBe("shutdown");
    expect(fixture.effects.destroy).toBe(1);
  } finally {
    await client.close();
  }
});

test("snapshots capture, list, inspect, restore and delete with exact identities", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    await source.writeFile("/home/user/state.txt", new TextEncoder().encode("kept"), {
      overwrite: true,
    });

    await expect(
      source.snapshot({ requirements: { preserve: "filesystem+memory" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      source.snapshot({ requirements: { maxInterruption: "none" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fixture.snapshots.size).toBe(0);

    const { snapshot } = await source.snapshot();
    expect(snapshot.reference.ownership).toBe("verified-created");
    expect(structuredClone(fixture.snapshots.get(snapshot.id)?.metadata)).toMatchObject({
      sandbar_submission: expect.any(String),
    });
    expect((await source.inspect()).state).toBe("running");

    const info = await snapshot.inspect();
    expect(info).toMatchObject({
      preserve: "filesystem",
      restoreExecution: "fresh",
      state: "ready",
    });
    expect(info.source).toEqual({ id: source.id, class: "runloop-devbox" });

    const listed = await client.snapshots.list({ limit: 10 });
    expect(listed.items.map((item) => item.reference.nativeId)).toEqual([snapshot.id]);

    const restored = await snapshot.restore();
    expect(restored.id).not.toBe(source.id);
    expect(createBodies(fixture).at(-1)?.body).toMatchObject({ snapshot_id: snapshot.id });
    expect((await restored.inspect()).state).toBe("running");

    await snapshot.delete();
    expect(fixture.snapshots.get(snapshot.id)?.status).toBe("deleted");
    await expect(snapshot.inspect()).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    await client.close();
  }
});

test("preview builds the tunnel URL with its header, or an open URL when configured public", async () => {
  const { connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    expect(await box.preview(3000)).toEqual({
      access: "protected",
      url: `https://3000-key${box.id.replace(/[^A-Za-z0-9]/g, "")}.tunnel.runloop.ai`,
      headers: { "X-Runloop-Tunnel-Authorization": `Bearer token-${box.id}` },
    });
  } finally {
    await client.close();
  }

  const open = await connect({ ...internet, preview: { access: "public" } });

  try {
    const box = await open.sandboxes.create();
    expect(await box.preview(8080)).toMatchObject({
      access: "public",
      url: `https://8080-key${box.id.replace(/[^A-Za-z0-9]/g, "")}.tunnel.runloop.ai`,
    });
  } finally {
    await open.close();
  }
});

test("inventory and listing are account-scoped; another account cannot reopen a reference", async () => {
  const { fixture, adapter } = setup();

  const main = await Sandbar.connect({
    adapter,
    config: internet,
    credentials: { apiKey: "fixture-main" },
  });

  const alt = await Sandbar.connect({
    adapter,
    config: internet,
    credentials: { apiKey: "fixture-alt" },
  });

  try {
    const mine = await main.sandboxes.create();
    await alt.sandboxes.create();
    const listed = await main.operations.inventory({ limit: 10 });
    expect(listed.items.map((item) => item.id)).toEqual([mine.id]);

    const page = await main.sandboxes.list();
    expect(page.items.map((item) => item.id)).toEqual([mine.id]);
    expect(page.items[0]?.reference?.ownership).toBe("unknown");

    if (!mine.reference) throw Error("Created sandbox has no reference");
    await expect(alt.sandboxes.get(mine.reference)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.effects.create).toBe(2);
  } finally {
    await main.close();
    await alt.close();
  }
});

test("API keys never appear in errors", async () => {
  const adapter = createRunloopAdapter({
    fetch: async () =>
      new Response(JSON.stringify({ message: "key secret-key-123 is invalid" }), { status: 401 }),
  });

  const error = await Sandbar.connect({
    adapter,
    config: internet,
    credentials: { apiKey: "secret-key-123" },
  }).then(
    () => undefined,
    (failure: Error & { code?: string }) => failure,
  );

  expect(error).toMatchObject({ code: "UNAUTHENTICATED" });
  expect(error?.message).not.toContain("secret-key-123");
});

test("command ids are RFC 9562 UUIDv7 values", () => {
  const id = uuidv7(0x0123456789ab);

  expect(id).toMatch(/^01234567-89ab-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
