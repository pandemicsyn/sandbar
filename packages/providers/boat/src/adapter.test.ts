import { afterEach, expect, test } from "bun:test";
import { adapterSuite } from "@sandbar-sdk/adapter/testing";
import { Image, NonzeroExitError, OutcomeUnknownError, Sandbar } from "sandbar-sdk";
import { createBoatAdapter } from "./adapter";
import { boatFixture } from "./fixture.test-support";

const fixtures: ReturnType<typeof boatFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const config = { network: "internet" } as const;

function setup() {
  const fixture = boatFixture();
  fixtures.push(fixture);
  const adapter = createBoatAdapter({ fetch: fixture.fetch, pollIntervalMs: 1, settleSeconds: 1 });

  const connect = () =>
    Sandbar.connect({ adapter, config, credentials: { apiKey: "fixture-main" } });

  return { fixture, adapter, connect };
}

test("Boat conformance: one native attempt, distinct accounts, lost and late responses", async () => {
  const { fixture, adapter } = setup();

  const report = await adapterSuite({
    adapter,
    fixture: {
      config,
      credentials: { apiKey: "fixture-main" },
      alternate: { config, credentials: { apiKey: "fixture-alt" } },
      createInput: {
        image: { kind: "prepared", value: "ubuntu-24.04" },
        networkPolicy: "internet",
      },
      counters: () => ({ ...fixture.effects }),
      expectedReleasesPerConnection: 0,
      loseNextCreateResponse: fixture.loseNextCreateResponse,
      holdNextCreateResponse: fixture.holdNextCreateResponse,
      releaseHeldCreateResponse: fixture.releaseHeldCreateResponse,
      assertNativeRetriesDisabled() {
        expect(fixture.count("POST", /^\/sandboxes$/)).toBe(0);
      },
    },
  });

  expect(report.counters).toEqual({ create: 3, destroy: 1, release: 0 });
  // Each create effect came from exactly one outbound request.
  expect(fixture.count("POST", /^\/sandboxes$/)).toBe(3);
});

