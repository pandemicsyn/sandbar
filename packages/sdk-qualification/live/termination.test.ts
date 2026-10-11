import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AdapterSandbox } from "sandbar-sdk";
import { liveEnabled, setupLive, finishLive } from "./providers";

const enabled = liveEnabled && process.env.SANDBAR_QUAL_PROVIDER === "e2b";

describe("Sandbar E2B native process termination", () => {
  let fixture: Awaited<ReturnType<typeof setupLive>> | undefined;
  let box: AdapterSandbox;
  beforeAll(async () => {
    if (!enabled) return;
    fixture = await setupLive(["execution-termination"], { compute: 1, snapshots: 0, volumes: 0 });
    await fixture.resources.setup(async () => {
      await fixture!.resources.open();
      box = await fixture!.resources.create("termination/source");
    });
  }, 36000);
  afterAll(async () => {
    if (fixture) await finishLive(fixture);
  }, 76000);
  (enabled ? test : test.skip)(
    "execution-termination",
    async () => {
      const t = fixture!.resources;
      const observation = AbortSignal.any([t.signal, AbortSignal.timeout(20_000)]);

      const job = await box.processes.start(
        {
          command: { kind: "shell", script: "printf ready; exec sleep 120" },
          maxOutputBytes: 4096,
        },
        { signal: observation },
      );

      let stdout = "";
      const output = job.output({ signal: observation })[Symbol.asyncIterator]();

      try {
        while (stdout !== "ready") {
          const chunk = await output.next();
          expect(chunk.done).toBe(false);

          if (chunk.value?.stream === "stdout") stdout += chunk.value.text;
        }

        const drain = (async () => {
          while (!(await output.next()).done) {
            /* Drain through the same bounded subscription. */
          }
        })().then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        );

        expect(await job.terminate({ signal: observation })).toEqual({ status: "requested" });
        const repeated = await job.terminate({ signal: observation });
        expect(["requested", "exited"]).toContain(repeated.status);
        const exit = await job.wait({ signal: observation });
        expect(Number.isSafeInteger(exit.exitCode)).toBe(true);
        expect(exit.exitCode).not.toBe(0);
        expect((await drain).ok).toBe(true);
        expect(await job.terminate()).toEqual({ status: "exited" });
        expect((await job.wait()).exitCode).toBe(exit.exitCode);
        expect(stdout).toBe("ready");
      } finally {
        await job.detach();
      }

      t.at("termination/owned-cleanup");
      await t.destroy("termination/source");
    },
    31000,
  );
});
