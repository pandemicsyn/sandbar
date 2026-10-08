import { z } from "zod";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILESYSTEM_HELPER, filesystemResult, type FilesystemInput } from "./filesystem";
import { daytonaProvider, createDaytonaAdapter } from "./index";
import { Sandbar, AdapterSandbox } from "sandbar-sdk";
import { artifactFiles } from "../../../../apps/docs/examples/directory-files";

function run(input: FilesystemInput) {
  const result = spawnSync(
    "python3",
    ["-c", FILESYSTEM_HELPER, Buffer.from(JSON.stringify(input)).toString("base64")],
    { encoding: "utf8" },
  );

  expect(result.status).toBe(0);

  return filesystemResult(result.stdout);
}

test("recursive mkdir reports possible effects when a parent is created before the leaf fails", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbar-daytona-mkdir-"));
  const parent = join(root, "created-parent");

  try {
    expect(() =>
      run({ op: "mkdir", path: join(parent, "x".repeat(300)), recursive: true }),
    ).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ effect: "possible" }) }),
    );
    expect(existsSync(parent)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guest filesystem preserves unusual names, dangling links, directory protection and staged copy", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbar-daytona-fs-"));
  const source = join(root, "quote'\n雪.bin");

  try {
    writeFileSync(source, new Uint8Array([0, 255, 1]));
    symlinkSync(join(root, "absent"), join(root, "dangling"));
    mkdirSync(join(root, "empty"));
    expect(spawnSync("mkfifo", [join(root, "pipe")]).status).toBe(0);
    expect(run({ op: "list", path: root })).toEqual([
      { name: "dangling", type: "symlink" },
      { name: "empty", type: "directory" },
      { name: "pipe", type: "unknown" },
      { name: "quote'\n雪.bin", type: "file" },
    ]);
    expect(run({ op: "exists", path: join(root, "dangling") })).toBe(true);
    expect(() => run({ op: "mkdir", path: source, recursive: true })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(() => run({ op: "mkdir", path: source, recursive: false })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    symlinkSync(join(root, "empty"), join(root, "directory-link"));
    expect(run({ op: "mkdir", path: join(root, "directory-link"), recursive: false })).toBe(true);
    writeFileSync(join(root, "empty", "child"), "intermediate-link");
    expect(run({ op: "list", path: join(root, "directory-link") })).toEqual([
      { name: "child", type: "file" },
    ]);
    expect(
      run({ op: "remove", path: join(root, "directory-link", "child"), recursive: false }),
    ).toBe(true);
    expect(existsSync(join(root, "empty", "child"))).toBe(false);
    expect(run({ op: "remove", path: join(root, "directory-link"), recursive: true })).toBe(true);
    expect(existsSync(join(root, "empty"))).toBe(true);

    expect(run({ op: "stat", path: join(root, "dangling") })).toMatchObject({ type: "symlink" });
    expect(() => run({ op: "stat", path: join(root, "dangling"), follow: true })).toThrow();
    expect(() => run({ op: "remove", path: root, recursive: false })).toThrow();
    const reserved = join(root, ".stream-stage");
    expect(run({ op: "reserve", path: reserved })).toBe(reserved);
    expect(existsSync(reserved)).toBe(true);
    expect(() => run({ op: "reserve", path: reserved })).toThrow();
    expect(run({ op: "cleanup", path: reserved })).toBe(true);
    expect(existsSync(reserved)).toBe(false);

    const copy = join(root, "copied");
    expect(
      run({
        op: "copy",
        source,
        destination: copy,
        stagingDirectory: join(root, ".copy-stage"),
        overwrite: true,
      }),
    ).toBe(true);
    expect(readFileSync(copy)).toEqual(readFileSync(source));

    try {
      run({
        op: "copy",
        source,
        destination: copy,
        stagingDirectory: join(root, ".collision-stage"),
        overwrite: false,
      });
      throw new Error("No-clobber unexpectedly replaced destination");
    } catch (error) {
      expect(error).toMatchObject({
        code: process.platform === "linux" ? "CONFLICT" : "UNSUPPORTED",
      });
    }

    expect(existsSync(join(root, ".collision-stage"))).toBe(false);
    expect(new Uint8Array(readFileSync(source))).toEqual(new Uint8Array([0, 255, 1]));
    expect(readFileSync(copy)).toEqual(readFileSync(source));
    const directorySource = join(root, "directory-source");
    const directoryDestination = join(root, "directory-destination");
    mkdirSync(directorySource);

    if (process.platform === "linux") {
      expect(
        run({
          op: "move",
          source: directorySource,
          destination: directoryDestination,
          overwrite: false,
        }),
      ).toBe(true);
      expect(existsSync(directorySource)).toBe(false);
      expect(existsSync(directoryDestination)).toBe(true);
    } else {
      try {
        run({
          op: "move",
          source: directorySource,
          destination: directoryDestination,
          overwrite: false,
        });
        throw new Error("Expected Linux renameat2 prerequisite");
      } catch (error) {
        expect(error).toMatchObject({ code: "UNSUPPORTED" });
      }

      expect(existsSync(directorySource)).toBe(true);
      expect(existsSync(directoryDestination)).toBe(false);
    }

    expect(() =>
      run({
        op: "copy",
        source: join(root, "dangling"),
        destination: copy,
        stagingDirectory: join(root, ".copy-stage"),
        overwrite: true,
      }),
    ).toThrow();
    expect(() => run({ op: "move", source, destination: source, overwrite: true })).toThrow();
    expect(run({ op: "remove", path: join(root, "empty"), recursive: false })).toBe(true);
    expect(run({ op: "remove", path: join(root, "absent"), recursive: false })).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Daytona transfer transport streams 32 MiB with incremental multipart input and matching completion", async () => {
  const size = 32 * 1024 * 1024;
  let uploaded = 0;
  let cleanup = 0;
  let stageDirectory = "";

  const impl: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/api-keys/current"))
        return Response.json({ organizationId: "org" });

      if (url.pathname.endsWith("/regions"))
        return Response.json([{ id: "us", name: "us", regionType: "shared" }]);

      if (url.pathname === "/api/sandbox/box")
        return Response.json({
          id: "box",
          name: "box",
          organizationId: "org",
          target: "us",
          state: "started",
          networkBlockAll: true,
          public: false,
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        });

      if (url.pathname.endsWith("/process/execute")) {
        const command = z
          .object({ command: z.string() })
          .parse(JSON.parse(String(init?.body))).command;

        const argument = command.slice(command.lastIndexOf(" '") + 2, -1);

        const args = z
          .object({ op: z.string(), path: z.string().optional() })
          .parse(JSON.parse(Buffer.from(argument, "base64").toString()));

        if (args.op === "cleanup") cleanup++;

        if (args.op === "reserve") stageDirectory = args.path!;

        return Response.json({
          exitCode: 0,
          result: JSON.stringify({
            ok: true,
            value:
              args.op === "reserve"
                ? stageDirectory
                : args.op === "stat"
                  ? { type: "file", sizeBytes: size, mode: 384, modifiedAt: "2026-10-08T00:00:00Z" }
                  : true,
          }),
        });
      }

      if (url.pathname.endsWith("/files/upload-v2")) {
        expect(init?.body).toBeInstanceOf(ReadableStream);

        if (!(init?.body instanceof ReadableStream))
          throw new Error("Expected streaming multipart");

        const reader = init.body.getReader();
        let index = 0;

        for (;;) {
          const next = await reader.read();

          if (next.done) break;

          if (index++ && next.value.byteLength === 65536) {
            expect(next.value[0]).toBe(239);
            expect(next.value[65535]).toBe(239);
            uploaded += next.value.byteLength;
          }
        }

        return Response.json({ path: `${stageDirectory}/payload`, name: "payload", type: "file" });
      }

      if (url.pathname.endsWith("/files/download")) {
        let count = 0;

        return new Response(
          new ReadableStream({
            pull(controller) {
              if (count === size) controller.close();
              else {
                controller.enqueue(new Uint8Array(65536).fill(239));
                count += 65536;
              }
            },
          }),
          { headers: { "content-length": String(size) } },
        );
      }

      throw new Error(`Unexpected fixture request ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );

  const { driver, scope } = await daytonaProvider({ apiKey: "fixture", target: "us", fetch: impl });
  const sandbox = { kind: "sandbox" as const, nativeId: "box", scope };

  const written = await driver.writeFileStream({
    sandbox,
    path: "/workspace/archive",
    overwrite: false,
    bytes: (async function* () {
      for (let i = 0; i < size / 65536; i++) yield new Uint8Array(65536).fill(239);
    })(),
  });

  expect(written.bytesWritten).toBe(size);
  expect(uploaded).toBe(size);
  expect(cleanup).toBe(1);
  const reader = (await driver.readFileStream({ sandbox, path: "/workspace/archive" })).getReader();
  let downloaded = 0;

  for (;;) {
    const next = await reader.read();

    if (next.done) break;
    downloaded += next.value.byteLength;
    expect(next.value.every((b) => b === 239)).toBe(true);
  }

  expect(downloaded).toBe(size);
});

test("Daytona public SDK preserves definitive filesystem rejections and artifact workflow outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandbar-daytona-public-files-"));
  let client: Awaited<ReturnType<typeof Sandbar.connect>> | undefined;

  try {
    const transport: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));

        if (url.pathname.endsWith("/api-keys/current"))
          return Response.json({ organizationId: "org" });

        if (url.pathname.endsWith("/regions"))
          return Response.json([{ id: "us", name: "us", regionType: "shared" }]);

        if (url.pathname.endsWith("/organizations/org"))
          return Response.json({ id: "org", sandboxLimitedNetworkEgress: false });

        if (url.pathname === "/api/sandbox/box")
          return Response.json({
            id: "box",
            name: "box",
            organizationId: "org",
            target: "us",
            state: "started",
            networkBlockAll: true,
            public: false,
            toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
          });

        if (url.pathname.endsWith("/process/execute")) {
          const request = z.object({ command: z.string() }).parse(JSON.parse(String(init?.body)));
          const execution = spawnSync("sh", ["-c", request.command], { encoding: "utf8" });

          return Response.json({ result: execution.stdout, exitCode: execution.status });
        }

        if (url.pathname.endsWith("/files/upload-v2")) {
          const form = await new Response(init?.body, {
            headers: { "content-type": new Headers(init?.headers).get("content-type")! },
          }).formData();

          const file = form.get("file");

          if (!(file instanceof Blob)) throw new Error("Expected multipart upload file");
          const path = url.searchParams.get("path")!;
          writeFileSync(path, new Uint8Array(await file.arrayBuffer()));

          return Response.json({ path, name: "payload", type: "file" });
        }

        if (url.pathname.endsWith("/files/download"))
          return new Response(readFileSync(url.searchParams.get("path")!));
        throw new Error(`Unexpected public filesystem fixture route ${url.pathname}`);
      },
      { preconnect: fetch.preconnect },
    );

    client = await Sandbar.connect({
      adapter: createDaytonaAdapter(transport),
      config: { target: "us" },
      credentials: { apiKey: "fixture" },
    });

    const box = new AdapterSandbox(client, "box");
    await box.makeDirectory(join(root, "results"), { recursive: true });
    const source = join(root, "results", "source.bin");
    const payload = new Uint8Array(2 * 1024 * 1024).fill(239);
    await box.writeFile(source, payload, { overwrite: true, maxBytes: payload.byteLength });
    await expect(box.makeDirectory(source)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(box.makeDirectory(source, { recursive: true })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(box.removeFile(join(root, "results"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await box.readDirectory(join(root, "results"))).toMatchObject({
      completeness: "complete",
      entries: [{ name: "source.bin", type: "file" }],
    });
    expect(await box.statFile(source)).toMatchObject({
      type: "file",
      sizeBytes: payload.byteLength,
    });
    const copy = join(root, "copy.bin");
    const final = join(root, "final.bin");
    await box.copyFile(source, copy, { overwrite: true });
    await box.moveFile(copy, final, { overwrite: true });
    expect(await box.fileExists(copy)).toBe(false);
    expect(await box.readFile(final, { maxBytes: payload.byteLength })).toEqual(payload);

    if (process.platform === "linux") {
      const chunks: Uint8Array[] = [];
      const artifactRoot = join(root, "artifacts");

      const artifact = await artifactFiles(
        box,
        (async function* () {
          yield payload.subarray(0, 65536);
          yield payload.subarray(65536, 131072);
        })(),
        {
          async write(chunk) {
            chunks.push(chunk);
          },
        },
        artifactRoot,
      );

      expect(Buffer.concat(chunks)).toEqual(Buffer.from(payload.subarray(0, 131072)));
      expect(artifact.uploaded).toBe(131072);
      expect(artifact.directory.completeness).toBe("complete");
      expect(artifact.lines).toEqual(["ready ✓", "complete"]);
      expect(artifact.entries.map((entry) => entry.relativePath)).toEqual([
        "archive.bin",
        "final.json",
        "results",
        "results/events.txt",
        "results/report.json",
      ]);
      expect(existsSync(artifactRoot)).toBe(false);
    }

    await box.removeFile(root, { recursive: true });
    expect(existsSync(root)).toBe(false);
  } finally {
    try {
      await client?.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
