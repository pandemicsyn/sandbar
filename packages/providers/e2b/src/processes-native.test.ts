import { afterEach, expect, test } from "bun:test";
import { Sandbar } from "sandbar-sdk";
import { sandboxReference } from "sandbar-adapter";
import { createE2BAdapter } from "./index";
import { createSdkTransport } from "./transport";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type ProcessFrame = {
  event?: {
    start?: { pid: number };
    data?: { stdout?: string; stderr?: string };
    end?: { exitCode: number };
  };
};

function frame(value: ProcessFrame, flags = 0): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const result = new Uint8Array(bytes.length + 5);
  result[0] = flags;
  new DataView(result.buffer).setUint32(1, bytes.length);
  result.set(bytes, 5);

  return result;
}

async function fixture(
  options: {
    early?: boolean;
    holdStart?: boolean;
    signalReply?: "not-found" | "lost";
    modern?: boolean;
  } = {},
) {
  const calls: { method: string; path: string; body?: object; headers: Headers }[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = 0;
  let details = 0;
  let pauseAtAttach = false;
  let earlyCallbacks = 0;
  let startResolved = false;
  let deleted = false;
  let target: "original" | "successor" = "original";
  let signaled: "original" | "successor" | undefined;

  const detail = {
    sandboxID: "box_one",
    templateID: "template_one",
    state: "running",
    metadata: {
      sandbar_scope: "team_one:base",
      sandbar_operation: "operation_one",
      sandbar_submission: "submission_one",
      sandbar_template: "template_one",
    },
    envdVersion: options.modern ? "0.5.2" : "0.5.0",
    envdAccessToken: "guest-secret",
    domain: "e2b.app",
    lifecycle: { autoResume: false },
  };

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      calls.push({ method: request.method, path: url.pathname, headers: request.headers });

      if (url.origin === "https://api.e2b.app") {
        if (request.method === "DELETE") {
          deleted = true;
          controller.error(new Error("native sandbox destroyed"));

          return new Response(null, { status: 204 });
        }

        expect(request.method).toBe("GET");

        if (deleted) return Response.json({}, { status: 404 });

        if (pauseAtAttach && ++details === 2) return Response.json({ ...detail, state: "paused" });

        return Response.json(detail);
      }

      expect(request.headers.get("X-Access-Token")).toBe("guest-secret");
      expect(request.headers.get("X-API-Key")).toBeNull();

      if (url.pathname.endsWith("/Start")) {
        const requestBytes = new Uint8Array(await request.arrayBuffer());
        calls[calls.length - 1]!.body = JSON.parse(
          new TextDecoder().decode(requestBytes.subarray(5)),
        );
        expect([null, "0"]).toContain(request.headers.get("connect-timeout-ms"));

        const body = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;

            if (!options.holdStart) value.enqueue(frame({ event: { start: { pid: 9 } } }));

            if (options.early) value.enqueue(frame({ event: { data: { stdout: btoa("early") } } }));
          },
          cancel() {
            canceled++;
          },
        });

        request.signal.addEventListener(
          "abort",
          () => {
            canceled++;

            try {
              controller.error(new Error("local disconnect"));
            } catch {
              /* already ended */
            }
          },
          { once: true },
        );

        return new Response(body, { headers: { "Content-Type": "application/connect+json" } });
      }

      if (url.pathname.endsWith("/List"))
        return Response.json({
          processes: [{ pid: 9, config: { cmd: "worker", args: [], envs: {} } }],
        });

      if (url.pathname.endsWith("/SendInput") || url.pathname.endsWith("/CloseStdin")) {
        calls[calls.length - 1]!.body = await request.json();

        return Response.json({});
      }

      if (url.pathname.endsWith("/SendSignal")) {
        calls[calls.length - 1]!.body = await request.json();

        if (options.signalReply === "lost") throw new Error("lost termination acknowledgement");

        if (options.signalReply === "not-found")
          return Response.json({ code: "not_found", message: "absent" }, { status: 404 });

        signaled = target;

        return Response.json({});
      }

      if (url.pathname === "/health") return new Response(null, { status: 204 });
      throw new Error(`Unexpected guest call ${url.pathname}`);
    },
    { preconnect() {} },
  );

  globalThis.fetch = fetcher;
  const transport = createSdkTransport("control-secret", fetcher);

  const client = await Sandbar.connect({
    adapter: createE2BAdapter(() => ({
      ...transport,
      async startText(id, command, startOptions, ctx) {
        const handle = await transport.startText!(id, command, startOptions, {
          ...ctx,
          onOutput(chunk) {
            if (!startResolved) earlyCallbacks++;
            ctx.onOutput(chunk);
          },
        });

        // Hold adapter acknowledgement while the real pinned handle receives early frames.
        if (options.early) await Bun.sleep(0);
        startResolved = true;

        return handle;
      },
      async verifyAuth() {},
      async verifyTeam() {},
    })),
    config: { teamId: "team_one" },
    credentials: { apiKey: "fixture" },
  });

  const ref = sandboxReference("e2b", client.scope, "box_one", {
    operation: "operation_one",
    submission: "submission_one",
  });

  const box = await client.sandboxes.get(ref);
  details = 0;

  return {
    client,
    box,
    calls,
    detail,
    get canceled() {
      return canceled;
    },
    reusePid() {
      target = "successor";
    },
    get signaled() {
      return signaled;
    },
    get earlyCallbacks() {
      return earlyCallbacks;
    },
    pause() {
      pauseAtAttach = true;
    },
    data(stream: "stdout" | "stderr", bytes: Uint8Array) {
      controller.enqueue(
        frame({ event: { data: { [stream]: Buffer.from(bytes).toString("base64") } } }),
      );
    },
    exit(code: number) {
      controller.enqueue(frame({ event: { end: { exitCode: code } } }));
    },
    finish() {
      controller.enqueue(frame({}, 2));
      controller.close();
    },
    raw(bytes: Uint8Array) {
      controller.enqueue(bytes);
    },
    end(code: number) {
      controller.enqueue(frame({ event: { end: { exitCode: code } } }));
      controller.enqueue(frame({}, 2));
      controller.close();
    },
    lost() {
      controller.error(new Error("lost response secret"));
    },
    interrupt() {
      detail.state = "paused";
      detail.envdAccessToken = "new-generation-secret";
      controller.error(new Error("native lifecycle interrupted observation"));
    },
  };
}

