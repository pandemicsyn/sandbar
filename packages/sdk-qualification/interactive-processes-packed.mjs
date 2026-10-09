import assert from "node:assert/strict";
import { Sandbar, Image } from "sandbar-sdk";
import { defineAdapter } from "sandbar-adapter";
import { z } from "zod";
import { buildWithProgress, interactiveWorker, serverWorkspace } from "./interactive-processes.js";

// Independent adapter: a pull-driven producer and explicit input receipts, with no provider SDK.
let destroyed = 0;

let closed = 0;

let detached = 0;

const received = [];

const adapter = defineAdapter({
  name: "packed.interactive",
  config: z.object({}),
  credentials: z.object({}),
  async connect({ host }) {
    host.onClose(() => {
      closed++;
    });

    return {
      scope: { authority: { kind: "fixture", id: "interactive" }, partition: {} },
      supports: { images: ["prepared"], network: ["blocked"] },
      create: async () => ({ id: "interactive", state: "running" }),
      destroy: async () => {
        destroyed++;

        return { computeStopped: true, retainedResources: [] };
      },
      preview: async () => ({
        access: "protected",
        url: "https://preview.example.test",
        headers: { "x-access": "private" },
      }),
      processes: {
        supports: { sustainedOutput: true, stdin: "bytes", status: true },
        async start(input, ctx) {
          assert.deepEqual(input.output, { mode: "stream" });
          let finish, end;
          let exit;
          let stopped = false;

          const done = new Promise((resolve) => {
            finish = resolve;
          });

          const outputDone = new Promise((resolve) => {
            end = resolve;
          });

          const complete = () => {
            exit = { exitCode: 0 };
            finish(exit);
            end();
          };

          if (input.command.argv[0] === "build") {
            // A bounded producer yields between frames, allowing the single consumer to drain.
            void (async () => {
              const text = "x".repeat(16_384);

              for (let i = 0; i < 2049 && !stopped; i++) {
                ctx.onOutput({ stream: "stdout", text });
                await new Promise((resolve) => setTimeout(resolve, 0));
              }

              ctx.onOutput({ stream: "stderr", text: "done" });
              complete();
            })();
          }

          return {
            get confirmedExit() {
              return exit;
            },
            outputDone,
            wait: () => done,
            detachOutput: async () => {
              stopped = true;
              end();
            },
            write: async (bytes) => {
              received.push(bytes.slice());
              ctx.onOutput({ stream: "stdout", text: "accepted" });
            },
            closeStdin: async () => complete(),
            status: async () =>
              exit
                ? { state: "exited", exit, observedAt: new Date().toISOString() }
                : { state: "running", observedAt: new Date().toISOString() },
            terminate: async () => {
              complete();

              return { status: "requested" };
            },
            detach: async () => {
              stopped = true;
              detached++;
              end();
            },
          };
        },
      },
    };
  },
});

const connect = () => Sandbar.connect({ adapter, config: {}, credentials: {} });

const client = await connect();

try {
  const box = await client.sandboxes.create({ environment: Image.prepared("base") });

  let bytes = 0,
    stderr = "";

  const build = await buildWithProgress(box, ["build"], (chunk) => {
    if (chunk.stream === "stdout") bytes += chunk.text.length;
    else stderr += chunk.text;
  });

  assert.ok(bytes > 32 * 1024 * 1024);
  assert.equal(stderr, "done");
  assert.deepEqual(build, { exitCode: 0, outputComplete: true });

  async function* requests() {
    yield "λ\0";
    yield Uint8Array.of(0, 255, 128);
  }

  const worker = await interactiveWorker(box, ["worker"], requests(), () => {});
  assert.deepEqual(worker, { exitCode: 0, outputComplete: true });
  assert.deepEqual(received, [new TextEncoder().encode("λ\0"), Uint8Array.of(0, 255, 128)]);
  await box.destroy();
} finally {
  await client.close();
}

let used = false;

await serverWorkspace(
  await connect(),
  "base",
  ["server"],
  3000,
  () => {},
  async (url, headers) => {
    assert.equal(url, "https://preview.example.test");
    assert.deepEqual(headers, { "x-access": "private" });
    used = true;
  },
  async (_url, init) => {
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, { "x-access": "private" });

    return new Response("ready");
  },
);

assert.equal(used, true);

assert.equal(destroyed, 2);

assert.equal(closed, 2);

assert.equal(detached, 3);

console.log("sustained build, interactive worker and owned server workflows passed");
