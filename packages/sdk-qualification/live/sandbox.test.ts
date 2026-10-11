import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { artifactFiles } from "../../../apps/docs/examples/directory-files";
import type { AdapterSandbox } from "sandbar-sdk";
import { TestResources } from "./fixtures/resources";
import {
  liveEnabled,
  featureSupported,
  setupLive,
  finishLive,
  reopenSnapshot,
  fileNoClobber,
} from "./providers";
import { boundedRead } from "../provider-qualification/bounds";
import { assertFiniteStdinWorkflow } from "../finite-stdin";

import {
  processAbsent,
  memoryProgram,
  memoryRead,
  quote,
  memorySample,
} from "./fixtures/memory-probe";

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

export async function files(
  t: TestResources,
  box: AdapterSandbox,
  root = "/tmp",
  noClobber = true,
) {
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
  ).rejects.toMatchObject({ code: noClobber ? "CONFLICT" : "UNSUPPORTED" });
  expect(await t.read(box, path)).toEqual(second);
}

export async function finiteStdin(t: TestResources, box: AdapterSandbox) {
  t.at("sandbox/finite-stdin");
  await assertFiniteStdinWorkflow({ exec: (input) => box.exec(input, { signal: t.signal }) });

  for (const stdin of [Uint8Array.of(0, 255, 129, 13, 10), "", new Uint8Array(), undefined]) {
    const result = await box.exec(
      {
        command: { kind: "argv", argv: ["/bin/sh", "-c", "cat; printf eof >&2"] },
        stdin,
        cwd: "/tmp",
        deadlineSeconds: 20,
        maxOutputBytes: 32,
      },
      { signal: t.signal },
    );

    expect(result.stdout).toEqual(stdin instanceof Uint8Array ? stdin : new Uint8Array());
    expect(result.stderrText()).toBe("eof");
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
  }
}

