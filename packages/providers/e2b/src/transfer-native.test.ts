import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createSdkTransport } from "./transport";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type ProcessFrame = {
  event?: { start?: { pid: number }; data?: { stdout: string }; end?: { exitCode: number } };
};

function frame(value: ProcessFrame, flags = 0) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const result = new Uint8Array(bytes.length + 5);
  result[0] = flags;
  new DataView(result.buffer).setUint32(1, bytes.length);
  result.set(bytes, 5);

  return result;
}

function fixture(version = "0.5.7", shortUpload = false) {
  let uploaded = 0;
  let pulled = 0;
  let canceled = 0;
  let commands = 0;
  const hash = createHash("sha256");

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (url.origin === "https://api.e2b.app")
        return Response.json({
          sandboxID: "box",
          templateID: "base",
          state: "running",
          metadata: {},
          envdVersion: version,
          envdAccessToken: "token",
          domain: "e2b.app",
          lifecycle: { autoResume: false },
        });
      expect(request.headers.get("X-Access-Token")).toBe("token");

      if (url.pathname.endsWith("/Start")) {
        commands++;

        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(frame({ event: { start: { pid: commands } } }));
              controller.enqueue(
                frame({ event: { data: { stdout: btoa('{"ok":true,"value":{}}') } } }),
              );
              controller.enqueue(frame({ event: { end: { exitCode: 0 } } }));
              controller.enqueue(frame({}, 2));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "application/connect+json" } },
        );
      }

      if (url.pathname.endsWith("/Stat")) {
        const body = z.object({ path: z.string() }).parse(await request.json());

        return Response.json({
          entry: {
            name: "stage",
            path: body.path,
            type: "FILE_TYPE_FILE",
            size: String(shortUpload ? uploaded - 1 : uploaded),
          },
        });
      }

      if (url.pathname === "/files" && request.method === "POST") {
        expect(request.headers.get("Content-Type")).toBe("application/octet-stream");
        const reader = request.body!.getReader();

        for (;;) {
          const part = await reader.read();

          if (part.done) break;
          expect(part.value.byteLength).toBeLessThanOrEqual(65536);
          uploaded += part.value.byteLength;
          hash.update(part.value);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        return Response.json([{ name: "stage", path: url.searchParams.get("path"), type: "file" }]);
      }

      if (url.pathname === "/files") {
        let delivered = 0;

        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (delivered === 512) controller.close();
                else {
                  delivered++;
                  pulled++;
                  controller.enqueue(new Uint8Array(65536).fill(delivered % 256));
                }
              },
              cancel() {
                canceled++;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "Content-Length": String(32 * 1024 * 1024) } },
        );
      }

      throw new Error(`Unexpected native request ${url.pathname}`);
    },
    { preconnect() {} },
  );

  globalThis.fetch = fetcher;

  return {
    transport: createSdkTransport("key", fetcher),
    uploaded: () => uploaded,
    pulled: () => pulled,
    canceled: () => canceled,
    commands: () => commands,
    digest: () => hash.digest("hex"),
  };
}

test("E2B native streams transfer 32 MiB with incremental octet-stream upload and cancellation", async () => {
  const f = fixture();
  const expected = createHash("sha256");
  let produced = 0;

  async function* input() {
    for (let index = 1; index <= 512; index++) {
      const chunk = new Uint8Array(65536).fill(index % 256);
      expected.update(chunk);
      produced++;
      expect(produced * 65536 - f.uploaded()).toBeLessThanOrEqual(131072);
      yield chunk;
    }
  }

  expect(
    await f.transport.writeStream!(
      "box",
      "/home/user/out",
      input(),
      false,
      new AbortController().signal,
    ),
  ).toEqual({ bytesWritten: 32 * 1024 * 1024 });
  const expectedDigest = expected.digest("hex");
  expect(f.digest()).toBe(expectedDigest);
  expect(f.commands()).toBe(2);

  const stream = await f.transport.readStream!(
    "box",
    "/home/user/out",
    new AbortController().signal,
  );

  const reader = stream.getReader();
  const readHash = createHash("sha256");
  let total = 0;

  for (;;) {
    const part = await reader.read();

    if (part.done) break;
    total += part.value.length;
    readHash.update(part.value);
  }

  expect(total).toBe(32 * 1024 * 1024);
  expect(readHash.digest("hex")).toBe(expectedDigest);

  const second = await f.transport.readStream!(
    "box",
    "/home/user/out",
    new AbortController().signal,
  );

  await second.cancel();
  expect(f.canceled()).toBeGreaterThan(0);
});

test("E2B rejects old envd before staging or consuming a stream", async () => {
  const f = fixture("0.5.6");
  let pulled = false;

  async function* input() {
    pulled = true;
    yield new Uint8Array(1);
  }

  await expect(
    f.transport.writeStream!("box", "/home/user/out", input(), false, new AbortController().signal),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(pulled).toBe(false);
  expect(f.commands()).toBe(0);
});

test("E2B short acknowledged upload never publishes the staging artifact", async () => {
  const f = fixture("0.5.7", true);

  async function* input() {
    yield new Uint8Array(65536);
  }

  await expect(
    f.transport.writeStream!("box", "/home/user/out", input(), false, new AbortController().signal),
  ).rejects.toMatchObject({
    code: "UNAVAILABLE",
    details: {
      effect: "none",
      destination: "/home/user/out",
      bytesTransferred: 65536,
      temporaryPaths: [],
    },
  });
  // The only helper calls reserve and clean the correlated stage; no publish occurs.
  expect(f.commands()).toBe(2);
});
