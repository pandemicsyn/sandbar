import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { networkScript, networkSampleSchema } from "../provider-qualification/network-probe";
import type { AdapterSandbox } from "sandbar-sdk";
import { TestResources } from "./fixtures/resources";
import { liveEnabled, setupLive, finishLive } from "./providers";

export async function networkControls(t: TestResources) {
  if (t.imageId !== "base") throw Error("Network controls require the borrowed base template");

  const sample = async (box: AdapterSandbox) => {
    const output = await box.exec(
      {
        command: { kind: "argv", argv: ["python3", "-c", networkScript] },
        deadlineSeconds: 20,
        maxOutputBytes: 4096,
      },
      { signal: t.signal },
    );

    expect(output.truncated).toBe(false);
    expect(output.exitCode).toBe(0);
    expect(output.stderr.length).toBe(0);

    return networkSampleSchema.parse({ ...JSON.parse(output.stdoutText()), phase: "before" })
      .attempts;
  };

  const control = await t.create("network/control", undefined, "internet");
  expect((await sample(control)).every((attempt) => attempt.connected)).toBe(true);
  const blocked = await t.create("network/blocked", undefined, "blocked");
  const denied = await sample(blocked);
  // Observe the after positive control even when a denied connection unexpectedly succeeds.
  expect((await sample(control)).every((attempt) => attempt.connected)).toBe(true);
  expect(denied).toEqual([
    {
      target: "hostname",
      connected: false,
      error: expect.stringMatching(/^(timeout|unreachable|denied)$/),
    },
    {
      target: "ipv4",
      connected: false,
      error: expect.stringMatching(/^(timeout|unreachable|denied)$/),
    },
  ]);
}

const enabled = liveEnabled && process.env.SANDBAR_QUAL_PROVIDER === "e2b";

describe("Sandbar network controls", () => {
  let fixture: Awaited<ReturnType<typeof setupLive>> | undefined;
  beforeAll(async () => {
    if (enabled) {
      fixture = await setupLive(["network-controls"], { compute: 2, snapshots: 0, volumes: 0 });
      await fixture.resources.setup(() => fixture!.resources.open());
    }
  }, 96000);
  afterAll(async () => {
    if (fixture) await finishLive(fixture);
  }, 76000);
  (enabled ? test : test.skip)(
    "network-controls",
    async () => networkControls(fixture!.resources),
    241000,
  );
});
