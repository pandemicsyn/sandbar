import assert from "node:assert/strict";
import { Sandbar, Image, createProcessTail, readProcessLines } from "sandbar-sdk";
import { defineAdapter } from "sandbar-adapter";
import { z } from "zod";

// Independent adapter demonstrates only portable hooks, with no provider imports.
const jobs = new Map();

let starts = 0;

let signals = 0;

let resizes = 0;

const adapter = defineAdapter({
  name: "packed.extensions",
  config: z.object({}),
  credentials: z.object({}),
  async connect() {
    const attach = (job, ctx) => {
      job.ctx = ctx;
      job.parked = false;
      let end;

      const outputDone = new Promise((resolve) => {
        end = resolve;
      });

      job.end = end;

      return {
        reference: { selector: job.id },
        get confirmedExit() {
          return job.exit;
        },
        outputDone,
        wait: () => job.done,
        write: async (bytes) => ctx.onOutputBytes({ stream: "stdout", bytes }),
        closeStdin: async () => {
          job.exit = { exitCode: 0 };
          job.finish(job.exit);
          end();
        },
        status: async () => ({
          state: job.exit ? "exited" : "running",
          exit: job.exit,
          observedAt: new Date().toISOString(),
        }),
        signal: async (signal) => {
          signals++;
          assert.equal(signal, "SIGTERM");
          job.exit = { exitCode: 23 };
          job.finish(job.exit);
          end();

          return { status: "requested" };
        },
        resize: async (dimensions) => {
          assert.deepEqual(dimensions, { columns: 120, rows: 40 });
          resizes++;
        },
        disconnect: async () => {
          job.parked = true;
          end();
        },
        detachOutput: async () => end(),
        detach: async () => end(),
      };
    };

    return {
      scope: { authority: { kind: "fixture", id: "extensions" }, partition: {} },
      supports: { images: ["prepared"], network: ["blocked"] },
      create: async () => ({ id: "box", state: "running" }),
      destroy: async () => ({ computeStopped: true, retainedResources: [] }),
      processes: {
        supports: {
          sustainedOutput: true,
          binaryOutput: true,
          stdin: "bytes",
          status: true,
          signals: ["SIGTERM", "SIGKILL"],
          terminal: true,
          reopen: true,
        },
        async start(input, ctx) {
          starts++;
          let finish;

          const done = new Promise((resolve) => {
            finish = resolve;
          });

          const job = { id: String(starts), done, finish };
          jobs.set(job.id, job);

          if (input.terminal) assert.deepEqual(input.terminal, { columns: 80, rows: 24 });

          return attach(job, ctx);
        },
        async reopen(input, ctx) {
          const job = jobs.get(input.reference.selector);
          assert.equal(job.parked, true);

          return attach(job, ctx);
        },
      },
    };
  },
});

const connect = () => Sandbar.connect({ adapter, config: {}, credentials: {} });

const first = await connect();

const box = await first.sandboxes.create({ environment: Image.prepared("base") });

const pipe = await box.processes.start({
  command: { kind: "argv", argv: ["worker"] },
  stdin: "pipe",
  output: { mode: "stream", format: "bytes" },
});

const saved = JSON.parse(JSON.stringify(pipe.reference()));

await pipe.disconnect();

await assert.rejects(pipe.write("stale"));

await first.close();

const second = await connect();

try {
  // Same scoped sandbox, fresh connection. No Start is performed during reopen.
  const reopenedBox = new (await import("sandbar-sdk")).AdapterSandbox(second, "box");
  const child = await reopenedBox.processes.reopen(saved);
  assert.equal(child.outputGap, true);
  const lines = [];
  const tail = createProcessTail({ maxBytes: 16, maxLines: 2 });

  const drain = (async () => {
    for await (const line of readProcessLines(child.output(), { maxLineBytes: 8 }))
      lines.push(line);
  })();

  await child.write(Uint8Array.of(0xe2));
  await child.write(Uint8Array.of(0x82, 0xac, 10));
  await child.closeStdin();
  await drain;
  assert.deepEqual(lines, [{ stream: "stdout", text: "€", partial: false, truncated: false }]);
  tail.push({ stream: "stdout", text: "a\nb\nc\n" });
  assert.deepEqual(
    tail.snapshot().lines.map((line) => line.text),
    ["b", "c"],
  );
  assert.equal(tail.snapshot().truncated, true);
  assert.deepEqual(await child.wait(), { exitCode: 0, outputComplete: false });
  await child.detach();

  const tty = await reopenedBox.terminals.start({
    command: { kind: "argv", argv: ["terminal"] },
    columns: 80,
    rows: 24,
  });

  assert.equal("closeStdin" in tty, false);
  const iterator = tty.output()[Symbol.asyncIterator]();
  await tty.write(Uint8Array.of(0, 255));
  assert.deepEqual((await iterator.next()).value, Uint8Array.of(0, 255));
  await tty.resize({ columns: 120, rows: 40 });
  assert.deepEqual(await tty.signal("SIGTERM"), { status: "requested" });
  await iterator.next();
  assert.equal((await tty.wait()).exitCode, 23);
  await tty.detach();
  assert.equal(starts, 2);
  assert.equal(signals, 1);
  assert.equal(resizes, 1);
  await reopenedBox.destroy();
} finally {
  await second.close();
}

console.log("scoped reconnect, explicit terminal, signals and bounded diagnostics passed");
