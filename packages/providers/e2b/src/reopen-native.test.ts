import { afterEach, expect, test } from "bun:test";
import { Sandbox } from "e2b";
import { createSdkTransport } from "./transport";
import { createE2BAdapter } from "./index";
import { Sandbar } from "sandbar-sdk";
import { sandboxReference } from "sandbar-adapter";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fixture(start?: (request: Request) => Promise<Response>) {
  const calls: { method: string; url: URL; headers: Headers }[] = [];

  const detail = {
    sandboxID: "sandbox_one",
    templateID: "template_one",
    metadata: {},
    state: "running",
    envdVersion: "0.5.0",
    envdAccessToken: "guest-only-token",
    domain: "e2b.app",
    lifecycle: { autoResume: false },
    endAt: "2026-10-01T01:00:00Z",
  };

  let status = 200;
  let pausedAtGuest = false;

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      calls.push({ method: request.method, url, headers: request.headers });

      if (url.origin === "https://api.e2b.app") {
        expect(request.method).toBe("GET");

        return Response.json(detail, { status });
      }

      expect(url.origin).toBe("https://sandbox.e2b.app");
      expect(request.headers.get("X-Access-Token")).toBe("guest-only-token");
      expect(request.headers.get("E2b-Sandbox-Id")).toBe("sandbox_one");
      expect(request.headers.get("X-API-Key")).toBeNull();

      if (pausedAtGuest)
        return Response.json({ code: "unavailable", message: "paused" }, { status: 503 });

      if (url.pathname === "/files" && request.method === "GET")
        return new Response(new Uint8Array([0, 255, 8]));

      if (url.pathname === "/files" && request.method === "POST")
        return Response.json([{ path: "/tmp/value", name: "value", type: "file" }]);

      if (url.pathname.endsWith("/Start")) {
        if (start) return start(request);

        return new Response(
          Buffer.concat([
            processFrame({ event: { start: { pid: 1 } } }),
            processFrame({ event: { data: { stdout: btoa("fixture-output") } } }),
            processFrame({ event: { end: { exitCode: 0 } } }),
            processFrame({}, 2),
          ]),
          { headers: { "Content-Type": "application/connect+json" } },
        );
      }

      if (url.pathname.endsWith("/Remove")) return Response.json({});

      if (url.pathname === "/health") return new Response(null, { status: 204 });
      throw new Error(`Unexpected guest fixture ${request.method} ${url.pathname}`);
    },
    { preconnect() {} },
  );

  globalThis.fetch = fetcher;

  return {
    transport: createSdkTransport("control-only-key", fetcher),
    calls,
    detail,
    setStatus(value: number) {
      status = value;
    },
    pauseAtGuest() {
      pausedAtGuest = true;
    },
  };
}

test("real pinned E2B client attaches locally and routes exec/files with guest token only", async () => {
  const f = fixture();
  expect(await f.transport.get("sandbox_one")).toMatchObject({
    state: "running",
    endAt: f.detail.endAt,
  });
  expect(await f.transport.run("sandbox_one", "printf fixture-output", { timeoutMs: 1000 })).toBe(
    "fixture-output",
  );
  expect((await f.transport.read("sandbox_one", "/tmp/value", 100)).bytes).toEqual(
    new Uint8Array([0, 255, 8]),
  );
  await f.transport.write("sandbox_one", "/tmp/value", new Uint8Array([8]));
  await f.transport.remove("sandbox_one", "/tmp/stage");
  expect(
    f.calls.filter((c) => c.url.origin === "https://api.e2b.app").every((c) => c.method === "GET"),
  ).toBe(true);
});

