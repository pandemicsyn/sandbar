import { expect, test } from "bun:test";
import { Sandbox } from "e2b";
import { z } from "zod";
import type { Json } from "sandbar-adapter";
import { startProcess, ProcessReference } from "./process-native";

function envelope(value: Json) {
  const body = Buffer.from(JSON.stringify(value));
  const bytes = new Uint8Array(body.length + 5);
  new DataView(bytes.buffer).setUint32(1, body.length);
  bytes.set(body, 5);

  return bytes;
}

function fixture(reply?: Response) {
  const calls: { path: string; body: Json; headers: Headers }[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const bytes: Uint8Array[] = [];

  const context = {
    signal: new AbortController().signal,
    deadline: Date.now() + 30_000,
    onOutput() {},
    onOutputBytes(chunk: { bytes: Uint8Array }) {
      bytes.push(chunk.bytes);
    },
  };

  const fetcher: typeof fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      const path = new URL(request.url).pathname;
      const raw = new Uint8Array(await request.arrayBuffer());

      const body = z
        .json()
        .parse(
          JSON.parse(Buffer.from(/Start|Connect/.test(path) ? raw.subarray(5) : raw).toString()),
        );

      calls.push({ path, body, headers: request.headers });

      if (/Start|Connect/.test(path)) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push(controller);
              controller.enqueue(envelope({ event: { start: { pid: 9 } } }));
            },
          }),
        );
      }

      return reply ?? Response.json({});
    },
    { preconnect() {} },
  );

  const sandbox = new Sandbox({
    apiKey: "fixture",
    sandboxId: "box-one",
    envdVersion: "0.5.2",
    envdAccessToken: "secret",
    sandboxDomain: "e2b.app",
  });

  const credentials = { id: "box-one", token: "secret", version: "0.5.2" };

  return { calls, streams, bytes, context, fetcher, sandbox, credentials };
}