const input = { command: { kind: "argv" as const, argv: ["printf", "hello"] } };

test("pinned early callbacks survive held adapter start acknowledgement", async () => {
  const f = await fixture({ early: true });
  const p = await f.box.processes.start(input);
  expect(f.earlyCallbacks).toBeGreaterThan(0);
  const out = p.output()[Symbol.asyncIterator]();
  expect((await out.next()).value).toEqual({ stream: "stdout", text: "early" });
  f.end(0);
  expect(await out.next()).toMatchObject({ done: true });
  expect(await p.wait()).toEqual({ exitCode: 0, outputComplete: true });
  await f.client.close();
});

test.each(["lost", "abort", "close"])(
  "pinned start acknowledgement %s never replays and releases stream",
  async (mode) => {
    const f = await fixture({ holdStart: true });
    const cancel = new AbortController();
    const pending = f.box.processes.start(input, { signal: cancel.signal });

    while (!f.calls.some((c) => c.path.endsWith("/Start"))) await Bun.sleep(0);

    if (mode === "lost") f.lost();

    if (mode === "abort") cancel.abort();

    if (mode === "close") await f.client.close();
    await expect(pending).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      effect: "possible",
      provider: "e2b",
      sandboxId: "box_one",
    });
    expect(f.calls.filter((c) => c.path.endsWith("/Start"))).toHaveLength(1);

    if (mode !== "lost") expect(f.canceled).toBeGreaterThan(0);
    await f.client.close();
  },
);

