import { expect, test } from "bun:test";
import { adapterSuite } from "sandbar-adapter/testing";
import { createModalAdapter, modalWriteScript } from "./adapter";
import type { ModalTransport } from "./transport";
import { Image, Sandbar } from "sandbar-sdk";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Modal public adapter passes required managed-compute scenarios", async () => {
  const effects = { create: 0, destroy: 0, release: 0 };
  const records = new Map<string, { id: string; tags: Record<string, string>; running: boolean }>();
  let lose = false;
  let hold = false;
  let resume: (() => void) | undefined;

  const transportFactory = (): ModalTransport => ({
    async lookupApp(_name, environment) {
      return environment === "main" ? "ap-main" : "ap-alternate";
    },
    async imageExists(id) {
      return id === "im-fixture";
    },
    async create(input) {
      effects.create++;
      const record = { id: `sb-${effects.create}`, tags: input.tags, running: true };
      records.set(input.name, record);

      if (lose) {
        lose = false;
        throw new Error("response lost after native effect");
      }

      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => {
          resume = resolve;
        });
      }

      return record.id;
    },
    async findByName(_name, _environment, name) {
      return records.get(name) ?? null;
    },
    async *list() {
      for (const record of records.values()) yield record;
    },
    async terminate(id) {
      effects.destroy++;

      for (const record of records.values()) if (record.id === id) record.running = false;

      return true;
    },
    async poll() {
      return "stopped";
    },
    async readBytes() {
      return new Uint8Array();
    },
    async fileExists() {
      return false;
    },
    async start() {},
    async stdin() {},
    async result() {
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false };
    },
    close() {
      effects.release++;
    },
  });

  const adapter = createModalAdapter(transportFactory);

  const report = await adapterSuite({
    adapter,
    fixture: {
      config: { appName: "existing", environment: "main", region: "us-east-1" },
      credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
      alternate: {
        config: { appName: "existing", environment: "alternate", region: "us-east-1" },
        credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
      },
      createInput: { image: { kind: "prepared", value: "im-fixture" }, networkPolicy: "blocked" },
      counters: () => ({ ...effects }),
      loseNextCreateResponse() {
        lose = true;
      },
      holdNextCreateResponse() {
        hold = true;
      },
      releaseHeldCreateResponse() {
        if (!resume) throw new Error("Native create was not held");
        resume();
      },
      assertNativeRetriesDisabled() {
        // The injected ModalTransport is the exact native boundary; transport.test also
        // qualifies noRetryGrpcMiddleware against the pinned SDK's retry middleware.
        expect(effects.create).toBe(0);
      },
    },
  });

  expect(report.scenarios).toContain("lost response unknown and observation without replay");
  expect(report.counters).toEqual({ create: 3, destroy: 1, release: 2 });
});

