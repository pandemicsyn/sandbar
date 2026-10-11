import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AdapterSandbox } from "sandbar-sdk";
import { liveEnabled, setupLive, finishLive } from "./providers";

const enabled = liveEnabled && ["daytona", "e2b"].includes(process.env.SANDBAR_QUAL_PROVIDER ?? "");

describe("Sandbar P4 terminal and process reopening", () => {
  let fixture: Awaited<ReturnType<typeof setupLive>> | undefined;
  let box: AdapterSandbox;

  beforeAll(async () => {
    if (!enabled) return;
    fixture = await setupLive(["execution-streaming", "execution-termination"], {
      compute: 1,
      snapshots: 0,
      volumes: 0,
    });
    await fixture.resources.setup(async () => {
      await fixture!.resources.open();
      box = await fixture!.resources.create("extensions/source");
    });
  }, 96_000);

  afterAll(async () => {
    if (fixture) await finishLive(fixture);
  }, 76_000);

  (enabled ? test : test.skip)(
    "execution-streaming",
    async () => {
      const signal = AbortSignal.any([fixture!.resources.signal, AbortSignal.timeout(60_000)]);

      const job = await box.processes.start(
        {
          command: {
            kind: "argv",
            argv: [
              "python3",
              "-u",
              "-c",
              "import sys; print('ready',flush=True); sys.stdout.buffer.write(sys.stdin.buffer.read()); sys.stdout.buffer.flush()",
            ],
          },
          stdin: "pipe",
          output: { mode: "stream", format: "bytes" },
        },
        { signal },
      );

      try {
        const iterator = job.output({ signal })[Symbol.asyncIterator]();
        let ready = "";

        while (!ready.includes("\n")) {
          const early = await iterator.next();

          if (early.done) throw new Error("Pipe ended before readiness");
          ready += new TextDecoder().decode(early.value.bytes);

          if (ready.length > 128) throw new Error("Pipe readiness overflow");
        }

        expect(ready).toBe("ready\n");
        const reference = job.reference();
        await job.disconnect();
        await expect(job.write("stale")).rejects.toBeDefined();
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [fileURLToPath(new URL("./process-reopen-child.ts", import.meta.url))],
            { stdio: ["pipe", "pipe", "ignore"], signal },
          );

          let output = "";
          child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();

            if (output.length > 128) child.kill();
          });
          child.once("error", reject);
          child.once("close", (code) => {
            if (code === 0 && output.trim() === "reopened") resolve();
            else reject(new Error("Fresh-process pipe reopening failed"));
          });
          child.stdin.on("error", reject);
          child.stdin.end(
            JSON.stringify({
              connection: fixture!.profile.connection,
              sandbox: box.reference,
              process: reference,
            }),
          );
        });
      } finally {
        await job.detach();
      }
    },
    91_000,
  );

  (enabled ? test : test.skip)(
    "execution-termination",
    async () => {
      const signal = AbortSignal.any([fixture!.resources.signal, AbortSignal.timeout(60_000)]);

      const terminal = await box.terminals.start(
        {
          command: {
            kind: "argv",
            argv: [
              "python3",
              "-u",
              "-c",
              "import os,signal,sys,time; signal.signal(signal.SIGTERM,lambda *_:sys.exit(23)); s=os.get_terminal_size(0); print('tty:%s:%s:%s'%(os.isatty(0),s.columns,s.lines),flush=True); input(); s=os.get_terminal_size(0); print('size:%s:%s'%(s.columns,s.lines),flush=True); time.sleep(120)",
            ],
          },
          columns: 80,
          rows: 24,
        },
        { signal },
      );

      let text = "";
      let ready!: () => void;
      let resized!: () => void;

      const initial = new Promise<void>((resolve) => {
        ready = resolve;
      });

      const changed = new Promise<void>((resolve) => {
        resized = resolve;
      });

      const drain = (async () => {
        const decoder = new TextDecoder();

        for await (const bytes of terminal.output({ signal })) {
          text += decoder.decode(bytes, { stream: true });

          if (text.length > 4096) throw new Error("Terminal diagnostic output overflow");

          if (text.includes("tty:True:80:24")) ready();

          if (text.includes("size:120:40")) resized();
        }
      })();

      const done = Promise.all([drain, terminal.wait({ signal })]);
      void done.catch(() => undefined);

      try {
        await Promise.race([
          initial,
          done.then(() => {
            throw new Error("Terminal ended before readiness");
          }),
        ]);
        expect((await terminal.status({ signal })).state).toBe("running");
        await terminal.resize({ columns: 120, rows: 40 }, { signal });
        await terminal.write("measure\n", { signal });
        await Promise.race([
          changed,
          done.then(() => {
            throw new Error("Terminal ended before resize observation");
          }),
        ]);
        expect((await terminal.signal("SIGTERM", { signal })).status).toBe("requested");
        const [, exit] = await done;
        expect(exit.exitCode).toBe(23);
        expect((await terminal.status({ signal })).state).toBe("exited");
      } finally {
        await terminal.detach();
      }

      fixture!.resources.at("extensions/owned-cleanup");
      await fixture!.resources.destroy("extensions/source");
    },
    91_000,
  );
});
