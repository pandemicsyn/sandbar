import { expect, spyOn, test } from "bun:test";
import { adapterSuite } from "sandbar-adapter/testing";
import { createModalAdapter, modalWriteScript } from "./adapter";
import type { ModalTransport } from "./transport";
import { Image, OutcomeUnknownError, Sandbar } from "sandbar-sdk";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  assertFiniteStdinWorkflow,
  finiteStdinInput,
} from "../../../sdk-qualification/finite-stdin";

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
    spawnSync(
      "/bin/sh",
      ["-c", modalWriteScript(overwrite), "sandbar-write", posix.dirname(path), path],
      {
        input: Buffer.from(bytes),
      },
    );

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
    code: "OUTCOME_UNKNOWN",
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

  await roundtripBox.writeFile("/root-level", Uint8Array.from([9]), { overwrite: false });
  expect(starts[3]?.command.slice(-2)).toEqual(["/", "/root-level"]);

  const shell = await roundtripBox.exec({
    command: { kind: "shell", script: "printf shell" },
    deadlineSeconds: 5,
  });

  expect(shell).toMatchObject({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() });
  expect(starts[4]?.command).toEqual(["/bin/sh", "-c", "printf shell"]);
  await client.close();
});

test.each(["lost-start", "lost-input", "lost-result"] as const)(
  "Modal finite stdin never infers delivery from result evidence after %s",
  async (lostAt) => {
    const records = new Map<
      string,
      { id: string; tags: Record<string, string>; running: boolean }
    >();

    const results = new Map<
      string,
      { exitCode: number; stdout: Uint8Array; stderr: Uint8Array; truncated: boolean }
    >();

    const bytes = Uint8Array.from([0, 255, 129]);
    const acknowledged: Uint8Array[] = [];
    let starts = 0;
    let stdinCalls = 0;
    let resultCalls = 0;

    const transport: ModalTransport = {
      async lookupApp() {
        return "ap-fixture";
      },
      async imageExists() {
        return true;
      },
      async create(input) {
        records.set(input.name, { id: "sb-stdin", tags: input.tags, running: true });

        return "sb-stdin";
      },
      async findByName(_app, _env, name) {
        return records.get(name) ?? null;
      },
      async *list() {
        yield* records.values();
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
      async start(input) {
        starts++;

        if (lostAt === "lost-start") {
          results.set(input.execId, {
            exitCode: 0,
            stdout: Uint8Array.of(69),
            stderr: Uint8Array.of(33),
            truncated: false,
          });
          throw new Error("start acknowledgement lost");
        }
      },
      async stdin(_id, execId, input) {
        stdinCalls++;
        acknowledged.push(input.slice());
        results.set(execId, {
          exitCode: 0,
          stdout: Uint8Array.of(69),
          stderr: Uint8Array.of(33),
          truncated: false,
        });

        if (lostAt === "lost-input") throw new Error("stdin or EOF acknowledgement lost");
      },
      async result(_id, execId) {
        resultCalls++;

        if (lostAt === "lost-result" && resultCalls === 1)
          throw new Error("result response lost after input acknowledgement");

        const result = results.get(execId);

        if (!result) throw new Error("result unavailable");

        return result;
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

    try {
      const box = await client.sandboxes.create({ environment: Image.prepared("im-fixture") });

      const operation = await box.submitExec({
        command: { kind: "shell", script: "cat >/dev/null; printf eof" },
        stdin: bytes,
        cwd: "/tmp",
        env: { FIXTURE: "yes" },
        maxOutputBytes: 16,
      });

      const reference = operation.reference;
      expect(operation.reference.token).toMatchObject({
        maxBytes: 16,
        inputComplete: lostAt === "lost-result",
      });
      expect(JSON.stringify(operation.reference.token)).not.toContain("255");
      expect(await operation.observe()).toBeNull();

      await client.close();
      client = await open();
      // SAFETY: The saved operation reference is the value under test after a fresh connection.
      const recovered = await client.recover(reference as never);

      if (lostAt === "lost-result") {
        expect(await recovered.observe()).toMatchObject({
          exitCode: 0,
          stdout: Uint8Array.of(69),
          stderr: Uint8Array.of(33),
        });
      } else {
        await expect(recovered.observe()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      }

      expect(starts).toBe(1);
      expect(stdinCalls).toBe(lostAt === "lost-start" ? 0 : 1);

      if (stdinCalls) expect(acknowledged).toEqual([bytes]);
    } finally {
      await client.close();
    }
  },
);

test("public finite stdin preserves UTF-8 bytes, output streams, cwd, env and exit", async () => {
  const records = new Map<string, { id: string; tags: Record<string, string>; running: boolean }>();

  const starts: Array<{
    execId: string;
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
  }> = [];

  const received: Uint8Array[] = [];
  let resultCalls = 0;

  const transport: ModalTransport = {
    async lookupApp() {
      return "ap-fixture";
    },
    async imageExists() {
      return true;
    },
    async create(input) {
      records.set(input.name, { id: "sb-finite-stdin", tags: input.tags, running: true });

      return "sb-finite-stdin";
    },
    async findByName(_app, _environment, name) {
      return records.get(name) ?? null;
    },
    async *list() {
      yield* records.values();
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
    async start(input) {
      starts.push(input);
    },
    async stdin(_sandboxId, _execId, bytes) {
      received.push(bytes.slice());
    },
    async result() {
      resultCalls++;
      const payload = received.at(-1) ?? new Uint8Array();
      const stdout = new Uint8Array(payload.length + 3);
      stdout.set(payload);
      stdout.set(new TextEncoder().encode("out"), payload.length);

      return {
        exitCode: resultCalls === 1 ? 7 : 0,
        stdout: resultCalls === 1 ? stdout : new Uint8Array(),
        stderr: resultCalls === 1 ? new TextEncoder().encode("err") : new Uint8Array(),
        truncated: false,
      };
    },
    close() {},
  };

  const client = await Sandbar.connect({
    adapter: createModalAdapter(() => transport),
    config: { appName: "existing", environment: "main" },
    credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("im-fixture") });
    await assertFiniteStdinWorkflow(box, () => received.at(-1));
    expect(received[0]).toEqual(new TextEncoder().encode(finiteStdinInput));
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      command: ["/bin/sh", "-c", "cat; printf out; printf err >&2; exit 7"],
      cwd: "/tmp",
      env: { FINITE_STDIN_FIXTURE: "selected" },
    });

    expect(
      (
        await box.exec({
          command: { kind: "shell", script: "cat >/dev/null; exit 0" },
          stdin: "",
          maxOutputBytes: 16,
        })
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await box.exec({
          command: { kind: "shell", script: "cat >/dev/null; exit 0" },
          maxOutputBytes: 16,
        })
      ).exitCode,
    ).toBe(0);
    expect(received).toEqual([
      new TextEncoder().encode(finiteStdinInput),
      new Uint8Array(),
      new Uint8Array(),
    ]);
    expect(starts).toHaveLength(3);
  } finally {
    await client.close();
  }
});

test("file writes require decimal byte-count evidence in submit and reopened observation", async () => {
  let receipt = "";
  let loseStdin = false;
  let starts = 0;
  let record = { id: "sb-receipt", tags: {}, running: true };

  const transport: ModalTransport = {
    async lookupApp() {
      return "ap-fixture";
    },
    async imageExists() {
      return true;
    },
    async create(input) {
      record = { ...record, tags: input.tags };

      return record.id;
    },
    async findByName() {
      return record;
    },
    async *list() {
      yield record;
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
    async start() {
      starts++;
    },
    async stdin() {
      if (loseStdin) {
        loseStdin = false;
        throw new Error("lost stdin acknowledgement");
      }
    },
    async result() {
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode(receipt),
        stderr: new Uint8Array(),
        truncated: false,
      };
    },
    close() {},
  };

  const open = () =>
    Sandbar.connect({
      adapter: createModalAdapter(() => transport),
      config: { appName: "existing", environment: "main" },
      credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
    });

  let client = await open();

  const creation = await client.sandboxes.submitCreate({
    environment: Image.prepared("im-fixture"),
    networkPolicy: "blocked",
  });

  let box = await creation.wait();

  try {
    for (const invalid of ["", " \n", "invalid", "0x0", "9007199254740992"]) {
      receipt = invalid;
      await expect(
        box.writeFile("/receipt", new Uint8Array(), { overwrite: true }),
      ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    }

    for (const valid of ["0", " 0\n"]) {
      receipt = valid;
      await box.writeFile("/receipt", new Uint8Array(), { overwrite: true });
    }

    receipt = "2\n";
    await box.writeFile("/receipt", Uint8Array.from([0, 255]), { overwrite: true });

    for (const missing of ["", " \n"]) {
      receipt = missing;
      loseStdin = true;
      let reference;

      try {
        await box.writeFile("/receipt", new Uint8Array(), { overwrite: true });
        throw new Error("Expected uncertain receipt");
      } catch (error) {
        if (!(error instanceof OutcomeUnknownError)) throw error;
        reference = error.reference;
      }

      const submitted = starts;
      await client.close();
      client = await open();
      // SAFETY: The SDK emitted this reference for the fixture's original write.
      await expect((await client.recover(reference as never)).observe()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
      });
      receipt = "0";
      // SAFETY: Recovery reuses the same SDK-emitted reference with decimal evidence now available.
      expect(await (await client.recover(reference as never)).observe()).toBeUndefined();
      expect(starts).toBe(submitted);
      // SAFETY: This completed create reference restores the same sandbox handle after reopening.
      box = (await (await client.recover(creation.reference)).observe()) as typeof box;
    }
  } finally {
    await client.close();
  }
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

test("Modal submission window covers start lookup and result; observation gets its own deadline", async () => {
  const timers: { ms: number; controller: AbortController }[] = [];

  const timer = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    timers.push({ ms, controller });

    return controller.signal;
  });

  let tags: Record<string, string> = {};
  let starts = 0;
  let terminated = 0;
  let resultAvailable = false;
  let startSignal: AbortSignal | undefined;

  const transport: ModalTransport = {
    async lookupApp() {
      return "ap-fixture";
    },
    async imageExists() {
      return true;
    },
    async create(input) {
      expect(input.timeoutMs).toBe(300_000);
      tags = input.tags;

      return "sb-fixture";
    },
    async findByName() {
      return { id: "sb-fixture", tags, running: true };
    },
    async *list() {
      yield { id: "sb-fixture", tags, running: true };
    },
    async terminate() {
      terminated++;

      return true;
    },
    async poll() {
      return "running";
    },
    async readBytes() {
      return new Uint8Array();
    },
    async fileExists() {
      return false;
    },
    async start(input, signal) {
      starts++;
      expect(input.timeoutSeconds).toBe(7);
      expect(timers.at(-1)?.ms).toBe(12_000);
      startSignal = signal;
      // Lookup/start work consumes the same adapter window as the initial result.
      await Promise.resolve();
      timers.at(-1)!.controller.abort(new DOMException("local timeout", "TimeoutError"));
    },
    async stdin() {},
    async result(_sandbox, _id, _max, signal) {
      if (starts === 1 && !resultAvailable && signal === startSignal) {
        expect(signal?.aborted).toBe(true);
        throw signal?.reason;
      }

      expect(signal).not.toBe(startSignal);

      if (!resultAvailable) throw new Error("exit succeeded but output unavailable");

      return { exitCode: 0, stdout: Uint8Array.of(97), stderr: new Uint8Array(), truncated: false };
    },
    close() {},
  };

  const client = await Sandbar.connect({
    adapter: createModalAdapter(() => transport),
    config: { appName: "existing", environment: "main" },
    credentials: { tokenId: "ak", tokenSecret: "as" },
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("im-fixture") });

    const operation = await box.submitExec({
      command: { kind: "argv", argv: ["true"] },
      deadlineSeconds: 7,
    });

    const reference = operation.reference;
    await expect((await client.recover(reference)).observe()).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      effect: "possible",
    });
    expect(timers.at(-1)?.ms).toBeGreaterThan(0);
    expect(timers.at(-1)?.ms).toBeLessThanOrEqual(30_000);
    resultAvailable = true;
    expect(await (await client.recover(reference)).observe()).toMatchObject({
      exitCode: 0,
      stdout: Uint8Array.of(97),
    });
    expect(starts).toBe(1);
    expect(terminated).toBe(0);
  } finally {
    await client.close();
    timer.mockRestore();
  }
});