test("write command uses atomic noclobber and preserves binary bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-modal-write-"));
  const path = join(directory, "nested", "binary");

  const invoke = (overwrite: boolean, bytes: Uint8Array) =>
    spawnSync("/bin/sh", ["-c", modalWriteScript(overwrite), "sandbar-write", path], {
      input: Buffer.from(bytes),
    });

  try {
    expect(invoke(false, Uint8Array.from([0, 255, 129])).status).toBe(0);
    expect(new Uint8Array(await readFile(path))).toEqual(Uint8Array.from([0, 255, 129]));
    expect(invoke(false, Uint8Array.from([1, 2])).status).not.toBe(0);
    expect(new Uint8Array(await readFile(path))).toEqual(Uint8Array.from([0, 255, 129]));
    expect(invoke(true, Uint8Array.from([1, 2])).status).toBe(0);
    expect(new Uint8Array(await readFile(path))).toEqual(Uint8Array.from([1, 2]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Modal direct exec and write recover by execution ID after one uncertain submission", async () => {
  const records = new Map<string, { id: string; tags: Record<string, string>; running: boolean }>();

  const processes = new Map<
    string,
    { exitCode: number; stdout: Uint8Array; stderr: Uint8Array; truncated: boolean }
  >();

  const starts: Array<{
    execId: string;
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
  }> = [];

  const files = new Map<string, Uint8Array>();
  let loseExec = true;
  let loseWrite = true;
  let writePath = "";

  const transport: ModalTransport = {
    async lookupApp() {
      return "ap-fixture";
    },
    async imageExists() {
      return true;
    },
    async create(input) {
      records.set(input.name, { id: "sb-1", tags: input.tags, running: true });

      return "sb-1";
    },
    async findByName(_app, _env, name) {
      return records.get(name) ?? null;
    },
    async *list() {
      for (const value of records.values()) yield value;
    },
    async terminate() {
      return true;
    },
    async poll() {
      return "stopped";
    },
    async readBytes(_id, path) {
      return files.get(path) ?? new Uint8Array();
    },
    async fileExists(_id, path) {
      return files.has(path);
    },
    async start(input) {
      starts.push(input);

      if (input.command[0] === "printf") {
        processes.set(input.execId, {
          exitCode: 23,
          stdout: Uint8Array.from([0, 255]),
          stderr: Uint8Array.from([129]),
          truncated: false,
        });

        if (loseExec) {
          loseExec = false;
          throw new Error("lost exec start response");
        }
      } else if (input.command[0] === "/bin/sh" && !input.command[2]?.includes("cat >")) {
        processes.set(input.execId, {
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          truncated: false,
        });
      } else {
        writePath = input.command.at(-1)!;
        processes.set(input.execId, {
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          truncated: false,
        });
      }
    },
    async stdin(_id, execId, bytes) {
      files.set(writePath, bytes.slice());
      processes.set(execId, {
        exitCode: 0,
        stdout: new TextEncoder().encode(`${bytes.length}\n`),
        stderr: new Uint8Array(),
        truncated: false,
      });

      if (loseWrite) {
        loseWrite = false;
        processes.set(execId, {
          exitCode: 0,
          stdout: new TextEncoder().encode(`${bytes.length - 1}\n`),
          stderr: new Uint8Array(),
          truncated: false,
        });
        throw new Error("lost write acknowledgement");
      }

      expect(processes.has(execId)).toBe(true);
    },
    async result(_id, execId, maxBytes) {
      const value = processes.get(execId);

      if (!value) throw new Error("no execution evidence");
      expect(maxBytes).toBeLessThanOrEqual(1_048_576);

      return value;
    },
    close() {},
  };

  const adapter = createModalAdapter(() => transport);
  let saved: unknown;

  const open = () =>
    Sandbar.connect({
      adapter,
      config: { appName: "existing", environment: "main" },
      credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
      onReference(reference) {
        saved = reference;
      },
    });

  let client = await open();

  const box = await client.sandboxes.create({
    environment: Image.prepared("im-fixture"),
    networkPolicy: "blocked",
  });

  const createReference = saved;
  expect(box.supports("exec")).toBe(true);
  expect(box.supports("writeFile")).toBe(true);

  const execution = await box.submitExec({
    command: { kind: "argv", argv: ["printf", "%s", "x"] },
    cwd: "/tmp",
    env: { KEY: "value" },
    maxOutputBytes: 3,
  });

  expect(await execution.observe()).toBeNull();
  const execReference = execution.reference;
  await client.close();
  client = await open();
  // SAFETY: The SDK produced this reference during the fixture's original execution submission.
  await expect((await client.recover(execReference as never)).observe()).rejects.toMatchObject({
    code: "NONZERO_EXIT",
    result: { exitCode: 23, stdout: Uint8Array.from([0, 255]), stderr: Uint8Array.from([129]) },
  });
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({
    command: ["printf", "%s", "x"],
    cwd: "/tmp",
    env: { KEY: "value" },
  });

  // SAFETY: The saved create reference resolves to the same sandbox handle type in this fixture.
  const recoveredBox = (await (
    await client.recover(createReference as never)
  ).observe()) as typeof box;

  let writeReference: unknown;

  try {
    await recoveredBox.writeFile("/tmp/binary", Uint8Array.from([0, 255, 129]), {
      overwrite: false,
    });
    throw new Error("Expected uncertain write evidence");
  } catch (error) {
    expect(error).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    // SAFETY: The thrown SDK outcome carries the recovery reference checked above.
    writeReference = (error as { reference: unknown }).reference;
  }

  expect(writeReference).toMatchObject({ token: { expectedBytes: 3 }, tokenVersion: 1 });
  const writeExecId = starts[1]!.execId;
  processes.set(writeExecId, {
    exitCode: 0,
    stdout: new TextEncoder().encode("3\n"),
    stderr: new Uint8Array(),
    truncated: false,
  });
  await client.close();
  client = await open();
  // SAFETY: The SDK produced this reference before the original fixture write submission.
  expect(await (await client.recover(writeReference as never)).observe()).toBeUndefined();
  expect(files.get("/tmp/binary")).toEqual(Uint8Array.from([0, 255, 129]));
  expect(starts).toHaveLength(2);
  expect(starts[1]?.command[2]).toContain("set -C");

  // SAFETY: The saved create reference resolves to the same sandbox handle type in this fixture.
  const roundtripBox = (await (
    await client.recover(createReference as never)
  ).observe()) as typeof box;

  expect(await roundtripBox.readFile("/tmp/binary")).toEqual(Uint8Array.from([0, 255, 129]));
  await expect(
    roundtripBox.writeFile("/tmp/binary", Uint8Array.from([7]), { overwrite: false }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(starts).toHaveLength(2);
  await roundtripBox.writeFile("/tmp/binary", Uint8Array.from([1, 2]), { overwrite: true });
  expect(await roundtripBox.readFile("/tmp/binary")).toEqual(Uint8Array.from([1, 2]));
  expect(starts[2]?.command[2]).not.toContain("set -C");

  const shell = await roundtripBox.exec({
    command: { kind: "shell", script: "printf shell" },
    deadlineSeconds: 5,
  });

  expect(shell).toMatchObject({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() });
  expect(starts[3]?.command).toEqual(["/bin/sh", "-c", "printf shell"]);
  await client.close();
});

test("OCI create builds only in submit and never replays an uncertain image or sandbox mutation", async () => {
  for (const loseAt of ["image", "sandbox"] as const) {
    let imageChecks = 0;
    let creates = 0;

    const records = new Map<
      string,
      { id: string; tags: Record<string, string>; running: boolean }
    >();

    const transport: ModalTransport = {
      async lookupApp() {
        return "ap-fixture";
      },
      async imageExists() {
        imageChecks++;

        return true;
      },
      async create(input) {
        creates++;
        expect(input.imageId).toBe("");
        expect(input.ociReference).toBe("python:3.12-slim");

        if (loseAt === "sandbox")
          records.set(input.name, { id: "sb-oci", tags: input.tags, running: true });
        throw new Error("lost native response");
      },
      async findByName(_app, _env, name) {
        return records.get(name) ?? null;
      },
      async *list() {
        for (const record of records.values()) yield record;
      },
      async terminate() {
        return true;
      },
      async poll() {
        return "stopped";
      },
      async readBytes() {
        return new Uint8Array();
      },
      async fileExists() {
        return false;
      },
      async start() {},
      async stdin() {},
      async result() {
        return {
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          truncated: false,
        };
      },
      close() {},
    };

    const adapter = createModalAdapter(() => transport);

    const open = () =>
      Sandbar.connect({
        adapter,
        config: { appName: "existing", environment: "main" },
        credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
      });

    let client = await open();

    const op = await client.sandboxes.submitCreate({
      environment: Image.oci("python:3.12-slim"),
      networkPolicy: "blocked",
    });

    expect(imageChecks).toBe(0);
    expect(creates).toBe(1);
    const reference = op.reference;
    await client.close();
    client = await open();

    if (loseAt === "image")
      await expect((await client.recover(reference)).observe()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
      });
    else expect(await (await client.recover(reference)).observe()).toMatchObject({ id: "sb-oci" });
    expect(creates).toBe(1);
    await client.close();
  }
});
