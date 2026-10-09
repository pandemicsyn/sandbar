import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { processSupervisor, processRpc, pythonCommand } from "./process-helper";
import { startDaytonaProcess, type ProcessExecute } from "./process-native";
import type { NativeProcess, ProcessOutput } from "sandbar-adapter";
import { Sandbar, AdapterSandbox } from "sandbar-sdk";
import { createDaytonaAdapter } from "./adapter";

function fixture() {
  let largestResponse = 0;
  let root = "";

  const execute: ProcessExecute = async (command, ctx) => {
    const encoded = /'([A-Za-z0-9+/=]+)'(?: |$)/.exec(command)?.[1];

    if (encoded) root ||= JSON.parse(Buffer.from(encoded, "base64").toString()).root;

    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      signal: ctx.signal,
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    largestResponse = Math.max(largestResponse, Buffer.byteLength(stdout));

    if (code !== 0) throw new Error(stderr);

    return stdout;
  };

  return {
    execute,
    get root() {
      return root;
    },
    get largestResponse() {
      return largestResponse;
    },
  };
}

const read = () => ({ signal: new AbortController().signal, deadline: Date.now() + 30_000 });

const sandbox = { id: "fixture" };

async function cleanup(process: NativeProcess | undefined, root: string) {
  if (process) {
    if (!process.confirmedExit) await process.terminate!(read()).catch(() => undefined);
    await process.wait().catch(() => undefined);
    await process.detach();
  }

  for (let i = 0; i < 100 && existsSync(root); i++) await Bun.sleep(10);
  expect(existsSync(root)).toBe(false);
}

test("Daytona supervisor streams 32 MiB with bounded frames, split UTF-8 and separate stderr", async () => {
  const native = fixture();
  let child: NativeProcess | undefined;
  let size = 0;
  let stderr = "";

  try {
    child = await startDaytonaProcess(
      native.execute,
      {
        sandbox,
        maxOutputBytes: 1_048_576,
        output: { mode: "stream" },
        command: {
          kind: "argv",
          argv: [
            "python3",
            "-c",
            "import os; [os.write(1,b'x'*16384) for _ in range(2048)]; [os.write(2,bytes([b])) for b in '雪'.encode()]",
          ],
        },
      },
      {
        ...read(),
        onOutput(chunk) {
          if (chunk.stream === "stdout") size += chunk.text.length;
          else stderr += chunk.text;
        },
      },
    );
    const [exit] = await Promise.all([child.wait(), child.outputDone]);
    expect(exit.exitCode).toBe(0);
    expect(size).toBe(32 * 1024 * 1024);
    expect(stderr).toBe("雪");
    expect(native.largestResponse).toBeLessThan(100_000);
  } finally {
    await cleanup(child, native.root);
  }
}, 60_000);

test("Daytona supervisor delivers exact input bytes, EOF, current status and confirmed nonzero exit", async () => {
  const native = fixture();
  let child: NativeProcess | undefined;
  const chunks: ProcessOutput[] = [];

  try {
    child = await startDaytonaProcess(
      native.execute,
      {
        sandbox,
        stdin: "pipe",
        output: { mode: "stream" },
        maxOutputBytes: 0,
        command: {
          kind: "argv",
          argv: [
            "python3",
            "-c",
            "import sys; data=sys.stdin.buffer.read(); print(data.hex(),flush=True); sys.exit(7)",
          ],
        },
      },
      {
        ...read(),
        onOutput(chunk) {
          chunks.push(chunk);
        },
      },
    );
    expect((await child.status!(read())).state).toBe("running");
    await child.write!(new Uint8Array([0, 255, 128, 1]), read());
    await child.write!(new TextEncoder().encode("雪"), read());
    await child.closeStdin!(read());
    const [exit] = await Promise.all([child.wait(), child.outputDone]);
    expect(exit.exitCode).toBe(7);
    expect(chunks.map((c) => c.text).join("")).toBe("00ff8001e99baa\n");
    expect((await child.status!(read())).exit?.exitCode).toBe(7);
  } finally {
    await cleanup(child, native.root);
  }
});

test("Daytona output observation failure preserves termination and independent exit", async () => {
  const native = fixture();
  let child: NativeProcess | undefined;

  try {
    child = await startDaytonaProcess(
      native.execute,
      {
        sandbox,
        output: { mode: "stream" },
        maxOutputBytes: 0,
        command: {
          kind: "argv",
          argv: ["python3", "-c", "import os,time; os.write(1,b'\\xff'); time.sleep(30)"],
        },
      },
      { ...read(), onOutput() {} },
    );
    await expect(child.outputDone).rejects.toThrow();
    expect((await child.status!(read())).state).toBe("running");
    expect(await child.terminate!(read())).toEqual({ status: "requested" });
    expect((await child.wait()).exitCode).toBe(-9);
  } finally {
    await cleanup(child, native.root);
  }
});