test.each([
  "auto-resume",
  "missing-policy",
  "missing-token",
  "missing-version",
  "missing-domain",
  "foreign-domain",
  "paused",
])("guest attachment rejects unsafe detail before guest IO: %s", async (mode) => {
  const f = fixture();

  if (mode === "auto-resume") f.detail.lifecycle.autoResume = true;

  if (mode === "missing-policy") Reflect.deleteProperty(f.detail, "lifecycle");

  if (mode === "missing-token") Reflect.deleteProperty(f.detail, "envdAccessToken");

  if (mode === "missing-version") Reflect.deleteProperty(f.detail, "envdVersion");

  if (mode === "missing-domain") Reflect.deleteProperty(f.detail, "domain");

  if (mode === "foreign-domain") f.detail.domain = "untrusted.invalid";

  if (mode === "paused") f.detail.state = "paused";
  expect(await f.transport.get("sandbox_one")).toMatchObject({ attachmentReady: false });
  Object.assign(f.detail.metadata, {
    sandbar_scope: "team_one:base",
    sandbar_operation: "operation_one",
    sandbar_submission: "submission_one",
    sandbar_template: "template_one",
  });
  let saved = 0;
  const transport = { ...f.transport, async verifyAuth() {}, async verifyTeam() {} };

  const client = await Sandbar.connect({
    adapter: createE2BAdapter(() => transport),
    config: { teamId: "team_one" },
    credentials: { apiKey: "fixture-key" },
    onReference() {
      saved++;
    },
  });

  try {
    const box = await client.sandboxes.get(
      sandboxReference("e2b", client.scope, "sandbox_one", {
        operation: "operation_one",
        submission: "submission_one",
      }),
    );

    for (const call of [
      () => box.exec(["true"]),
      () => box.writeFile("/tmp/value", new Uint8Array([1])),
    ])
      await expect(call()).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
    expect(saved).toBe(0);
  } finally {
    await client.close();
  }

  for (const call of [
    () => f.transport.run("sandbox_one", "echo x", { timeoutMs: 1000 }),
    () => f.transport.read("sandbox_one", "/tmp/value", 100),
    () => f.transport.write("sandbox_one", "/tmp/value", new Uint8Array([1])),
    () => f.transport.remove("sandbox_one", "/tmp/value"),
  ])
    await expect(call()).rejects.toThrow();
  expect(f.calls.every((c) => c.url.origin === "https://api.e2b.app" && c.method === "GET")).toBe(
    true,
  );
});

test("pause between read and guest request never connects, extends timeout or replays commands", async () => {
  const f = fixture();
  f.pauseAtGuest();
  await expect(f.transport.run("sandbox_one", "echo x", { timeoutMs: 1000 })).rejects.toThrow();
  expect(f.calls.filter((c) => c.url.pathname.endsWith("/Start"))).toHaveLength(1);
  expect(
    f.calls.filter((c) => c.url.origin === "https://api.e2b.app").every((c) => c.method === "GET"),
  ).toBe(true);
});

test.each([
  [404, "NOT_FOUND"],
  [403, "FORBIDDEN"],
  [503, "UNAVAILABLE"],
] as const)("native detail status %s remains distinct", async (status, code) => {
  const f = fixture();
  f.setStatus(status);

  if (status === 404) expect(await f.transport.get("sandbox_one")).toBeNull();
  else await expect(f.transport.get("sandbox_one")).rejects.toMatchObject({ code });
});

test.each([401, 403])(
  "native authority denial remains forbidden during verification: %s",
  async (status) => {
    const fetcher: typeof fetch = Object.assign(async () => new Response(null, { status }), {
      preconnect() {},
    });

    const transport = createSdkTransport("revoked-key", fetcher);
    await expect(transport.verifyAuth()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(transport.verifyTeam("team_one")).rejects.toMatchObject({ code: "FORBIDDEN" });
  },
);

test.each([401, 403])(
  "reopening with revoked team permission reports forbidden before sandbox detail: %s",
  async (status) => {
    let revoked = false;
    let details = 0;

    const fetcher: typeof fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;

        if (path.startsWith("/teams/"))
          return Response.json({}, { status: revoked ? status : 200 });

        if (path === "/sandboxes/sandbox_one") {
          details++;

          return Response.json({
            sandboxID: "sandbox_one",
            templateID: "template_one",
            state: "running",
            metadata: {
              sandbar_scope: "team_one:base",
              sandbar_operation: "operation_one",
              sandbar_submission: "submission_one",
              sandbar_template: "template_one",
            },
          });
        }

        throw new Error("Unexpected authority fixture");
      },
      { preconnect() {} },
    );

    const client = await Sandbar.connect({
      adapter: createE2BAdapter(() => createSdkTransport("fixture-key", fetcher)),
      config: { teamId: "team_one" },
      credentials: { apiKey: "fixture-key" },
    });

    const reference = sandboxReference("e2b", client.scope, "sandbox_one", {
      operation: "operation_one",
      submission: "submission_one",
    });

    try {
      expect((await client.sandboxes.get(reference)).id).toBe("sandbox_one");
      revoked = true;
      await expect(client.sandboxes.get(reference)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(details).toBe(1);
    } finally {
      await client.close();
    }
  },
);

test("pinned native creation explicitly disables timeout pause and auto-resume", async () => {
  let creates = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe("https://api.e2b.app/v2/sandboxes");
      expect(request.method).toBe("POST");
      expect(await request.json()).toMatchObject({
        autoPause: false,
        autoResume: { enabled: false },
        timeout: 60,
      });
      creates++;

      return Response.json({
        sandboxID: "sandbox_one",
        envdVersion: "0.5.0",
        envdAccessToken: "guest-only-token",
        domain: "e2b.app",
      });
    },
    { preconnect() {} },
  );
  const transport = createSdkTransport("fixture-key");
  expect(
    await transport.create({
      templateId: "base",
      metadata: {},
      timeoutMs: 60000,
      allowInternetAccess: false,
    }),
  ).toBe("sandbox_one");
  expect(creates).toBe(1);
});