test("pinned native live stdout/stderr decoding, nonzero exit, closed stdin and read-only attachment", async () => {
  const f = await fixture();
  const setup = new AbortController();
  const p = await f.box.processes.start(input, { signal: setup.signal });
  setup.abort();
  const out = p.output()[Symbol.asyncIterator]();
  f.data("stdout", new Uint8Array([0xf0, 0x9f]));
  f.data("stderr", new TextEncoder().encode("err"));
  expect((await out.next()).value).toEqual({ stream: "stderr", text: "err" });
  f.data("stdout", new Uint8Array([0x98, 0x80, 0xff]));
  expect((await out.next()).value).toEqual({ stream: "stdout", text: "😀�" });
  f.end(7);
  expect(await out.next()).toMatchObject({ done: true });
  expect(await p.wait()).toEqual({ exitCode: 7, outputComplete: true });
  const starts = f.calls.filter((c) => c.path.endsWith("/Start"));
  expect(starts).toHaveLength(1);
  expect(starts[0]!.body).toMatchObject({ stdin: false });
  expect(f.calls.some((c) => /connect|resume|timeout|SendSignal/.test(c.path))).toBe(false);
  await f.client.close();
});

test("native confirmed end survives decoder-flush capacity failure", async () => {
  const f = await fixture();
  const p = await f.box.processes.start({ ...input, maxOutputBytes: 1 });
  const out = p.output()[Symbol.asyncIterator]();
  f.data("stdout", new Uint8Array([0xf0]));
  f.end(5);
  await expect(out.next()).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  expect(await p.wait()).toEqual({ exitCode: 5, outputComplete: false });
  await f.client.close();
});