test("Daytona detach closes input without killing a running child and helper removes itself at exit", async () => {
  const native = fixture();
  let child: NativeProcess | undefined;

  try {
    child = await startDaytonaProcess(
      native.execute,
      {
        sandbox,
        stdin: "pipe",
        output: { mode: "stream" },
        maxOutputBytes: 0,
        command: {
          kind: "argv",
          argv: ["python3", "-c", "import sys,time; sys.stdin.buffer.read(); time.sleep(.3)"],
        },
      },
      { ...read(), onOutput() {} },
    );
    await child.detach();
    expect(existsSync(native.root)).toBe(true);
    await child.detach();

    for (let i = 0; i < 150 && existsSync(native.root); i++) await Bun.sleep(10);
    expect(existsSync(native.root)).toBe(false);
  } finally {
    if (existsSync(native.root)) await cleanup(child, native.root);
  }
});

test("Daytona bounded exec capture retains original bytes once, bounded across both streams", async () => {
  const native = fixture();
  let child: NativeProcess | undefined;

  try {
    child = await startDaytonaProcess(
      native.execute,
      {
        sandbox,
        output: { mode: "stream" },
        capture: { maxBytes: 4 },
        maxOutputBytes: 4,
        command: {
          kind: "argv",
          argv: ["python3", "-c", "import os; os.write(1,b'hello'); os.write(2,b'world')"],
        },
      },
      { ...read(), onOutput() {} },
    );
    const capture = await child.capture!;

    expect(capture.exitCode).toBe(0);
    expect(capture.stdout).toBeInstanceOf(Uint8Array);
    expect(capture.stderr).toBeInstanceOf(Uint8Array);

    if (!(capture.stdout instanceof Uint8Array) || !(capture.stderr instanceof Uint8Array))
      throw new Error("Fixture capture must be buffered bytes");

    expect(capture.stdout.byteLength + capture.stderr.byteLength).toBe(4);
    expect(capture.truncated).toBe(true);
  } finally {
    await cleanup(child, native.root);
  }
});

test("Daytona bounds final output drain when a descendant retains a pipe", async () => {
  const native = fixture();
  let child: NativeProcess | undefined;

  try {
    child = await startDaytonaProcess(
      native.execute,
      {
        sandbox,
        output: { mode: "stream" },
        maxOutputBytes: 0,
        command: {
          kind: "argv",
          argv: [
            "python3",
            "-c",
            "import os,time; pid=os.fork(); time.sleep(2) if pid==0 else None; os._exit(0)",
          ],
        },
      },
      { ...read(), onOutput() {} },
    );
    expect((await child.wait()).exitCode).toBe(0);
    await expect(child.outputDone).rejects.toThrow("did not close");
  } finally {
    await cleanup(child, native.root);
  }
}, 10_000);