test("setup requires explicit internet and rejects blocked egress before any effect", async () => {
  const { fixture, adapter, connect } = setup();

  await expect(
    Sandbar.connect({ adapter, config: {}, credentials: { apiKey: "fixture-main" } }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(fixture.calls).toHaveLength(0);

  const client = await connect();

  try {
    expect((await client.capabilities()).network).toEqual(["internet"]);
    await expect(client.sandboxes.create({ networkPolicy: "blocked" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
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

test("create sends the submission as Idempotency-Key, withholds account secrets and sets the lifetime", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();

    const create = fixture.calls.find(
      (call) => call.method === "POST" && call.path === "/sandboxes",
    );

    expect(create?.headers.get("idempotency-key")).toBeTruthy();
    expect(create?.body).toEqual({ type: "default", ttlSeconds: 900, noEnv: true });
    expect((await box.inspect()).state).toBe("running");
    expect((await box.inspect()).expires).toMatchObject({ status: "known", action: "suspend" });

    const named = await client.sandboxes.create({ environment: Image.prepared("my-base") });
    expect(fixture.calls.filter((call) => call.path === "/sandboxes").at(-1)?.body).toMatchObject({
      from: "my-base",
    });
    await named.destroy();
    await box.destroy();
  } finally {
    await client.close();
  }

  const { fixture: other, adapter } = setup();

  const configured = await Sandbar.connect({
    adapter,
    config: { ...config, environment: "ci", machine: "large", lifecycle: { lifetimeSeconds: 120 } },
    credentials: { apiKey: "fixture-main" },
  });

  try {
    await (await configured.sandboxes.create()).destroy();
    expect(other.calls.find((call) => call.path === "/sandboxes")?.body).toEqual({
      type: "large",
      ttlSeconds: 120,
      environment: "ci",
    });

    await (await configured.sandboxes.create({ lifecycle: { lifetimeSeconds: 3600 } })).destroy();
    expect(other.calls.filter((call) => call.path === "/sandboxes").at(-1)?.body).toMatchObject({
      ttlSeconds: 3600,
    });
    await expect(
      configured.sandboxes.create({ lifecycle: { lifetimeSeconds: 30 } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally {
    await configured.close();
  }
});

test("Boat resources pick the smallest machine type and inspect reports its size", async () => {
  const { fixture, adapter } = setup();

  const client = await Sandbar.connect({
    adapter,
    config: { ...config, resources: { vcpus: 3 } },
    credentials: { apiKey: "fixture-main" },
  });

  try {
    const box = await client.sandboxes.create();
    expect(fixture.calls.find((call) => call.path === "/sandboxes")?.body).toMatchObject({
      type: "default",
    });
    expect((await box.inspect()).resources).toEqual({
      status: "known",
      value: { vcpus: 4, memoryMiB: 8192 },
    });
    await box.destroy();
  } finally {
    await client.close();
  }

  const before = fixture.calls.length;
  await expect(
    Sandbar.connect({
      adapter,
      config: { ...config, resources: { vcpus: 32 } },
      credentials: { apiKey: "fixture-main" },
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
    message: expect.stringContaining("largest is 16 vCPU / 32768 MiB"),
  });
  await expect(
    Sandbar.connect({
      adapter,
      config: { ...config, machine: "small", resources: { vcpus: 2 } },
      credentials: { apiKey: "fixture-main" },
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(fixture.calls).toHaveLength(before);
});

test("create refusals are clean rejections; in-flight idempotency and 5xx stay unknown", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.setProvisioningPolls(1);
    const original = fixture.fetch;
    let next: Response | undefined;

    fixture.calls.length = 0;

    const patched = createBoatAdapter({
      fetch: async (input, init) =>
        init?.method === "POST" && next
          ? ((value) => ((next = undefined), value))(next)
          : original(input, init),
      pollIntervalMs: 1,
      settleSeconds: 1,
    });

    const direct = await Sandbar.connect({
      adapter: patched,
      config,
      credentials: { apiKey: "fixture-main" },
    });

    try {
      next = fixture.error(429, "limit_reached");
      await expect(direct.sandboxes.create()).rejects.toMatchObject({ code: "RATE_LIMIT" });
      next = fixture.error(503, "no_ready_machine");
      await expect(direct.sandboxes.create()).rejects.toMatchObject({ code: "UNAVAILABLE" });
      next = fixture.error(409, "idempotency_in_progress");
      await expect(direct.sandboxes.create()).rejects.toBeInstanceOf(OutcomeUnknownError);
      next = fixture.error(502, "gateway_error");
      await expect(direct.sandboxes.create()).rejects.toBeInstanceOf(OutcomeUnknownError);
    } finally {
      await direct.close();
    }
  } finally {
    await client.close();
  }
});

test("slow provisioning keeps one create effect and completes through observation", async () => {
  const { fixture, connect } = setup();
  fixture.setProvisioningPolls(Number.MAX_SAFE_INTEGER);
  const client = await connect();

  try {
    setTimeout(() => fixture.setProvisioningPolls(0), 50);
    const box = await client.sandboxes.create();
    expect((await box.inspect()).state).toBe("running");
    expect(fixture.effects.create).toBe(1);
    expect(fixture.count("POST", /^\/sandboxes$/)).toBe(1);
    await box.destroy();
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
    expect(argv.exitCode).toBe(0);

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
    const binary = failed.result;

    expect(binary.stdout).toEqual(Uint8Array.of(0, 255, 128));
    expect(binary.stderr).toEqual(Uint8Array.of(119, 97, 114, 110, 255));
    expect(binary.exitCode).toBe(3);
    expect(binary.truncated).toBe(false);

    const stdin = Uint8Array.of(0, 1, 255, 10, 66);
    const echoed = await box.exec({ command: { kind: "argv", argv: ["cat"] }, stdin });
    expect(echoed.stdout).toEqual(stdin);
    expect(fixture.count("PUT", /\/files$/)).toBe(1);

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
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("exec refusals before running reject; lost, timed-out or undecodable results are unknown and never replayed", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const command = { kind: "argv" as const, argv: ["true"] };

    await expect(box.exec({ command, deadlineSeconds: 601 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(box.exec({ command, env: { "BAD-NAME": "x" } })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(fixture.commands).toHaveLength(0);

    fixture.failNextCommand(
      fixture.error(502, "sandbox_direct_failed", { error: { details: { retryable: true } } }),
    );
    await expect(box.exec({ command })).rejects.toMatchObject({ code: "UNAVAILABLE" });

    fixture.failNextCommand(fixture.error(502, "sandbox_direct_failed"));
    await expect(box.exec({ command })).rejects.toBeInstanceOf(OutcomeUnknownError);

    fixture.failNextCommand("lost");
    await expect(box.exec({ command })).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(fixture.commands).toHaveLength(1);

    fixture.overrideCommands(() => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    await expect(box.exec({ command })).rejects.toBeInstanceOf(OutcomeUnknownError);

    // User output that imitates the record cannot become a result.
    fixture.overrideCommands(() => ({
      exitCode: 0,
      stdout: "SANDBAR-EXEC-1 0 1 0\nQQ==\n\nextra",
      stderr: "",
      timedOut: false,
    }));
    await expect(box.exec({ command })).rejects.toBeInstanceOf(OutcomeUnknownError);
    fixture.overrideCommands(undefined);
    expect(fixture.count("POST", /\/commands$/)).toBe(5);
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("files round-trip bytes as base64, reject no-clobber and enforce the write bound", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const bytes = Uint8Array.of(0, 255, 128, 10);
    await box.writeFile("/home/user/data.bin", bytes, { overwrite: true });
    expect(await box.readFile("/home/user/data.bin")).toEqual(bytes);
    expect(fixture.calls.find((call) => call.method === "PUT")?.body).toEqual({
      path: "/home/user/data.bin",
      content: "AP+ACg==",
      encoding: "base64",
    });

    await expect(
      box.writeFile("/home/user/new.bin", bytes, { overwrite: false }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      box.writeFile("/home/user/big.bin", new Uint8Array(5 * 1024 * 1024 + 1), { overwrite: true }),
    ).rejects.toMatchObject({ code: "CAPACITY" });
    await expect(box.writeFile("/etc/passwd", bytes, { overwrite: true })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(fixture.count("PUT", /\/files$/)).toBe(2);
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("suspend archives the disk; resume starts fresh compute; renew moves the auto-stop", async () => {
  const { fixture, connect } = setup();
  let client = await connect();

  try {
    const box = await client.sandboxes.create();
    const reference = JSON.parse(JSON.stringify(box.reference));
    await client.close();
    client = await connect();
    const reopened = await client.sandboxes.get(reference);

    const suspended = await reopened.suspend();
    expect(suspended).toMatchObject({ preserve: "filesystem", processes: "terminated" });
    expect((await reopened.inspect()).state).toBe("suspended");
    await expect(
      reopened.exec({ command: { kind: "argv", argv: ["true"] } }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const resumed = await reopened.resume();
    expect(resumed).toMatchObject({ execution: "fresh", connections: "dropped" });
    expect((await reopened.inspect()).state).toBe("running");
    expect(fixture.calls.find((call) => call.path.endsWith("/resume"))?.body).toEqual({
      ttlSeconds: 900,
    });

    const renewed = await reopened.renew({ forSeconds: 3600 });
    expect(renewed.requested).toEqual({ forSeconds: 3600 });
    expect(fixture.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      ttlSeconds: 3600,
    });
    await expect(reopened.renew({ forSeconds: 31 * 24 * 3600 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await reopened.destroy();
  } finally {
    await client.close();
  }
});

test("destroy confirms by id and waits for the deletion operation; inventory is account-scoped", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const result = await box.destroy();
    expect(result.computeStopped).toBe(true);
    const remove = fixture.calls.find((call) => call.method === "DELETE");
    expect(remove?.headers.get("x-ascii-confirm-delete")).toBe("bx_1");
    expect(fixture.count("GET", /^\/deletion-operations\//)).toBeGreaterThan(0);
  } finally {
    await client.close();
  }

  const { fixture: shared, adapter } = setup();
  const main = await Sandbar.connect({ adapter, config, credentials: { apiKey: "fixture-main" } });
  const alt = await Sandbar.connect({ adapter, config, credentials: { apiKey: "fixture-alt" } });

  try {
    const mine = await main.sandboxes.create();
    await alt.sandboxes.create();
    const listed = await main.operations.inventory({ limit: 10 });
    expect(listed.items.map((item) => item.id)).toEqual([mine.id]);

    if (!mine.reference) throw Error("Created sandbox has no reference");
    await expect(alt.sandboxes.get(mine.reference)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(shared.effects.create).toBe(2);
  } finally {
    await main.close();
    await alt.close();
  }
});

test("API keys never appear in errors", async () => {
  const fixture = boatFixture();
  fixtures.push(fixture);

  const adapter = createBoatAdapter({
    fetch: async () =>
      new Response(
        JSON.stringify({ status: 401, code: "bad_key", message: "key secret-key-123 is invalid" }),
        { status: 401 },
      ),
  });

  const error = await Sandbar.connect({
    adapter,
    config,
    credentials: { apiKey: "secret-key-123" },
  }).then(
    () => undefined,
    (failure: Error & { code?: string }) => failure,
  );

  expect(error).toMatchObject({ code: "UNAUTHENTICATED" });
  expect(error?.message).not.toContain("secret-key-123");
});