test.each(["pause", "autoResume", "missingPolicy", "missingToken"])(
  "native %s rejected before guest dispatch",
  async (mode) => {
    const f = await fixture();

    if (mode === "pause") f.pause();

    if (mode === "autoResume") f.detail.lifecycle.autoResume = true;

    if (mode === "missingPolicy") Reflect.deleteProperty(f.detail, "lifecycle");

    if (mode === "missingToken") Reflect.deleteProperty(f.detail, "envdAccessToken");
    await expect(f.box.processes.start(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await f.client.close();
  },
);

test("native oversized callback disconnects promptly; no subsequent admission or remote signal", async () => {
  const f = await fixture();
  const p = await f.box.processes.start({ ...input, maxOutputBytes: 2 });
  f.data("stdout", new TextEncoder().encode("abc"));
  const out = p.output()[Symbol.asyncIterator]();
  await expect(out.next()).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  await expect(p.wait()).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  expect(f.canceled).toBeGreaterThan(0);
  expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  await f.client.close();
});

test("native transport loss has no invented exit and never replays start", async () => {
  const f = await fixture();
  const p = await f.box.processes.start(input);
  f.lost();
  await expect(p.wait()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await expect(p.output()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });
  expect(f.calls.filter((c) => c.path.endsWith("/Start"))).toHaveLength(1);
  await f.client.close();
});

test("explicit owned sandbox destruction ends observation without reattaching", async () => {
  const f = await fixture();
  const p = await f.box.processes.start(input);
  const waiting = p.wait().catch((error) => error);
  await f.box.destroy();
  expect(await waiting).toMatchObject({ code: "UNAVAILABLE" });
  await expect(p.output()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });
  expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  expect(f.calls.filter((c) => c.path.endsWith("/Start"))).toHaveLength(1);
  expect(f.calls.some((c) => /Connect|connect|resume/.test(c.path))).toBe(false);
  await f.client.close();
});

test("native snapshot/suspend interruption cannot follow a changed guest generation", async () => {
  const f = await fixture();
  const p = await f.box.processes.start(input);
  const calls = f.calls.length;
  f.interrupt();
  await expect(p.wait()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(f.calls.slice(calls).every((c) => c.path === "/health")).toBe(true);
  expect(f.calls.filter((c) => c.path.endsWith("/Start"))).toHaveLength(1);
  await f.client.close();
});

test.each(["ack", "not-found", "lost"])(
  "pinned termination %s uses one PID SIGKILL and original connection",
  async (mode) => {
    const f = await fixture({ signalReply: mode === "ack" ? undefined : mode });
    const p = await f.box.processes.start(input);
    const before = f.calls.length;

    if (mode === "lost") {
      await expect(p.terminate()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      await expect(p.terminate()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    } else {
      expect(await p.terminate()).toEqual({ status: mode === "ack" ? "requested" : "not-found" });
      expect(await p.terminate()).toEqual({ status: mode === "ack" ? "requested" : "not-found" });
    }

    const requests = f.calls.slice(before).filter((c) => c.path.endsWith("/SendSignal"));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ process: { pid: 9 }, signal: "SIGNAL_SIGKILL" });
    expect(
      f.calls
        .slice(before)
        .some(
          (c) => c.path.endsWith("/connect") || c.path.endsWith("/Start") || c.method === "DELETE",
        ),
    ).toBe(false);
    expect(f.canceled).toBe(0);
    f.end(-1);
    expect(await p.wait()).toMatchObject({ exitCode: -1 });
    expect(await p.terminate()).toEqual({ status: "exited" });
    expect(f.calls.filter((c) => c.path.endsWith("/SendSignal"))).toHaveLength(1);
    await f.client.close();
  },
);

test("pinned active selector cannot distinguish an unobserved PID successor", async () => {
  const f = await fixture();
  const p = await f.box.processes.start(input);
  // Simulate remote PID 9 now belonging to a successor, before its old end event arrives.
  // The request has no execution token with which the native fixture could reject it.
  f.reusePid();
  expect(await p.terminate()).toEqual({ status: "requested" });
  expect(f.signaled).toBe("successor");
  const request = f.calls.find((c) => c.path.endsWith("/SendSignal"));
  expect(request!.body).toEqual({ process: { pid: 9 }, signal: "SIGNAL_SIGKILL" });
  await p.detach();
  await f.client.close();
});

test("pinned lifecycle stream interruption prevents new termination without reattachment", async () => {
  const f = await fixture();
  const p = await f.box.processes.start(input);
  f.interrupt();
  await expect(p.wait()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await expect(p.terminate()).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
  expect(f.calls.some((c) => c.path.endsWith("/SendSignal") || c.path.endsWith("/connect"))).toBe(
    false,
  );
  await f.client.close();
});

test("sustained transport delivers beyond 32MiB without a cumulative native transcript", async () => {
  const f = await fixture({ modern: true, early: true });
  const p = await f.box.processes.start({ ...input, output: { mode: "stream" } });
  let received = 0;
  const out = p.output()[Symbol.asyncIterator]();
  expect((await out.next()).value).toEqual({ stream: "stdout", text: "early" });
  const bytes = new Uint8Array(8192).fill(97);

  for (let i = 0; i < 4097; i++) {
    f.data(i % 2 ? "stdout" : "stderr", bytes);
    const chunk = await out.next();
    expect(chunk.done).toBe(false);
    received += chunk.value!.text.length;
  }

  expect(received).toBeGreaterThan(32 * 1024 * 1024);
  f.end(0);
  expect((await out.next()).done).toBe(true);
  expect(await p.wait()).toEqual({ exitCode: 0, outputComplete: true });
  await f.client.close();
}, 30_000);

test("sustained exact byte input, EOF, live status and final output after exit", async () => {
  const f = await fixture({ modern: true });
  const p = await f.box.processes.start({ ...input, stdin: "pipe", output: { mode: "stream" } });
  await p.write(new Uint8Array([0, 255, 128, 10]));
  await p.write("hello");
  await p.closeStdin();
  await p.closeStdin();
  expect(f.calls.filter((c) => c.path.endsWith("/SendInput")).map((c) => c.body)).toEqual([
    { process: { pid: 9 }, input: { stdin: "AP+ACg==" } },
    { process: { pid: 9 }, input: { stdin: "aGVsbG8=" } },
  ]);
  expect(f.calls.filter((c) => c.path.endsWith("/CloseStdin"))).toHaveLength(1);
  expect(await p.status()).toMatchObject({ state: "running" });
  const out = p.output()[Symbol.asyncIterator]();
  f.exit(3);
  expect(await p.wait()).toEqual({ exitCode: 3, outputComplete: false });
  f.data("stderr", new TextEncoder().encode("last"));
  expect((await out.next()).value).toEqual({ stream: "stderr", text: "last" });
  f.finish();
  expect((await out.next()).done).toBe(true);
  expect(await p.status()).toMatchObject({ state: "exited", exit: { exitCode: 3 } });
  await expect(p.write("late")).rejects.toBeDefined();
  await f.client.close();
});

test("sustained overflow retains independent exit observation and control", async () => {
  const f = await fixture({ modern: true });
  const p = await f.box.processes.start({ ...input, output: { mode: "stream" } });
  f.data("stdout", new Uint8Array(70_000).fill(97));
  await expect(p.output()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    code: "OUTPUT_CAPACITY",
  });
  expect(f.canceled).toBe(0);
  expect(await p.status()).toMatchObject({ state: "running" });
  expect(await p.terminate()).toEqual({ status: "requested" });
  f.end(9);
  expect(await p.wait()).toEqual({ exitCode: 9, outputComplete: false });
  await f.client.close();
});

test("pipe rejects old envd before process dispatch", async () => {
  const f = await fixture();
  await expect(f.box.processes.start({ ...input, stdin: "pipe" })).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(f.calls.some((call) => call.path.endsWith("/Start"))).toBe(false);
  await f.client.close();
});

test("sustained rejects oversized envelope before payload allocation", async () => {
  const f = await fixture({ modern: true });
  const p = await f.box.processes.start({ ...input, output: { mode: "stream" } });
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(1, 1_048_577);
  f.raw(header);
  await expect(p.wait()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await expect(p.output()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });
  await f.client.close();
});

test("sustained split headers and incremental Unicode remain separated by stream", async () => {
  const f = await fixture({ modern: true });
  const p = await f.box.processes.start({ ...input, output: { mode: "stream" } });
  const out = p.output()[Symbol.asyncIterator]();

  const split = frame({
    event: { data: { stdout: Buffer.from([0xf0, 0x9f]).toString("base64") } },
  });

  for (const byte of split) f.raw(new Uint8Array([byte]));
  f.data("stderr", new TextEncoder().encode("err"));
  expect((await out.next()).value).toEqual({ stream: "stderr", text: "err" });
  f.data("stdout", new Uint8Array([0x98, 0x80, 0xff]));
  expect((await out.next()).value).toEqual({ stream: "stdout", text: "😀�" });
  f.end(0);
  expect((await out.next()).done).toBe(true);
  expect(await p.wait()).toEqual({ exitCode: 0, outputComplete: true });
  await f.client.close();
});

test("sustained exit survives a native stream that never closes", async () => {
  const f = await fixture({ modern: true });
  const p = await f.box.processes.start({ ...input, output: { mode: "stream" } });
  const next = p.output()[Symbol.asyncIterator]().next();
  f.exit(4);
  expect(await p.wait()).toEqual({ exitCode: 4, outputComplete: false });
  await expect(next).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await p.wait()).toEqual({ exitCode: 4, outputComplete: false });
  expect(f.canceled).toBeGreaterThan(0);
  await f.client.close();
});

test.each(["lost", "close", "detach"])(
  "sustained %s disposes transport without a remote signal",
  async (mode) => {
    const f = await fixture({ modern: true });
    const p = await f.box.processes.start({ ...input, output: { mode: "stream" } });
    const waiting = p.wait().catch((error) => error);

    if (mode === "lost") f.lost();

    if (mode === "close") await f.client.close();

    if (mode === "detach") await p.detach();
    expect(await waiting).toHaveProperty("code");
    expect(f.calls.some((call) => call.path.endsWith("/SendSignal"))).toBe(false);
    await f.client.close();
  },
);

test("exec callback captures original bytes on a single command dispatch", async () => {
  const f = await fixture({ modern: true });
  const chunks: { stream: string; text: string }[] = [];

  const pending = f.box.exec(
    { ...input, maxOutputBytes: 4 },
    {
      onOutput: (chunk) => {
        chunks.push(chunk);
      },
    },
  );

  while (!f.calls.some((call) => call.path.endsWith("/Start"))) await Bun.sleep(0);
  f.data("stdout", new Uint8Array([0, 255, 65]));
  f.data("stderr", new Uint8Array([128, 66]));
  f.end(0);
  const result = await pending;
  expect(result.stdout).toEqual(new Uint8Array([0, 255, 65]));
  expect(result.stderr).toEqual(new Uint8Array([128]));
  expect(result.truncated).toBe(true);
  expect(chunks).toEqual([
    { stream: "stdout", text: "\u0000�A" },
    { stream: "stderr", text: "�B" },
  ]);
  expect(f.calls.filter((call) => call.path.endsWith("/Start"))).toHaveLength(1);
  await f.client.close();
});