test("pinned E2B file read forwards abort to download and cancels a stalled native body", async () => {
  const f = fixture();
  const fetcher = globalThis.fetch;
  let entered!: () => void;

  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  let signal: AbortSignal | undefined;
  let cancelled = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled++;
    },
  });

  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);

      if (new URL(request.url).pathname === "/files") {
        signal = request.signal;
        entered();

        return new Response(stream);
      }

      return fetcher(input, init);
    },
    { preconnect() {} },
  );
  const controller = new AbortController();

  const read = f.transport
    .read("sandbox_one", "/tmp/value", 16, controller.signal)
    .catch((error: Error) => error);

  await started;
  await Promise.resolve();
  controller.abort(new Error("caller stopped"));
  expect(await read).toBe(controller.signal.reason);
  expect(signal?.aborted).toBe(true);
  expect(cancelled).toBe(1);
  // The pinned SDK keeps its private body reader locked even after cancel.
  // Sandbar releases its own reader; native wrapper cleanup is best effort.
  expect(
    f.calls.filter((c) => c.url.origin === "https://api.e2b.app").every((c) => c.method === "GET"),
  ).toBe(true);
});

type NativeProcessFrame = {
  event?: { start?: { pid: number }; data?: { stdout: string }; end?: { exitCode: number } };
  error?: { code: string; message: string };
};

function processFrame(value: NativeProcessFrame, flags = 0): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const framed = new Uint8Array(bytes.length + 5);
  framed[0] = flags;
  new DataView(framed.buffer).setUint32(1, bytes.length);
  framed.set(bytes, 5);

  return framed;
}

test("pinned E2B maps bounded exec to RPC options without a process runtime field", async () => {
  const f = fixture(async (request) => {
    expect(request.headers.get("connect-timeout-ms")).toBe("1234");
    expect(await request.json()).toEqual({
      process: { cmd: "/bin/bash", args: ["-l", "-c", "sleep 10"] },
    });

    return new Response(
      Buffer.concat([
        processFrame({ event: { start: { pid: 1 } } }),
        processFrame({ error: { code: "deadline_exceeded", message: "RPC observation ended" } }, 2),
      ]),
      { headers: { "Content-Type": "application/connect+json" } },
    );
  });

  await expect(f.transport.run("sandbox_one", "sleep 10", { timeoutMs: 1234 })).rejects.toThrow();
  expect(f.calls.filter((call) => call.url.pathname.endsWith("/Start"))).toHaveLength(1);
  expect(f.calls.some((call) => /Kill|SendSignal|kill|connect/.test(call.url.pathname))).toBe(
    false,
  );
  expect(
    f.calls
      .filter((call) => call.url.origin === "https://api.e2b.app")
      .every((call) => call.method === "GET"),
  ).toBe(true);
});

test.each([false, true])(
  "pinned E2B handshake timer clears only after PID: %s",
  async (acknowledged) => {
    let requestSignal: AbortSignal | undefined;

    const f = fixture(async (request) => {
      requestSignal = request.signal;
      expect(request.headers.get("connect-timeout-ms")).toBe("1000");

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            request.signal.addEventListener(
              "abort",
              () => controller.error(request.signal.reason),
              { once: true },
            );

            if (acknowledged) controller.enqueue(processFrame({ event: { start: { pid: 1 } } }));
            // Complete after the handshake budget but before the independent RPC budget.
            setTimeout(() => {
              if (request.signal.aborted) return;
              controller.enqueue(processFrame({ event: { end: { exitCode: 0 } } }));
              controller.enqueue(processFrame({}, 2));
              controller.close();
            }, 80);
          },
        }),
        { headers: { "Content-Type": "application/connect+json" } },
      );
    });

    // Exercise the actual pinned Commands/CommandHandle implementation with distinct timers.
    const sandbox = new Sandbox({
      sandboxId: "sandbox_one",
      envdVersion: "0.5.0",
      envdAccessToken: "guest-only-token",
      sandboxDomain: "e2b.app",
      sandboxUrl: "https://sandbox.e2b.app",
      apiKey: "control-only-key",
    });

    const run = sandbox.commands.run("sleep 10", { timeoutMs: 1000, requestTimeoutMs: 25 });

    if (acknowledged) expect((await run).exitCode).toBe(0);
    else await expect(run).rejects.toThrow("handshake timed out");
    expect(requestSignal?.aborted).toBe(true); // CommandHandle/start cleanup is local.
    expect(f.calls.filter((call) => call.url.pathname.endsWith("/Start"))).toHaveLength(1);
    expect(f.calls.some((call) => /Kill|SendSignal|kill/.test(call.url.pathname))).toBe(false);
  },
);