test("Daytona public adapter maps interactive process HTTP workflow without native application options", async () => {
  const native = fixture();
  let client: Awaited<ReturnType<typeof Sandbar.connect>> | undefined;
  let child: Awaited<ReturnType<AdapterSandbox["processes"]["start"]>> | undefined;

  const transport: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/api-keys/current"))
        return Response.json({ organizationId: "org" });

      if (url.pathname.endsWith("/regions"))
        return Response.json([{ id: "us", name: "us", regionType: "shared" }]);

      if (url.pathname.endsWith("/organizations/org"))
        return Response.json({ id: "org", sandboxLimitedNetworkEgress: false });

      if (url.pathname === "/api/sandbox/fixture")
        return Response.json({
          id: "fixture",
          name: "fixture",
          organizationId: "org",
          target: "us",
          state: "started",
          networkBlockAll: true,
          public: false,
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        });

      if (url.pathname === "/toolbox/fixture/process/execute") {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(body.timeout).toBe(30);

        const result = await native.execute(body.command, {
          ...read(),
          signal: init?.signal ?? read().signal,
        });

        return Response.json({ result, exitCode: 0 });
      }

      throw new Error(`Unexpected process fixture route ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );

  try {
    client = await Sandbar.connect({
      adapter: createDaytonaAdapter(transport),
      config: { target: "us" },
      credentials: { apiKey: "fixture" },
    });
    const box = new AdapterSandbox(client, "fixture");
    child = await box.processes.start({
      command: {
        kind: "argv",
        argv: ["python3", "-c", "import sys; print(sys.stdin.buffer.read().hex())"],
      },
      stdin: "pipe",
      output: { mode: "stream" },
    });

    const output = (async () => {
      let text = "";

      for await (const chunk of child!.output()) text += chunk.text;

      return text;
    })();

    expect((await child.status()).state).toBe("running");
    await child.write(new Uint8Array([0, 255, 128]));
    await child.closeStdin();
    expect(await output).toBe("00ff80\n");
    expect((await child.wait()).exitCode).toBe(0);
  } finally {
    if (child) {
      await child.terminate().catch(() => undefined);
      await child.detach();
    }

    await client?.close();

    for (let i = 0; i < 100 && existsSync(native.root); i++) await Bun.sleep(10);
    expect(existsSync(native.root)).toBe(false);
  }
});

test("Daytona abandoned setup independently detaches its late pipe transport", async () => {
  const native = fixture();
  const controller = new AbortController();
  let launched = false;
  let acknowledgeCleanup!: () => void;

  const cleanupAcknowledged = new Promise<void>((resolve) => {
    acknowledgeCleanup = resolve;
  });

  const execute: ProcessExecute = async (command, ctx) => {
    const result = await native.execute(command, ctx);
    const encoded = /'([A-Za-z0-9+/=]+)'(?: |$)/.exec(command)?.[1];

    if (encoded && JSON.parse(Buffer.from(encoded, "base64").toString()).request?.op === "abandon")
      acknowledgeCleanup();

    if (!launched) {
      for (let i = 0; i < 300 && !existsSync(native.root + "/control"); i++) await Bun.sleep(10);
      expect(existsSync(native.root + "/control")).toBe(true);
      launched = true;
      controller.abort();
    }

    return result;
  };

  await expect(
    startDaytonaProcess(
      execute,
      {
        sandbox,
        command: { kind: "argv", argv: ["python3", "-c", "import sys; sys.stdin.buffer.read()"] },
        stdin: "pipe",
        output: { mode: "stream" },
        maxOutputBytes: 1024,
      },
      { signal: controller.signal, deadline: Date.now() + 30_000, onOutput() {} },
    ),
  ).rejects.toBeDefined();

  // The child exits on EOF from local transport cleanup; no termination or replacement dispatch.
  await cleanupAcknowledged;

  for (let i = 0; i < 300 && (!native.root || existsSync(native.root)); i++) await Bun.sleep(10);
  expect(existsSync(native.root)).toBe(false);
});

test("Daytona rejects malformed initial status without fabricating running", async () => {
  const calls: string[] = [];

  const execute: ProcessExecute = async (command) => {
    calls.push(command);

    return "{}";
  };

  await expect(
    startDaytonaProcess(
      execute,
      {
        sandbox,
        command: { kind: "argv", argv: ["true"] },
        maxOutputBytes: 1024,
      },
      { ...read(), onOutput() {} },
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await Bun.sleep(0);
  expect(calls).toHaveLength(3); // Launch, status, and independent local detach only.
});

test("Daytona cancellation tombstone blocks a bootstrap delayed beyond setup cleanup", async () => {
  const native = fixture();
  const sentinel = `/tmp/sandbar-late-child-${crypto.randomUUID()}`;
  let delayedLaunch = "";
  let acknowledgeCleanup!: () => void;

  const cleanupAcknowledged = new Promise<void>((resolve) => {
    acknowledgeCleanup = resolve;
  });

  const execute: ProcessExecute = async (command, ctx) => {
    if (!delayedLaunch) {
      delayedLaunch = command;
      throw new Error("Lost launch acknowledgement");
    }

    const result = await native.execute(command, ctx);
    acknowledgeCleanup();

    return result;
  };

  try {
    await expect(
      startDaytonaProcess(
        execute,
        {
          sandbox,
          command: {
            kind: "argv",
            argv: ["python3", "-c", `open(${JSON.stringify(sentinel)},'w').close()`],
          },
          maxOutputBytes: 1024,
        },
        { ...read(), onOutput() {} },
      ),
    ).rejects.toThrow("Lost launch acknowledgement");
    await cleanupAcknowledged;
    expect(existsSync(native.root + "/cancel")).toBe(true);
    await native.execute(delayedLaunch, read());
    await Bun.sleep(150);
    expect(existsSync(sentinel)).toBe(false);
  } finally {
    await rm(native.root, { recursive: true, force: true });
    await rm(sentinel, { force: true });
  }
});

test("Daytona cancellation between directory creation and socket bind shuts down the helper", async () => {
  const root = `/tmp/sandbar-bind-race-${crypto.randomUUID()}`;
  const sentinel = `/tmp/sandbar-bind-child-${crypto.randomUUID()}`;

  const gated = processSupervisor.replace(
    "server=socket.socket",
    "while not os.path.isfile(root+'/continue'): time.sleep(0.01)\nserver=socket.socket",
  );

  const child = Bun.spawn(
    [
      "/bin/sh",
      "-c",
      pythonCommand(gated, {
        root,
        argv: ["python3", "-c", `open(${JSON.stringify(sentinel)},'w').close()`],
        pipe: false,
      }),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );

  try {
    for (let i = 0; i < 300 && !existsSync(root); i++) await Bun.sleep(10);
    expect(existsSync(root)).toBe(true);
    const native = fixture();
    expect(
      JSON.parse(
        await native.execute(
          pythonCommand(processRpc, { root, request: { op: "abandon" } }),
          read(),
        ),
      ),
    ).toEqual({ ok: true });
    await writeFile(root + "/continue", "");
    expect(await child.exited).toBe(0);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
    await rm(sentinel, { force: true });
  }
});