test("terminal starts the requested command, preserves combined bytes and resizes without EOF", async () => {
  const f = fixture();

  const p = await startProcess(
    f.sandbox,
    f.credentials,
    "exec custom --flag",
    {
      terminal: { columns: 120, rows: 40 },
      format: "bytes",
      binding: "a".repeat(64),
    },
    f.context,
    f.fetcher,
  );

  expect(f.calls[0]!.body).toMatchObject({
    process: { cmd: "/bin/bash", args: ["-l", "-c", "exec custom --flag"] },
    pty: { size: { cols: 120, rows: 40 } },
  });
  f.streams[0]!.enqueue(
    envelope({ event: { data: { pty: Buffer.from([0, 255, 128]).toString("base64") } } }),
  );

  while (!f.bytes.length) await Bun.sleep(0);
  expect(f.bytes).toEqual([new Uint8Array([0, 255, 128])]);
  await p.write!(new Uint8Array([4, 0]), f.context);
  await p.resize!({ columns: 90, rows: 25 }, f.context);
  await expect(p.closeStdin!(f.context)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(f.calls[1]!.body).toEqual({
    process: { tag: expect.stringMatching(/^sandbar-/) },
    input: { pty: "BAA=" },
  });
  expect(f.calls[2]!.body).toEqual({
    process: { tag: expect.stringMatching(/^sandbar-/) },
    pty: { size: { cols: 90, rows: 25 } },
  });
  await p.disconnect!();
  const before = f.calls.length;
  await expect(p.resize!({ columns: 80, rows: 24 }, f.context)).rejects.toBeDefined();
  await expect(p.signal!("SIGTERM", f.context)).rejects.toBeDefined();
  await expect(p.write!(new Uint8Array([1]), f.context)).rejects.toBeDefined();
  expect(f.calls).toHaveLength(before);
  expect(f.calls.some((call) => /CloseStdin|SendSignal/.test(call.path))).toBe(false);
});

test("tag reopening attaches directly without PID lookup, start replay, EOF or remote signal", async () => {
  const f = fixture();

  const first = await startProcess(
    f.sandbox,
    f.credentials,
    "worker",
    {
      stdin: "pipe",
      binding: "a".repeat(64),
    },
    f.context,
    f.fetcher,
  );

  const reference = ProcessReference.parse(first.reference);
  await first.disconnect!();

  const second = await startProcess(
    f.sandbox,
    f.credentials,
    "",
    {
      stdin: "pipe",
      reopen: reference,
    },
    f.context,
    f.fetcher,
  );

  expect(f.calls.map((call) => call.path)).toEqual([
    "/process.Process/Start",
    "/process.Process/Connect",
  ]);
  expect(f.calls[1]!.body).toEqual({ process: { tag: reference.tag } });
  await second.signal!("SIGTERM", f.context);
  await second.signal!("SIGKILL", f.context);
  expect(f.calls.slice(2).map((call) => call.body)).toEqual([
    { process: { tag: reference.tag }, signal: "SIGNAL_SIGTERM" },
    { process: { tag: reference.tag }, signal: "SIGNAL_SIGKILL" },
  ]);
  await second.disconnect!();
});

test("stream observation loss fences terminal controls and stdin at native boundary", async () => {
  const f = fixture();

  const p = await startProcess(
    f.sandbox,
    f.credentials,
    "worker",
    {
      terminal: { columns: 80, rows: 24 },
      format: "bytes",
      binding: "a".repeat(64),
    },
    f.context,
    f.fetcher,
  );

  f.streams[0]!.error(new Error("lost"));
  await expect(p.wait()).rejects.toBeDefined();
  await expect(p.write!(new Uint8Array([1]), f.context)).rejects.toBeDefined();
  await expect(p.resize!({ columns: 90, rows: 30 }, f.context)).rejects.toBeDefined();
  await expect(p.signal!("SIGTERM", f.context)).rejects.toBeDefined();
  expect(f.calls).toHaveLength(1);
});

test("native controls reject pre-abort before guest dispatch and validate acknowledgement", async () => {
  const f = fixture();

  const p = await startProcess(
    f.sandbox,
    f.credentials,
    "worker",
    { binding: "a".repeat(64) },
    f.context,
    f.fetcher,
  );

  await expect(
    p.signal!("SIGTERM", { ...f.context, signal: AbortSignal.abort() }),
  ).rejects.toBeDefined();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.headers.get("X-Access-Token")).toBe("secret");
  expect(f.calls[0]!.headers.get("X-API-Key")).toBeNull();
  expect(f.calls[0]!.headers.get("Content-Type")).toBe("application/connect+json");
  await p.disconnect!();
  const malformed = fixture(new Response("not-json"));

  const handle = await startProcess(
    malformed.sandbox,
    malformed.credentials,
    "worker",
    { binding: "a".repeat(64) },
    malformed.context,
    malformed.fetcher,
  );

  await expect(handle.signal!("SIGTERM", malformed.context)).rejects.toBeDefined();
  expect(malformed.calls).toHaveLength(2);
  await handle.disconnect!();
});

test("native terminal dimensions reject before start or resize dispatch", async () => {
  const f = fixture();
  await expect(
    startProcess(
      f.sandbox,
      f.credentials,
      "worker",
      {
        terminal: { columns: 0, rows: 24 },
        format: "bytes",
        binding: "a".repeat(64),
      },
      f.context,
      f.fetcher,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(f.calls).toHaveLength(0);

  const process = await startProcess(
    f.sandbox,
    f.credentials,
    "worker",
    {
      terminal: { columns: 80, rows: 24 },
      format: "bytes",
      binding: "a".repeat(64),
    },
    f.context,
    f.fetcher,
  );

  await expect(process.resize!({ columns: 80, rows: 1001 }, f.context)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.calls).toHaveLength(1);
  await process.disconnect!();
});
