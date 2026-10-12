import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type ExecInput, type Json } from "@sandbar-sdk/adapter";
import { captureHelper, captureSpec, decodeReceipt } from "./capture";

const base: ExecInput = {
  sandbox: { id: "session-fixture" },
  command: { kind: "argv", argv: ["true"] },
  deadlineSeconds: 2,
  maxOutputBytes: 1024,
};

async function run(input: ExecInput) {
  const stdinPath =
    input.stdin === undefined ? undefined : `/tmp/sandbar-input-test-${crypto.randomUUID()}`;

  if (stdinPath) await writeFile(stdinPath, input.stdin!, { mode: 0o600, flag: "wx" });

  const helper = spawnSync(
    "node",
    ["-e", captureHelper, JSON.stringify({ ...captureSpec(input), stdinPath })],
    {
      timeout: 5000,
      encoding: "utf8",
    },
  );

  expect(helper.status).toBe(0);
  const path = helper.stdout.split("\n")[0]!;
  expect(path).toMatch(/^\/tmp\/sandbar-exec-[A-Za-z0-9]+\/receipt\.json$/);

  try {
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    return await readFile(path);
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
}

test("capture preserves every byte on stdout and stderr", async () => {
  const input: ExecInput = {
    ...base,
    command: {
      kind: "argv",
      argv: [
        "node",
        "-e",
        "const b = Buffer.from(Array.from({length:256}, (_, i) => i)); process.stdout.write(b); process.stderr.write(b); process.exitCode = 23;",
      ],
    },
  };

  const result = decodeReceipt(await run(input), input.maxOutputBytes);
  const all = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  expect(result).toEqual({ exitCode: 23, stdout: all, stderr: all, truncated: false });
});

test("capture drains both pipes after the shared output limit", async () => {
  const input: ExecInput = {
    ...base,
    maxOutputBytes: 19,
    command: {
      kind: "argv",
      argv: [
        "node",
        "-e",
        "process.stdout.write(Buffer.alloc(2 ** 20, 65)); process.stderr.write(Buffer.alloc(2 ** 20, 66));",
      ],
    },
  };

  const result = decodeReceipt(await run(input), input.maxOutputBytes);
  expect(result.exitCode).toBe(0);

  if (!(result.stdout instanceof Uint8Array) || !(result.stderr instanceof Uint8Array))
    throw new Error("Expected captured bytes");
  expect(result.stdout.length + result.stderr.length).toBe(19);
  expect(result.truncated).toBe(true);
});

test("capture passes argv literally with cwd and environment, and supports shell", async () => {
  const literal = "$(touch /tmp/must-never-run); 'quoted' \n";

  const input: ExecInput = {
    ...base,
    cwd: "/tmp",
    env: { SANDBAR_CAPTURE_FIXTURE: "environment" },
    command: {
      kind: "argv",
      argv: [
        "node",
        "-e",
        "process.stdout.write(JSON.stringify([process.cwd(), process.env.SANDBAR_CAPTURE_FIXTURE, process.argv[1]]))",
        literal,
      ],
    },
  };

  const result = decodeReceipt(await run(input), input.maxOutputBytes);

  if (!(result.stdout instanceof Uint8Array)) throw new Error("Expected captured bytes");
  expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual([
    await realpath("/tmp"),
    "environment",
    literal,
  ]);

  const shell = decodeReceipt(
    await run({
      ...base,
      command: { kind: "shell", script: "printf shell; printf error >&2; exit 7" },
    }),
    1024,
  );

  expect(shell).toEqual({
    exitCode: 7,
    stdout: Buffer.from("shell"),
    stderr: Buffer.from("error"),
    truncated: false,
  });
});

test("capture records launch failures, signals, and deadlines", async () => {
  const failed = await run({
    ...base,
    command: { kind: "argv", argv: ["/sandbar-fixture-does-not-exist"] },
  });

  expect(() => decodeReceipt(failed, 1024)).toThrow(
    expect.objectContaining({ code: "UNAVAILABLE" }),
  );

  const timedOut = await run({
    ...base,
    deadlineSeconds: 0.05,
    command: { kind: "argv", argv: ["node", "-e", "setInterval(() => {}, 1000)"] },
  });

  expect(() => decodeReceipt(timedOut, 1024)).toThrow(expect.objectContaining({ code: "TIMEOUT" }));

  const signaled = await run({
    ...base,
    command: {
      kind: "argv",
      argv: ["/bin/sh", "-c", "printf '\\000\\377'; printf '\\201' >&2; kill -TERM $$"],
    },
  });

  expect(decodeReceipt(signaled, 1024)).toEqual({
    exitCode: null,
    stdout: Buffer.from([0, 255]),
    stderr: Buffer.from([129]),
    truncated: false,
  });
});

const receipt = {
  version: 1,
  exitCode: 0,
  signal: null,
  timedOut: false,
  failure: false,
  truncated: false,
  stdout: "",
  stderr: "",
};

const encode = (value: Json) => new TextEncoder().encode(JSON.stringify(value));

test("receipt decoding rejects malformed, oversized, and inconsistent evidence", () => {
  for (const bytes of [
    new Uint8Array([255]),
    Buffer.from("{"),
    encode({ ...receipt, version: 2 }),
    encode({ ...receipt, stdout: "!" }),
    encode({ ...receipt, extra: true }),
  ])
    expect(() => decodeReceipt(bytes, 1024)).toThrow();
  expect(() => decodeReceipt(encode({ ...receipt, stdout: "YWJj", stderr: "ZA==" }), 3)).toThrow(
    expect.objectContaining({ code: "INTERNAL" }),
  );

  for (const invalid of [
    { ...receipt, exitCode: null },
    { ...receipt, signal: "SIGTERM" },
  ])
    expect(() => decodeReceipt(encode(invalid), 1024)).toThrow(
      expect.objectContaining({ code: "INTERNAL" }),
    );
});

test("capture sends finite binary stdin and EOF, including empty and early-close input", async () => {
  for (const stdin of [
    undefined,
    new Uint8Array(),
    Uint8Array.from({ length: 256 }, (_, i) => i),
    new Uint8Array(1048576).fill(255),
  ]) {
    const result = decodeReceipt(
      await run({
        ...base,
        stdin,
        maxOutputBytes: 1048576,
        command: { kind: "argv", argv: ["node", "-e", "process.stdin.pipe(process.stdout)"] },
      }),
      1048576,
    );

    expect(result.stdout).toEqual(Buffer.from(stdin ?? new Uint8Array()));
    expect(result.exitCode).toBe(0);
  }

  expect(
    decodeReceipt(
      await run({
        ...base,
        stdin: new Uint8Array(1048576),
        command: { kind: "argv", argv: ["true"] },
      }),
      1024,
    ).exitCode,
  ).toBe(0);
});

test("capture rejects corrupted staged stdin before launching the command", async () => {
  const stdinPath = `/tmp/sandbar-input-test-${crypto.randomUUID()}`;
  const marker = `/tmp/sandbar-input-marker-${crypto.randomUUID()}`;
  await writeFile(stdinPath, "corrupted", { mode: 0o600, flag: "wx" });

  const helper = spawnSync(
    "node",
    [
      "-e",
      captureHelper,
      JSON.stringify({
        ...captureSpec({
          ...base,
          stdin: new Uint8Array([0, 255]),
          command: { kind: "argv", argv: ["touch", marker] },
        }),
        stdinPath,
      }),
    ],
    { timeout: 5000, encoding: "utf8" },
  );

  const receiptPath = helper.stdout.split("\n")[0]!;

  try {
    expect(helper.status).not.toBe(0);
    expect(helper.stderr).toContain("Finite stdin verification failed");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(stdinPath, { force: true });

    if (/^\/tmp\/sandbar-exec-[A-Za-z0-9]+\/receipt\.json$/.test(receiptPath))
      await rm(dirname(receiptPath), { recursive: true, force: true });
    await rm(marker, { force: true });
  }
});
