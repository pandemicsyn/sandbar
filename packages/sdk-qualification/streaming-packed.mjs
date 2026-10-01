import assert from "node:assert/strict";
import { Sandbar, Image, diagnosticContext } from "sandbar-sdk";
import { defineAdapter } from "sandbar-adapter";
import { z } from "zod";
import { textStreaming } from "./text-streaming.js";

let starts = 0;

let detaches = 0;

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
      processes: {
        async start(input, ctx) {
          starts++;
          assert.equal(input.maxOutputBytes, 4096);
          // Output arrives before the start promise resolves.
          ctx.onOutput({ stream: "stdout", text: "hello" });
          ctx.onOutput({ stream: "stderr", text: "err" });

          return {
            wait: async () => ({ exitCode: 7 }),
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
  assert.equal(starts, 1);
  assert.equal(detaches, 1);
  assert.equal(
    diagnosticContext(new Error("private command/output/token")).recoveryAvailable,
    false,
  );
  await box.destroy();
} finally {
  await client.close();
}

console.log("finite streaming public consumer passed");
