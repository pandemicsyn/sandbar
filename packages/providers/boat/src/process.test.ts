import { afterEach, expect, test } from "bun:test";
import { Sandbar } from "sandbar-sdk";
import { createBoatAdapter } from "./adapter";
import { boatFixture } from "./fixture.test-support";

const fixtures: ReturnType<typeof boatFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

async function setup() {
  const fixture = boatFixture();
  fixtures.push(fixture);

  const client = await Sandbar.connect({
    adapter: createBoatAdapter({ fetch: fixture.fetch, pollIntervalMs: 1, settleSeconds: 1 }),
    config: { network: "internet" },
    credentials: { apiKey: "fixture-main" },
  });

  return { fixture, client, box: await client.sandboxes.create() };
}

const streamed = (fixture: ReturnType<typeof boatFixture>) =>
  fixture.calls.filter((call) => /\/commands\/\d+\/stream$/.test(call.path));

test("detached command text streams before exit and reattaches from offsets", async () => {
  const { fixture, client, box } = await setup();

  try {
    fixture.attaches.push(
      {
        frames: [
          { type: "attached", processId: 100, stdoutOffset: 0, stderrOffset: 0 },
          { type: "stdout", data: "héllo ", nextOffset: 7 },
          { type: "stderr", data: "warn", nextOffset: 4 },
          { type: "heartbeat" },
          { type: "reconnect", stdoutOffset: 7, stderrOffset: 4 },
        ],
      },
      {
        frames: [{ type: "attached", processId: 100, stdoutOffset: 7, stderrOffset: 4 }],
        hold: true,
      },
    );

    const process = await box.processes.start({
      command: { kind: "argv", argv: ["make", "it's"] },
      cwd: "/home/user/repo",
      env: { CI: "1" },
      output: { mode: "stream" },
    });

    expect(fixture.commands.at(-1)).toBe(
      "(cd -- '/home/user/repo' && exec env -- 'CI=1' 'make' 'it'\\''s') </dev/null",
    );
    expect(
      fixture.calls.find((call) => call.method === "POST" && call.path.endsWith("/commands"))?.body,
    ).toMatchObject({ detached: true });

    let text = "";
    let exited = false;

    void process.wait().then(() => {
      exited = true;
    });

    for await (const chunk of process.output()) {
      text += `${chunk.stream}:${chunk.text}|`;

      if (text === "stdout:héllo |stderr:warn|") {
        expect(exited).toBe(false);
        void (async () => {
          // Release once the adapter has reattached after the reconnect line.
          while (!fixture.attachHeld) await new Promise((resolve) => setTimeout(resolve, 5));
          fixture.releaseAttach([
            { type: "stdout", data: "world", nextOffset: 12 },
            { type: "exit", status: "exited", exitCode: 3, stdoutOffset: 12, stderrOffset: 4 },
          ]);
        })();
      }
    }

    expect(text).toBe("stdout:héllo |stderr:warn|stdout:world|");
    expect(await process.wait()).toEqual({ exitCode: 3, outputComplete: true });
    expect(fixture.attachQueries).toEqual([
      "?stdoutOffset=0&stderrOffset=0",
      "?stdoutOffset=7&stderrOffset=4",
    ]);
    expect(streamed(fixture).every((call) => call.headers.get("authorization"))).toBe(true);
    await process.detach();
  } finally {
    await client.close();
  }
});

test("a dropped connection reattaches; a signal exit maps to 128 plus its number", async () => {
  const { fixture, client, box } = await setup();

  try {
    fixture.attaches.push({ frames: [{ type: "stdout", data: "a", nextOffset: 1 }] }, "cut", {
      frames: [{ type: "exit", status: "killed", exitCode: null, signal: "SIGTERM" }],
    });

    const process = await box.processes.start({
      command: { kind: "shell", script: "long-job" },
      output: { mode: "stream" },
    });

    let text = "";

    for await (const chunk of process.output()) text += chunk.text;

    expect(text).toBe("a");
    expect((await process.wait()).exitCode).toBe(143);
    expect(fixture.attachQueries.at(-1)).toBe("?stdoutOffset=1&stderrOffset=0");
    await process.detach();
  } finally {
    await client.close();
  }
}, 10_000);

test("terminate stops the detached command by process id", async () => {
  const { fixture, client, box } = await setup();

  try {
    fixture.attaches.push({ frames: [{ type: "stdout", data: "x", nextOffset: 1 }], hold: true });

    const process = await box.processes.start({
      command: { kind: "argv", argv: ["sleep", "600"] },
      output: { mode: "stream" },
    });

    expect((await process.terminate()).status).toBe("requested");
    expect(fixture.stopped).toEqual([100]);
    fixture.releaseAttach([{ type: "exit", status: "killed", exitCode: null, signal: "SIGKILL" }]);
    expect((await process.wait()).exitCode).toBe(137);
    await process.detach();
  } finally {
    await client.close();
  }
});

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
