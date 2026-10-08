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
import { daytonaProvider } from "./index";

function run(input: FilesystemInput) {
  const result = spawnSync(
    "python3",
    ["-c", FILESYSTEM_HELPER, Buffer.from(JSON.stringify(input)).toString("base64")],
    { encoding: "utf8" },
  );

  expect(result.status).toBe(0);

  return filesystemResult(result.stdout);
}

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
