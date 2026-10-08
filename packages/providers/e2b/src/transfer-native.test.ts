import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AdapterSandbox, Sandbar } from "sandbar-sdk";
import { artifactFiles } from "../../../../apps/docs/examples/directory-files";
import { createE2BAdapter } from "./index";
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

function fixture(version = "0.5.7", shortUpload = false, nativeFilesystem = false) {
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
        let stdout = '{"ok":true,"value":{}}';
        let exitCode = 0;

        if (nativeFilesystem) {
          const body = z
            .object({ process: z.object({ cmd: z.string(), args: z.array(z.string()) }) })
            .parse(await request.json());

          const execution = spawnSync(body.process.cmd, body.process.args, { encoding: "utf8" });
          stdout = execution.stdout;
          exitCode = execution.status ?? 1;
        }

        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(frame({ event: { start: { pid: commands } } }));
              controller.enqueue(frame({ event: { data: { stdout: btoa(stdout) } } }));
              controller.enqueue(frame({ event: { end: { exitCode } } }));
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
            size: String(
              nativeFilesystem ? statSync(body.path).size : shortUpload ? uploaded - 1 : uploaded,
            ),
          },
        });
      }

      if (url.pathname === "/files" && request.method === "POST") {
        const path = url.searchParams.get("path")!;

        if (
          nativeFilesystem &&
          request.headers.get("Content-Type")?.startsWith("multipart/form-data")
        ) {
          const file = (await request.formData()).get("file");

          if (!(file instanceof Blob)) throw new Error("Expected native multipart file");
          writeFileSync(path, new Uint8Array(await file.arrayBuffer()));

          return Response.json([{ name: "stage", path, type: "file" }]);
        }

        expect(request.headers.get("Content-Type")).toBe("application/octet-stream");
        const reader = request.body!.getReader();

        for (;;) {
          const part = await reader.read();

          if (part.done) break;
          expect(part.value.byteLength).toBeLessThanOrEqual(65536);
          uploaded += part.value.byteLength;
          hash.update(part.value);

          if (nativeFilesystem) appendFileSync(path, part.value);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        return Response.json([{ name: "stage", path: url.searchParams.get("path"), type: "file" }]);
      }

      if (url.pathname === "/files") {
        if (nativeFilesystem) return new Response(readFileSync(url.searchParams.get("path")!));
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

test.skipIf(process.platform !== "linux")(
  "E2B public SDK runs the shared artifact recipe through native guest transport",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "sandbar-e2b-artifacts-"));
    const f = fixture("0.5.7", false, true);

    const client = await Sandbar.connect({
      adapter: createE2BAdapter(() => f.transport),
      config: { teamId: "team" },
      credentials: { apiKey: "fixture" },
    });

    const chunks: Uint8Array[] = [];
    const payload = new Uint8Array(131072).fill(239);

    try {
      const artifact = await artifactFiles(
        new AdapterSandbox(client, "box"),
        (async function* () {
          yield payload.subarray(0, 65536);
          yield payload.subarray(65536);
        })(),
        {
          async write(chunk) {
            chunks.push(chunk);
          },
        },
        root,
      );

      expect(Buffer.concat(chunks)).toEqual(Buffer.from(payload));
      expect(artifact.uploaded).toBe(payload.byteLength);
      expect(artifact.directory.completeness).toBe("complete");
      expect(artifact.lines).toEqual(["ready ✓", "complete"]);
      expect(artifact.entries.map((entry) => entry.relativePath)).toEqual([
        "archive.bin",
        "final.json",
        "results",
        "results/events.txt",
        "results/report.json",
      ]);
      expect(existsSync(root)).toBe(false);
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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

test.each(["0.5.6", "0.5", "0", "-1.0.0", ".6.0", "1..0", "1.0.0.0"])(
  "E2B rejects envd %s before staging or consuming a stream",
  async (version) => {
    const f = fixture(version);
    let pulled = false;

    async function* input() {
      pulled = true;
      yield new Uint8Array(1);
    }

    await expect(
      f.transport.writeStream!(
        "box",
        "/home/user/out",
        input(),
        false,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(pulled).toBe(false);
    expect(f.commands()).toBe(0);
  },
);

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
