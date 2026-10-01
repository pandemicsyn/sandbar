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

async function fixture(options: { early?: boolean; holdStart?: boolean } = {}) {
  const calls: { method: string; path: string; body?: object; headers: Headers }[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = 0;
  let details = 0;
  let pauseAtAttach = false;
  let earlyCallbacks = 0;
  let startResolved = false;
  let deleted = false;

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
    envdVersion: "0.5.0",
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
