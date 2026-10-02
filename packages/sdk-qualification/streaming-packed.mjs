import assert from "node:assert/strict";
import { Sandbar, Image, diagnosticContext } from "sandbar-sdk";
import { defineAdapter } from "sandbar-adapter";
import { z } from "zod";
import { previewResponse } from "./sandbox-preview.js";
import { textStreaming, terminateJob } from "./text-streaming.js";

let starts = 0;

let detaches = 0;

let terminations = 0;

const adapter = defineAdapter({
  name: "packed.streaming",
  config: z.object({}),
  credentials: z.object({}),
  async connect() {
    return {
      scope: { authority: { kind: "fixture", id: "one" }, partition: {} },
      supports: { images: ["prepared"], network: ["blocked"] },
      create: async () => ({ id: "one", state: "running" }),
      destroy: async () => ({ computeStopped: true, retainedResources: [] }),
      preview: async () => ({
        access: "protected",
        url: "https://preview.example.test",
        headers: { "x-fixture-token": "private" },
      }),
      processes: {
        async start(input, ctx) {
          starts++;
          assert.equal(input.maxOutputBytes, 4096);
          // Output arrives before the start promise resolves.
          ctx.onOutput({ stream: "stdout", text: "hello" });
          ctx.onOutput({ stream: "stderr", text: "err" });

          let finish;

          const exit =
            starts === 1
              ? Promise.resolve({ exitCode: 7 })
              : new Promise((resolve) => {
                  finish = resolve;
                });

          return {
            wait: () => exit,
            terminate: async () => {
              terminations++;
              finish({ exitCode: -1 });

              return { status: "requested" };
            },
            detach: async () => {
              detaches++;
            },
          };
        },
      },
    };
  },
});

const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

try {
  const box = await client.sandboxes.create({ environment: Image.prepared("one") });
  assert.deepEqual(await textStreaming(box), { exitCode: 7, outputComplete: true });

  assert.deepEqual(await terminateJob(box), { exitCode: -1, outputComplete: true });
  assert.equal(terminations, 1);

  const response = await previewResponse(box, 3000, async (url, init) => {
    assert.equal(url, "https://preview.example.test");
    assert.deepEqual(init.headers, { "x-fixture-token": "private" });
    assert.equal(init.redirect, "error");

    return new Response("ready");
  });

  assert.equal(await response.text(), "ready");
  assert.equal(starts, 2);
  assert.equal(detaches, 2);
  assert.equal(
    diagnosticContext(new Error("private command/output/token")).recoveryAvailable,
    false,
  );
  await box.destroy();
} finally {
  await client.close();
}

console.log("finite streaming public consumer passed");
