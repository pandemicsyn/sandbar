import { expect, spyOn, test } from "bun:test";
import { type ExecInput, type ExecOutput } from "sandbar-sdk";
import { hello } from "./agent-hello-world/main";
import { edit } from "./agent-edit-file/main";
import { agentEnvironment, OPENCODE, OPENCODE_VERSION, WORKDIR } from "./shared/opencode";
import { cleanup } from "./shared/provider";

function output(stdout: string, stderr = ""): ExecOutput {
  return {
    exitCode: 0,
    stdout: new TextEncoder().encode(stdout),
    stderr: new TextEncoder().encode(stderr),
    truncated: false,
    stdoutText: () => stdout,
    stderrText: () => stderr,
    stdoutPreview: () => ({ text: stdout, shortened: false }),
    stderrPreview: () => ({ text: stderr, shortened: false }),
  };
}

const signal = new AbortController().signal;

const env = { OPENCODE_CONFIG_CONTENT: "{}" };

test("hello captures stdout and stderr from one bounded agent execution", async () => {
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
  const calls: (ExecInput | readonly string[])[] = [];

  try {
    const result = await hello(
      {
        async exec(input, options) {
          calls.push(input);
          expect(options?.signal).toBe(signal);

          return output("4\n", "model notice\n");
        },
      },
      env,
      signal,
    );

    expect(result.stdoutText()).toBe("4\n");
    expect(stdout).toHaveBeenCalledWith("4\n");
    expect(stderr).toHaveBeenCalledWith("model notice\n");
    expect(calls).toEqual([
      {
        command: { kind: "argv", argv: [OPENCODE, "run", "--pure", "What is 2 + 2?"] },
        cwd: WORKDIR,
        env,
        deadlineSeconds: 180,
        maxOutputBytes: 65_536,
      },
    ]);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test("edit uploads the local fixture bytes and reads the changed file after execution", async () => {
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);

  const message = new Uint8Array(
    await Bun.file(new URL("./agent-edit-file/message.txt", import.meta.url)).arrayBuffer(),
  );

  const steps: string[] = [];

  try {
    const changed = await edit(
      {
        async writeFile(path, bytes) {
          steps.push("upload");
          expect(path).toBe(`${WORKDIR}/message.txt`);
          expect(new TextDecoder().decode(bytes)).toBe("Hello, NAME!\n");
        },
        async exec(input) {
          steps.push("exec");
          expect(input).toMatchObject({ cwd: WORKDIR, env, maxOutputBytes: 65_536 });

          return output("Edited message.txt\n");
        },
        async readTextFile(path, options) {
          steps.push("read");
          expect(path).toBe(`${WORKDIR}/message.txt`);
          expect(options).toEqual({ signal, maxBytes: 1024 });

          return "Hello, Sandbar!\n";
        },
      },
      env,
      signal,
      message,
    );

    expect(changed).toBe("Hello, Sandbar!\n");
    expect(steps).toEqual(["upload", "exec", "read"]);
    expect(stdout).toHaveBeenCalledWith(changed);
    expect(new TextDecoder().decode(message)).toBe("Hello, NAME!\n");
  } finally {
    stdout.mockRestore();
  }
});

test("agent failure skips readback; cleanup closes even when destruction fails", async () => {
  const error = new Error("agent execution failed");
  let read = false;
  await expect(
    edit(
      {
        async writeFile() {},
        async exec() {
          throw error;
        },
        async readTextFile() {
          read = true;

          return "";
        },
      },
      env,
      signal,
      new TextEncoder().encode("Hello, NAME!\n"),
    ),
  ).rejects.toBe(error);
  expect(read).toBe(false);
  let closed = false;
  const diagnostics = spyOn(console, "error").mockImplementation(() => {});

  try {
    await expect(
      cleanup(
        {
          async close() {
            closed = true;
          },
        },
        {
          id: "owned-sandbox",
          async destroy(options) {
            expect(options?.signal?.aborted).toBe(false);
            throw new Error("destroy uncertain");
          },
        },
        true,
      ),
    ).resolves.toBeUndefined();
    expect(closed).toBe(true);
    expect(diagnostics.mock.calls[0]?.[0]).toContain("owned-sandbox");
    await expect(
      cleanup(
        { async close() {} },
        {
          id: "owned-sandbox",
          async destroy() {
            throw new Error("destroy uncertain");
          },
        },
        false,
      ),
    ).rejects.toThrow("cleanup was not confirmed");
  } finally {
    diagnostics.mockRestore();
  }
});

test("anonymous configuration forwards no host model or sandbox credentials", () => {
  const saved = { ...process.env };

  try {
    delete process.env.OPENCODE_MODEL;
    delete process.env.OPENCODE_API_KEY_ENV;
    process.env.DAYTONA_API_KEY = "provider-secret";
    process.env.E2B_API_KEY = "provider-secret";
    process.env.ANTHROPIC_API_KEY = "unselected-secret";
    const configured = agentEnvironment();
    expect(JSON.parse(configured.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      model: "opencode/nemotron-3.5-lightning-free",
    });
    expect(configured.DAYTONA_API_KEY).toBeUndefined();
    expect(configured.E2B_API_KEY).toBeUndefined();
    expect(configured.ANTHROPIC_API_KEY).toBeUndefined();
    process.env.OPENCODE_API_KEY_ENV = "ANTHROPIC_API_KEY";
    expect(agentEnvironment().ANTHROPIC_API_KEY).toBe("unselected-secret");
    process.env.OPENCODE_API_KEY_ENV = "DAYTONA_API_KEY";
    expect(() => agentEnvironment()).toThrow("never a sandbox credential");
    expect(OPENCODE_VERSION).toBe("1.18.35");
  } finally {
    process.env = saved;
  }
});

test("upload failure prevents execution, and readback failure is preserved", async () => {
  const uploadError = new Error("upload failed");
  const readError = new Error("readback failed");
  let executed = false;
  const fixture = new TextEncoder().encode("Hello, NAME!\n");

  await expect(
    edit(
      {
        async writeFile() {
          throw uploadError;
        },
        async exec() {
          executed = true;

          return output("");
        },
        async readTextFile() {
          throw new Error("unexpected read");
        },
      },
      env,
      signal,
      fixture,
    ),
  ).rejects.toBe(uploadError);
  expect(executed).toBe(false);

  await expect(
    edit(
      {
        async writeFile() {},
        async exec() {
          return output("");
        },
        async readTextFile() {
          throw readError;
        },
      },
      env,
      signal,
      fixture,
    ),
  ).rejects.toBe(readError);
});

test("truncated capture is reported as incomplete", async () => {
  await expect(
    hello(
      {
        async exec() {
          return { ...output(""), truncated: true };
        },
      },
      env,
      signal,
    ),
  ).rejects.toThrow("captured output is incomplete");
});
