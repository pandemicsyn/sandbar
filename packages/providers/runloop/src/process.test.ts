import { afterEach, expect, test } from "bun:test";
import { Sandbar } from "sandbar-sdk";
import { createRunloopAdapter } from "./adapter";
import { runloopFixture } from "./fixture.test-support";

const fixtures: ReturnType<typeof runloopFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

async function setup() {
  const fixture = runloopFixture();
  fixtures.push(fixture);

  const client = await Sandbar.connect({
    adapter: createRunloopAdapter({ fetch: fixture.fetch, pollIntervalMs: 1, settleSeconds: 1 }),
    config: { network: "internet" },
    credentials: { apiKey: "fixture-main" },
  });

  return { fixture, client, box: await client.sandboxes.create() };
}

test("log updates stream before exit and reopen from their byte offsets", async () => {
  const { fixture, client, box } = await setup();

  try {
    fixture.overrideCommands(() => ({ exitCode: 4, stdout: "héllo", stderr: "warn" }));
    // Running for one long-poll window, so each log stream closes once before exit.
    fixture.setCommandWaits(2);

    const process = await box.processes.start({
      command: { kind: "argv", argv: ["make", "it's"] },
      cwd: "/home/user/repo",
      env: { CI: "1" },
      output: { mode: "stream" },
    });

    expect(fixture.commands.at(-1)).toBe(
      "(cd -- '/home/user/repo' && exec env -- 'CI=1' 'make' 'it'\\''s') </dev/null",
    );

    let exited = false;

    void process.wait().then(() => {
      exited = true;
    });

    const seen: string[] = [];

    for await (const chunk of process.output()) {
      if (!seen.length) expect(exited).toBe(false);
      seen.push(`${chunk.stream}:${chunk.text}`);
    }

    expect([...seen].sort()).toEqual(["stderr:warn", "stdout:héllo"]);
    expect(await process.wait()).toEqual({ exitCode: 4, outputComplete: true });
    // "héllo" is 6 bytes: reopened streams ask for what follows, never a repeat.
    expect(fixture.logQueries).toContain("stdout@6");
    expect(fixture.logQueries).toContain("stderr@4");
    await process.detach();
  } finally {
    await client.close();
  }
}, 10_000);

test("a dropped log connection reopens from its offset", async () => {
  const { fixture, client, box } = await setup();

  try {
    fixture.overrideCommands(() => ({ exitCode: 0, stdout: "done", stderr: "" }));
    fixture.failNext(/GET .*stream_stdout_updates/, "lost");

    const process = await box.processes.start({
      command: { kind: "shell", script: "build" },
      output: { mode: "stream" },
    });

    let text = "";

    for await (const chunk of process.output()) text += chunk.text;

    expect(text).toBe("done");
    expect(await process.wait()).toEqual({ exitCode: 0, outputComplete: true });
    await process.detach();
  } finally {
    await client.close();
  }
}, 10_000);

test("terminate kills the execution", async () => {
  const { fixture, client, box } = await setup();

  try {
    fixture.overrideCommands(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    fixture.setCommandWaits(1000);

    const process = await box.processes.start({
      command: { kind: "argv", argv: ["sleep", "600"] },
      output: { mode: "stream" },
    });

    expect((await process.terminate()).status).toBe("requested");
    expect(fixture.count("POST", /\/executions\/[^/]+\/kill$/)).toBe(1);
    expect((await process.wait()).exitCode).toBe(137);
    await process.detach();
  } finally {
    await client.close();
  }
}, 10_000);

test("byte output, piped stdin and callback exec are refused before any command runs", async () => {
  const { fixture, client, box } = await setup();

  try {
    const before = fixture.commands.length;

    await expect(
      box.processes.start({
        command: { kind: "argv", argv: ["cat"] },
        output: { mode: "stream", format: "bytes" },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      box.processes.start({
        command: { kind: "argv", argv: ["cat"] },
        stdin: "pipe",
        output: { mode: "stream" },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      box.exec({ command: { kind: "argv", argv: ["true"] } }, { onOutput: () => undefined }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fixture.commands.length).toBe(before);
  } finally {
    await client.close();
  }
});
