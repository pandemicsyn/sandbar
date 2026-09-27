import { expect, test } from "bun:test";
import { daytonaProvider } from "./index";
import { Image, Sandbar } from "@sandbar/sdk/direct";

const enabled = process.env.SANDBAR_DAYTONA_LIVE === "1";
(enabled ? test : test.skip)("opt-in Daytona native conformance, one sandbox with TTL and explicit cleanup", async () => {
  const apiKey = process.env.SANDBAR_DAYTONA_API_KEY;
  const target = process.env.SANDBAR_DAYTONA_TARGET;
  const snapshotId = process.env.SANDBAR_DAYTONA_SNAPSHOT_ID;
  if (!apiKey || !target || !snapshotId || process.env.SANDBAR_DAYTONA_BUDGET_ACK !== "yes") throw new Error("Live credentials, target, existing snapshot ID and budget acknowledgement required");
  const provider = await daytonaProvider({ apiKey, target, ttlMinutes: 15 });
  const client = Sandbar.direct({ provider });
  let sandbox: Awaited<ReturnType<typeof client.sandboxes.create>> | undefined;
  try {
    sandbox = await client.sandboxes.create({ environment: Image.prepared(snapshotId), networkPolicy: "blocked", labels: { "sandbar.live-conformance": "true" } });
    expect((await sandbox.inspect()).state).toBe("running");
    const result = await sandbox.exec({ command: { kind: "shell", script: "printf 'ready'" }, deadlineSeconds: 30 });
    expect(result.stdoutText()).toBe("ready");
    await sandbox.writeFile("/tmp/sandbar-live-probe", new Uint8Array([0, 255, 1]), { overwrite: true });
    expect(Array.from(await sandbox.readFile("/tmp/sandbar-live-probe"))).toEqual([0, 255, 1]);
  } finally {
    if (sandbox) await sandbox.destroy();
    await client.close();
  }
});
