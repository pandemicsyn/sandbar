import { expect, test } from "bun:test";
import { Sandbar, Image } from "sandbar-sdk";
import { defineAdapter } from "sandbar-adapter";
import { z } from "zod";
import { finiteStdinEcho } from "./finite-stdin";

test("finite stdin recipe forwards UTF-8 and exact bytes through public exec", async () => {
  const received: (Uint8Array | undefined)[] = [];

  const adapter = defineAdapter({
    name: "docs.finite-stdin",
    config: z.object({}),
    credentials: z.object({}),
    async connect() {
      return {
        scope: { authority: { kind: "fixture", id: "one" }, partition: {} },
        supports: {
          images: ["prepared"],
          network: ["blocked"],
          exec: { commands: ["argv"], maxOutputBytes: 1_048_576 },
        },
        create: async () => ({ id: "one", state: "running" as const }),
        destroy: async () => ({ computeStopped: true, retainedResources: [] }),
        exec: {
          finiteStdin: "bytes" as const,
          async submit(input) {
            received.push(input.stdin?.slice());

            return {
              exitCode: 0,
              stdout: input.stdin?.slice() ?? new Uint8Array(),
              stderr: new Uint8Array(),
              truncated: false,
            };
          },
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("base") });
    const text = "λ\0💜";
    const textResult = await finiteStdinEcho(box, text);
    expect(textResult.stdout).toEqual(new TextEncoder().encode(text));

    const binary = Uint8Array.of(0, 255, 129);
    const binaryResult = await finiteStdinEcho(box, binary);
    expect(binaryResult.stdout).toEqual(binary);

    await box.exec({ command: { kind: "argv", argv: ["cat"] }, stdin: new Uint8Array() });
    await box.exec({ command: { kind: "argv", argv: ["cat"] } });
    expect(received).toEqual([new TextEncoder().encode(text), binary, new Uint8Array(), undefined]);

    await box.destroy();
  } finally {
    await client.close();
  }
});
