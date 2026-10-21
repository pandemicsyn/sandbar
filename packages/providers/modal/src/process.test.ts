import { expect, test } from "bun:test";
import { Image, Sandbar } from "sandbar-sdk";
import { createModalAdapter } from "./adapter";
import type { RouterOutput, RouterRun } from "./router-wire";
import type { ModalTransport } from "./transport";

type Chunk = { stream: "stdout" | "stderr"; bytes: Uint8Array };

/** A command-router double: each exec emits scripted chunks, then exits when released. */
function fixture() {
  const records = new Map<string, { id: string; tags: Record<string, string>; running: boolean }>();
  const starts: RouterRun[] = [];
  const stdin: { execId: string; offset: number; bytes: number[] | "eof" }[] = [];

  const execs = new Map<
    string,
    { chunks: Chunk[]; exit: Promise<number>; release(code: number): void }
  >();

  let script: Chunk[] = [];
  let hold = false;
  let killExit = 0;

  const transport: ModalTransport = {
    async lookupApp() {
      return "ap-fixture";
    },
    async imageExists() {
      return true;
    },
    async create(input) {
      records.set(input.name, { id: "sb-1", tags: input.tags, running: true });

      return "sb-1";
    },
    async findByName(_app, _env, name) {
      return records.get(name) ?? null;
    },
    async *list() {
      for (const value of records.values()) yield value;
    },
    async terminate() {
      return true;
    },
    async poll() {
      return "running";
    },
    async readBytes() {
      return new Uint8Array();
    },
    async fileExists() {
      return false;
    },
    async start(input) {
      starts.push(input);
      let release!: (code: number) => void;

      const exit = new Promise<number>((resolve) => {
        release = resolve;
      });

      const kill = input.command[2]?.includes("kill -s");

      execs.set(input.execId, { chunks: kill ? [] : script, exit, release });

      if (kill) release(killExit);
      else if (!hold) release(0);
    },
    async stdin(_id, execId, bytes) {
      stdin.push({ execId, offset: 0, bytes: bytes.length ? [...bytes] : "eof" });
    },
    async stdinWrite(_id, execId, offset, bytes) {
      stdin.push({ execId, offset, bytes: bytes === "eof" ? "eof" : [...bytes] });
    },
    async result(_id, execId, maxBytes, signal, onOutput?: RouterOutput) {
      const exec = execs.get(execId)!;
      const kept: Record<"stdout" | "stderr", number[]> = { stdout: [], stderr: [] };
      let remaining = maxBytes;
      let truncated = false;

      for (const chunk of exec.chunks) {
        onOutput?.(chunk.stream, chunk.bytes);
        const take = Math.min(remaining, chunk.bytes.length);
        kept[chunk.stream].push(...chunk.bytes.subarray(0, take));
        remaining -= take;
        truncated ||= take < chunk.bytes.length;
      }

      const exitCode = await Promise.race([
        exec.exit,
        new Promise<never>((_, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        ),
      ]);

      return {
        exitCode,
        stdout: Uint8Array.from(kept.stdout),
        stderr: Uint8Array.from(kept.stderr),
        truncated,
      };
    },
    async snapshotFilesystem() {
      throw new Error("unused");
    },
    async deleteImage() {
      return "missing";
    },
    close() {},
  };

  const connect = async () => {
    const client = await Sandbar.connect({
      adapter: createModalAdapter(() => transport),
      config: { appName: "existing", environment: "main" },
      credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
    });

    const box = await client.sandboxes.create({
      environment: Image.prepared("im-fixture"),
      networkPolicy: "blocked",
    });

    return { client, box };
  };

  return {
    connect,
    starts,
    stdin,
    execs,
    script(chunks: Chunk[]) {
      script = chunks;
    },
    hold() {
      hold = true;
    },
    killExit(code: number) {
      killExit = code;
    },
  };
}

const bytes = (...values: number[]) => Uint8Array.from(values);

test("byte output streams per stream before exit, through the PID wrapper", async () => {
  const f = fixture();
  const { client, box } = await f.connect();

  try {
    f.script([
      { stream: "stdout", bytes: bytes(0, 255) },
      { stream: "stderr", bytes: bytes(129) },
    ]);
    f.hold();

    const process = await box.processes.start({
      command: { kind: "argv", argv: ["make", "test"] },
      cwd: "/work",
      env: { CI: "1" },
      output: { mode: "stream", format: "bytes" },
    });

    const start = f.starts.at(-1)!;
    expect(start.command.slice(0, 3)).toEqual(["/bin/sh", "-c", 'echo $$ >"$0" && exec "$@"']);
    expect(start.command[3]).toBe(`/tmp/.sandbar-process-${start.execId}.pid`);
    expect(start.command.slice(4)).toEqual(["make", "test"]);
    expect(start).toMatchObject({ cwd: "/work", env: { CI: "1" } });
    expect(start.timeoutSeconds).toBeUndefined();
    // Closed stdin sends EOF at once, so the command never waits for input.
    expect(f.stdin).toEqual([{ execId: start.execId, offset: 0, bytes: "eof" }]);

    const seen: string[] = [];

    for await (const chunk of process.output()) {
      seen.push(`${chunk.stream}:${[...chunk.bytes].join(",")}`);

      if (seen.length === 2) f.execs.get(start.execId)!.release(9);
    }

    expect(seen).toEqual(["stdout:0,255", "stderr:129"]);
    expect(await process.wait()).toEqual({ exitCode: 9, outputComplete: true });
    await process.detach();
  } finally {
    await client.close();
  }
});

test("piped stdin writes at exact offsets, then EOF", async () => {
  const f = fixture();
  const { client, box } = await f.connect();

  try {
    f.script([{ stream: "stdout", bytes: new TextEncoder().encode("ok") }]);
    f.hold();

    const process = await box.processes.start({
      command: { kind: "argv", argv: ["cat"] },
      stdin: "pipe",
      output: { mode: "stream" },
    });

    const { execId } = f.starts.at(-1)!;
    await process.write(bytes(1, 2, 3));
    await process.write(bytes(4));
    await process.closeStdin();
    expect(f.stdin).toEqual([
      { execId, offset: 0, bytes: [1, 2, 3] },
      { execId, offset: 3, bytes: [4] },
      { execId, offset: 4, bytes: "eof" },
    ]);
    f.execs.get(execId)!.release(0);

    let text = "";

    for await (const chunk of process.output()) text += chunk.text;

    expect(text).toBe("ok");
    expect((await process.wait()).exitCode).toBe(0);
    await process.detach();
  } finally {
    await client.close();
  }
});

test("terminate sends SIGKILL to the recorded PID in a second exec", async () => {
  const f = fixture();
  const { client, box } = await f.connect();

  try {
    f.hold();

    const process = await box.processes.start({
      command: { kind: "shell", script: "sleep 600" },
      output: { mode: "stream", format: "bytes" },
    });

    const launched = f.starts.at(-1)!;
    expect(launched.command.slice(4)).toEqual(["/bin/sh", "-c", "sleep 600"]);
    expect((await process.terminate()).status).toBe("requested");

    const kill = f.starts.at(-1)!;
    expect(kill.execId).not.toBe(launched.execId);
    expect(kill.command.slice(3)).toEqual([`/tmp/.sandbar-process-${launched.execId}.pid`, "KILL"]);
    expect(kill.timeoutSeconds).toBe(30);

    f.killExit(4);
    expect((await process.signal("SIGTERM")).status).toBe("not-found");
    expect(f.starts.at(-1)!.command.at(-1)).toBe("TERM");
    await process.detach();
  } finally {
    await client.close();
  }
});

test("callback exec streams text and returns the bounded byte capture", async () => {
  const f = fixture();
  const { client, box } = await f.connect();

  try {
    f.script([
      { stream: "stdout", bytes: new TextEncoder().encode("abc") },
      { stream: "stderr", bytes: new TextEncoder().encode("de") },
    ]);

    const chunks: string[] = [];

    const result = await box.exec(
      { command: { kind: "argv", argv: ["build"] }, maxOutputBytes: 4 },
      { onOutput: (chunk) => void chunks.push(`${chunk.stream}:${chunk.text}`) },
    );

    expect(chunks).toEqual(["stdout:abc", "stderr:de"]);
    expect(new TextDecoder().decode(result.stdout)).toBe("abc");
    expect(new TextDecoder().decode(result.stderr)).toBe("d");
    expect(result).toMatchObject({ exitCode: 0, truncated: true });
  } finally {
    await client.close();
  }
});
