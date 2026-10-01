import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AdapterSandbox } from "sandbar-sdk";
import { liveEnabled, setupLive, finishLive } from "./providers";

const enabled = liveEnabled && process.env.SANDBAR_QUAL_PROVIDER === "e2b";

describe("Sandbar finite E2B text streaming", () => {
  let fixture: Awaited<ReturnType<typeof setupLive>> | undefined;
  let box: AdapterSandbox;
  beforeAll(async () => {
    if (!enabled) return;
    fixture = await setupLive(["execution-streaming"], { compute: 1, snapshots: 0, volumes: 0 });
    await fixture.resources.setup(async () => {
      await fixture!.resources.open();
      box = await fixture!.resources.create("streaming/source");
    });
  }, 96000);
  afterAll(async () => {
    if (fixture) await finishLive(fixture);
  }, 76000);
  (enabled ? test : test.skip)(
    "execution-streaming",
    async () => {
      const t = fixture!.resources;

      const process = await box.processes.start(
        {
          // Block exit on a file the test writes only after observing stdout.
          command: {
            kind: "shell",
            script: `printf early; printf err >&2; while [ ! -f /home/user/sandbar-stream-${t.ledger.runId} ]; do sleep 0.1; done; exit 7`,
          },
          maxOutputBytes: 4096,
        },
        { signal: t.signal },
      );

      try {
        let stdout = "";
        let stderr = "";
        let exited = false;
        let released = false;

        const waiting = process.wait({ signal: t.signal }).then((result) => {
          exited = true;

          return result;
        });

        void waiting.catch(() => undefined);

        for await (const chunk of process.output({ signal: t.signal })) {
          if (chunk.stream === "stdout") stdout += chunk.text;
          else stderr += chunk.text;

          if (stdout === "early" && !released) {
            expect(exited).toBe(false);
            released = true;
            await box.writeFile(
              `/home/user/sandbar-stream-${t.ledger.runId}`,
              new Uint8Array([1]),
              { signal: t.signal },
            );
          }
        }

        expect(stdout).toBe("early");
        expect(stderr).toBe("err");
        expect((await waiting).exitCode).toBe(7);
        expect(await process.wait()).toEqual({ exitCode: 7, outputComplete: true });
      } finally {
        await process.detach();
      }

      t.at("streaming/owned-cleanup");
      await t.destroy("streaming/source");
    },
    241000,
  );
});