export async function directories(t: TestResources, box: AdapterSandbox, fileRoot: string) {
  const root = `${fileRoot}/sandbar-directories-${t.ledger.runId}`;
  const options = { recursive: true, signal: t.signal };
  t.at("sandbox/directories");
  await box.makeDirectory(`${root}/nested/results`, options);
  await box.makeDirectory(`${root}/nested/results`, options);
  await box.makeDirectory(`${root}/target`, options);
  const sentinel = `${root}/target/sentinel.bin`;
  const bytes = Uint8Array.of(0, 255, 129);
  await box.writeFile(sentinel, bytes, { signal: t.signal });
  await box.exec(
    [
      "/bin/sh",
      "-c",
      'ln -s "$1/missing" "$1/dangling"; ln -s "$1/target" "$1/child"; ln -s "$1/target" "$1/parent"',
      "_",
      root,
    ],
    { signal: t.signal },
  );
  expect(await box.fileExists(`${root}/dangling`, { signal: t.signal })).toBe(true);
  expect(await box.fileExists(`${root}/missing`, { signal: t.signal })).toBe(false);
  await expect(box.makeDirectory(sentinel, options)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(box.removeFile("///", options)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    effect: "none",
  });
  const listing = await box.readDirectory(root, { signal: t.signal });
  expect(listing.completeness).toBe("complete");
  expect(listing.entries).toEqual(await box.listFiles(root, { signal: t.signal }));
  expect(listing.entries.find((entry) => entry.name === "dangling")?.type).toBe("symlink");
  expect((await box.statFile(`${root}/dangling`, { signal: t.signal })).type).toBe("symlink");
  await expect(box.removeFile(root, { signal: t.signal })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  await box.makeDirectory(`${root}/empty`, { signal: t.signal });
  await box.removeFile(`${root}/empty`, { signal: t.signal });
  await box.copyFile(sentinel, `${root}/copy.bin`, { signal: t.signal });
  await expect(
    box.copyFile(sentinel, `${root}/copy.bin`, { signal: t.signal }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await box.moveFile(`${root}/copy.bin`, `${root}/moved.bin`, { signal: t.signal });
  expect(await box.fileExists(`${root}/copy.bin`, { signal: t.signal })).toBe(false);
  expect(await box.readFile(`${root}/moved.bin`, { signal: t.signal })).toEqual(bytes);

  // One 32 MiB transfer, with full content verification and constant-sized chunks.
  const expected = createHash("sha256");
  const size = 32 * 1024 * 1024;
  const chunk = new Uint8Array(64 * 1024);

  for (let index = 0; index < chunk.length; index++) chunk[index] = index % 251;

  async function* input() {
    for (let sent = 0; sent < size; sent += chunk.length) {
      expected.update(chunk);
      yield chunk;
    }
  }

  const actual = createHash("sha256");
  let downloaded = 0;

  const artifact = await artifactFiles(
    box,
    input(),
    {
      async write(data) {
        actual.update(data);
        downloaded += data.length;
      },
    },
    `${root}/artifacts`,
    t.signal,
  );

  expect(artifact.uploaded).toBe(size);
  expect(artifact.directory.completeness).toBe("complete");
  expect(artifact.info.type).toBe("file");
  expect(artifact.entries.map((entry) => entry.relativePath)).toEqual([
    "archive.bin",
    "final.json",
    "results",
    "results/events.txt",
    "results/report.json",
  ]);
  expect(artifact.lines).toEqual(["ready ✓", "complete"]);
  expect(downloaded).toBe(size);
  expect(actual.digest("hex")).toBe(expected.digest("hex"));
  expect(await box.fileExists(`${root}/artifacts`, { signal: t.signal })).toBe(false);
  await box.removeFile(`${root}/child/`, options);
  expect(await box.readFile(sentinel, { signal: t.signal })).toEqual(bytes);
  await box.removeFile(`${root}/parent/sentinel.bin`, options);
  expect(await box.fileExists(sentinel, { signal: t.signal })).toBe(false); // Parent links follow the native namespace.
  await box.writeFile(sentinel, bytes, { signal: t.signal });
  await box.removeFile(`${root}/dangling/`, options);
  expect(await box.fileExists(`${root}/dangling`, { signal: t.signal })).toBe(false);
  await box.removeFile(`${root}/missing`, options);
  await box.removeFile(root, options);
  expect(await box.fileExists(root, { signal: t.signal })).toBe(false);
}

describe("Sandbar sandbox", () => {
  let fixture: Awaited<ReturnType<typeof setupLive>> | undefined;
  let box: AdapterSandbox;
  beforeAll(async () => {
    if (liveEnabled) {
      fixture = await setupLive(
        [
          "sandbox-lifecycle",
          "execution",
          ...(featureSupported("finiteStdin") ? ["execution-stdin" as const] : []),
          "files",
          "lifecycle-reopen",
          "lifecycle-renew",
          "lifecycle-suspend-resume",
          ...(featureSupported("directories") ? ["file-directories" as const] : []),
        ],
        {
          compute: 1,
          snapshots: 0,
          volumes: 0,
        },
      );
      await fixture.resources.setup(async () => {
        await fixture!.resources.open();
        const t = fixture!.resources;
        box = await t.create("sandbox/source");
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
  (liveEnabled && featureSupported("finiteStdin") ? test : test.skip)(
    "execution-stdin",
    async () => finiteStdin(fixture!.resources, box),
    241000,
  );
  (liveEnabled ? test : test.skip)(
    "files",
    async () => files(fixture!.resources, box, fixture!.fileRoot, fileNoClobber),
    241000,
  );
  (liveEnabled && featureSupported("directories") ? test : test.skip)(
    "file-directories",
    async () => directories(fixture!.resources, box, fixture!.fileRoot),
    241000,
  );
  (liveEnabled ? test : test.skip)(
    "lifecycle-renew",
    async () => renewal(fixture!.resources, box),
    241000,
  );
  (liveEnabled && featureSupported("suspension") ? test : test.skip)(
    "lifecycle-suspend-resume",
    async () => {
      const configured = fixture!;
      const t = configured.resources;
      const path = `${configured.fileRoot}/sandbar-suspend-${t.ledger.runId}`;
      const nonce = crypto.randomUUID();
      const bytes = new TextEncoder().encode(nonce);
      await box.writeFile(path, bytes, { overwrite: true, signal: t.signal });
      // Reuse the snapshot suite's in-memory nonce/counter and bounded socket probe.
      await t.exec(box, `nohup python3 -u -c ${quote(memoryProgram)} >/dev/null 2>&1 </dev/null &`);
      let memoryBefore: ReturnType<typeof memorySample> | undefined;

      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          memoryBefore = memorySample(await t.exec(box, memoryRead));
        } catch {
          /* Process may still be starting. */
        }

        if (memoryBefore) break;
        await boundedRead(new Promise((resolve) => setTimeout(resolve, 100)), t.signal);
      }

      if (!memoryBefore) throw Error("Memory probe did not start");
      const before = await box.inspect({ signal: t.signal });
      t.at("sandbox/suspend");
      const suspended = await box.suspend({ signal: t.signal });
      expect(suspended.reference).toEqual(box.reference!);
      expect(suspended.processes).toBe(
        t.client.provider === "daytona" ? "terminated" : "preserved",
      );
      const reference = JSON.parse(JSON.stringify(box.reference));
      await reopenSnapshot(configured, reference, {
        path,
        base64: Buffer.from(bytes).toString("base64"),
        expires: suspended.observation.expires,
        inactive: true,
      });
      await t.reconnect(t.signal);
      box = await t.client.sandboxes.get(reference, { signal: t.signal });
      expect(["stopped", "suspended"]).toContain((await box.inspect({ signal: t.signal })).state);
      t.at("sandbox/resume");
      const resumed = await box.resume({ signal: t.signal });
      expect(resumed.reference).toEqual(reference);

      if (suspended.processes === "terminated") expect(resumed.execution).toBe("fresh");
      else expect(["resumed", "unknown"]).toContain(resumed.execution);
      expect(await t.read(box, path)).toEqual(bytes);

      if (t.client.provider === "daytona") {
        expect(await t.exec(box, processAbsent)).toBe("PROCESS_ABSENT\n");
        expect(resumed.observation.expires).toEqual(before.expires);
      } else {
        const after = memorySample(await t.exec(box, memoryRead));
        expect(after.nonce).toBe(memoryBefore.nonce);
        expect(after.count).toBeGreaterThan(memoryBefore.count);
        expect(resumed.observation.expires.status).toBe("known");
      }
      // Shared afterAll cleanup destroys the owned logical sandbox from any state.
    },
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
