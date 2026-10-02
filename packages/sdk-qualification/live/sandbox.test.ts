import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AdapterSandbox } from "sandbar-sdk";
import { TestResources } from "./fixtures/resources";
import { liveEnabled, setupLive, finishLive, reopenSnapshot } from "./providers";
import { boundedRead } from "../provider-qualification/bounds";

export async function lifecycle(t: TestResources, box: AdapterSandbox, inventoryWaitMs = 30000) {
  expect((await box.inspect({ signal: t.signal })).state).toBe("running");
  const timeout = AbortSignal.timeout(inventoryWaitMs);
  const signal = AbortSignal.any([t.signal, timeout]);

  try {
    // Native list indexes may lag direct detail reads. Repeat reads, never creation.
    while (!signal.aborted) {
      let cursor: string | undefined;

      for (let page = 0; page < 10; page++) {
        const inventory = await boundedRead(
          t.client.operations.inventory({ limit: 100, cursor }),
          signal,
        );

        if (inventory.items.some((item) => item.id === box.id && item.state === "running")) return;
        cursor = inventory.nextCursor;

        if (!cursor) break;
      }

      await boundedRead(new Promise((resolve) => setTimeout(resolve, 500)), signal);
    }
  } catch (error) {
    if (!timeout.aborted || t.signal.aborted) throw error;
  }

  t.signal.throwIfAborted();
  throw Error("Owned sandbox absent from bounded inventory");
}

export async function renewal(t: TestResources, box: AdapterSandbox) {
  t.at("sandbox/renew");
  const before = Date.now();
  const result = await box.renew({ forSeconds: 61 }, { signal: t.signal });
  const after = Date.now();
  const resolved = t.client.provider === "daytona" ? 120 : 61;
  expect(result.requested).toEqual({ forSeconds: resolved });
  expect(result.acknowledged).toBe(true);
  expect(result.reference).toEqual(box.reference!);
  expect(result.observation?.expires.status).toBe("known");

  if (result.observation?.expires.status !== "known") throw Error("Renewal deadline unavailable");
  const deadline = Date.parse(result.observation.expires.at);
  // Request duration plus a five-second clock tolerance; no exact deletion claim.
  expect(deadline).toBeGreaterThanOrEqual(before + resolved * 1000 - 5000);
  expect(deadline).toBeLessThanOrEqual(after + resolved * 1000 + 5000);
  const max = t.client.provider === "daytona" ? 86400 : 3600;
  await expect(box.renew({ forSeconds: max + 1 }, { signal: t.signal })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    effect: "none",
  });
}

export async function execution(t: TestResources, box: AdapterSandbox) {
  const argv = await box.exec(
    {
      command: {
        kind: "argv",
        argv: [
          "/bin/sh",
          "-c",
          'printf \'%s|%s\' "$1" "$QUAL_VALUE"; printf err >&2',
          "_",
          "argument with spaces",
        ],
      },
      cwd: "/tmp",
      env: { QUAL_VALUE: "argv-ok" },
      deadlineSeconds: 20,
      maxOutputBytes: 4096,
    },
    { signal: t.signal },
  );

  expect(argv.stdoutText()).toBe("argument with spaces|argv-ok");
  expect(argv.stderrText()).toBe("err");

  const shell = await box.exec(
    {
      command: { kind: "shell", script: "printf '%s' \"$QUAL_VALUE\"" },
      cwd: "/tmp",
      env: { QUAL_VALUE: "shell-ok" },
      deadlineSeconds: 20,
      maxOutputBytes: 4096,
    },
    { signal: t.signal },
  );

  expect(shell.stdoutText()).toBe("shell-ok");
  await expect(
    box.exec(
      {
        command: { kind: "shell", script: "printf fail >&2; exit 7" },
        deadlineSeconds: 20,
        maxOutputBytes: 4096,
      },
      { signal: t.signal },
    ),
  ).rejects.toMatchObject({ name: "NonzeroExitError", code: "NONZERO_EXIT" });
}

export async function files(t: TestResources, box: AdapterSandbox, root = "/tmp") {
  const path = `${root}/sandbar-${t.ledger.runId}`;
  const first = new Uint8Array([0, 255, 1, 128]);
  const second = new Uint8Array([2, 254, 0]);
  await box.writeFile(path, first, { overwrite: true, signal: t.signal });
  expect(await t.read(box, path)).toEqual(first);
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(box.readFile(path, { signal: cancelled.signal })).rejects.toMatchObject({
    code: "WAIT_ABORTED",
    effect: "none",
  });
  expect(await box.readFile(path, { signal: t.signal })).toEqual(first);
  await box.writeFile(path, second, { overwrite: true, signal: t.signal });
  expect(await t.read(box, path)).toEqual(second);
  await expect(
    box.writeFile(path, first, { overwrite: false, signal: t.signal }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await t.read(box, path)).toEqual(second);
}

describe("Sandbar sandbox", () => {
  let fixture: Awaited<ReturnType<typeof setupLive>> | undefined;
  let box: AdapterSandbox;
  beforeAll(async () => {
    if (liveEnabled) {
      fixture = await setupLive(
        ["sandbox-lifecycle", "execution", "files", "lifecycle-reopen", "lifecycle-renew"],
        {
          compute: 1,
          snapshots: 0,
          volumes: 0,
        },
      );
      await fixture.resources.setup(async () => {
        await fixture!.resources.open();
        const t = fixture!.resources;
        box = await t.create(
          "sandbox/source",
          undefined,
          t.network,
          t.client.provider === "daytona" || t.client.provider === "e2b",
        );
      });
    }
  }, 96000);
  afterAll(async () => {
    if (fixture) await finishLive(fixture);
  }, 76000);
  (liveEnabled ? test : test.skip)(
    "sandbox-lifecycle",
    async () => lifecycle(fixture!.resources, box),
    241000,
  );
  (liveEnabled ? test : test.skip)(
    "execution",
    async () => execution(fixture!.resources, box),
    241000,
  );
  (liveEnabled ? test : test.skip)(
    "files",
    async () => files(fixture!.resources, box, fixture!.fileRoot),
    241000,
  );
  (liveEnabled ? test : test.skip)(
    "lifecycle-renew",
    async () => renewal(fixture!.resources, box),
    241000,
  );
  (liveEnabled ? test : test.skip)(
    "lifecycle-reopen",
    async () => {
      const configured = fixture!;
      const t = configured.resources;
      {
        expect(box.reference).not.toBeNull();
        const reference = JSON.parse(JSON.stringify(box.reference));
        const path = `${configured.fileRoot}/sandbar-reopen-${t.ledger.runId}`;
        const bytes = new Uint8Array([0, 255, 31, 128]);
        await box.writeFile(path, bytes, { overwrite: true, signal: t.signal });
        const expires = (await box.inspect({ signal: t.signal })).expires;

        if (t.client.provider === "e2b") {
          expect(expires).toMatchObject({ status: "known", scope: "running-session" });
        }

        await reopenSnapshot(configured, reference, {
          path,
          base64: Buffer.from(bytes).toString("base64"),
          expires,
        });
        await t.reconnect(t.signal);
        box = await t.client.sandboxes.get(reference, { signal: t.signal });
        expect(await t.read(box, path)).toEqual(bytes);
        expect((await box.inspect({ signal: t.signal })).expires).toEqual(expires);
        t.at("sandbox/reopen-delete");
        await t.destroy("sandbox/source");
        await expect(t.client.sandboxes.get(reference, { signal: t.signal })).rejects.toMatchObject(
          { code: "NOT_FOUND" },
        );
      }
    },
    241000,
  );
});
