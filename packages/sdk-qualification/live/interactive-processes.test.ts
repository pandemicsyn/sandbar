import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AdapterSandbox } from "sandbar-sdk";
import {
  interactiveWorker,
  buildWithProgress,
} from "../../../apps/docs/examples/interactive-processes";
import { liveEnabled, setupLive, finishLive } from "./providers";

const enabled = liveEnabled && ["daytona", "e2b"].includes(process.env.SANDBAR_QUAL_PROVIDER ?? "");

describe("Sandbar sustained and interactive processes", () => {
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
      box = await fixture!.resources.create("interactive/source");
    });
  }, 96_000);
  afterAll(async () => {
    if (fixture) await finishLive(fixture);
  }, 76_000);
  (enabled ? test : test.skip)(
    "execution-streaming",
    async () => {
      const t = fixture!.resources;
      let bytes = 0;
      let stderr = "";

      const exit = await buildWithProgress(
        box,
        [
          "python3",
          "-u",
          "-c",
          "import os; b=b'x'*16384\nfor i in range(2049): os.write(1,b)\nos.write(2,b'final')",
        ],
        (chunk) => {
          if (chunk.stream === "stdout") bytes += new TextEncoder().encode(chunk.text).length;
          else stderr += chunk.text;
        },
        t.signal,
      );

      expect(bytes).toBe(2049 * 16384);
      expect(stderr).toBe("final");
      expect(exit).toEqual({ exitCode: 0, outputComplete: true });

      async function* requests() {
        yield "λ\0";
        yield Uint8Array.of(255, 128, 10);
      }

      let echoed = "";

      const worker = await interactiveWorker(
        box,
        ["python3", "-u", "-c", "import sys; b=sys.stdin.buffer.read(); print(b.hex())"],
        requests(),
        (chunk) => {
          echoed += chunk.text;
        },
        t.signal,
      );

      expect(echoed.trim()).toBe("cebb00ff800a");
      expect(worker).toEqual({ exitCode: 0, outputComplete: true });
    },
    241_000,
  );
  (enabled ? test : test.skip)(
    "execution-termination",
    async () => {
      const t = fixture!.resources;
      const signal = AbortSignal.any([t.signal, AbortSignal.timeout(30_000)]);

      const job = await box.processes.start(
        {
          command: {
            kind: "argv",
            argv: [
              "python3",
              "-u",
              "-c",
              "import time; print('ready',flush=True); time.sleep(120)",
            ],
          },
          output: { mode: "stream" },
        },
        { signal },
      );

      const iterator = job.output({ signal })[Symbol.asyncIterator]();

      try {
        const early = await iterator.next();
        expect(early.value?.text).toContain("ready");
        expect((await job.status({ signal })).state).toBe("running");

        const drain = (async () => {
          while (!(await iterator.next()).done) {
            /* Drain final output. */
          }
        })();

        const settled = Promise.allSettled([drain, job.wait({ signal })]);
        expect((await job.terminate({ signal })).status).toBe("requested");
        const [output, exit] = await settled;
        expect(output.status).toBe("fulfilled");
        expect(exit.status).toBe("fulfilled");

        if (exit.status === "fulfilled")
          expect(Number.isSafeInteger(exit.value.exitCode)).toBe(true);
        expect((await job.status({ signal })).state).toBe("exited");
      } finally {
        await job.detach();
      }

      t.at("interactive/owned-cleanup");
      await t.destroy("interactive/source");
    },
    241_000,
  );
});
