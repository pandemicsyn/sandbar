import { afterEach, expect, test } from "bun:test";
import { Sandbar } from "sandbar-sdk";
import { createBoxdAdapter } from "./adapter";
import { boxdFixture } from "./fixture.test-support";

const fixtures: Awaited<ReturnType<typeof boxdFixture>>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

async function setup() {
  const fixture = await boxdFixture();
  fixtures.push(fixture);

  const client = await Sandbar.connect({
    adapter: createBoxdAdapter(fixture.factory),
    config: { org: "main", network: "internet" },
    credentials: { apiKey: "fixture-main" },
  });

  return { fixture, client, box: await client.sandboxes.create() };
}

const execCalls = (fixture: Awaited<ReturnType<typeof boxdFixture>>) =>
  fixture.calls.filter((call) => call.method === "Exec").length;

test("byte output streams per stream before the command exits", async () => {
  const { fixture, client, box } = await setup();

  try {
    fixture.execFrames([
      { data: Uint8Array.of(0, 255), exitCode: 0 },
      { data: Uint8Array.of(128), exitCode: 0, isStderr: true },
      { data: Uint8Array.of(7), exitCode: 3 },
    ]);
    fixture.holdExec();

    const process = await box.processes.start({
      command: { kind: "argv", argv: ["make", "test"] },
      output: { mode: "stream", format: "bytes" },
    });

    let exited = false;
    void process.wait().then(() => {
      exited = true;
    });
    const seen: { stream: string; bytes: number[] }[] = [];

    for await (const chunk of process.output()) {
      seen.push({ stream: chunk.stream, bytes: [...chunk.bytes] });

      if (seen.length === 3) {
        // Every frame arrived while the command was still running.
        expect(exited).toBe(false);
        fixture.releaseExec();
      }
    }

    expect(seen).toEqual([
      { stream: "stdout", bytes: [0, 255] },
      { stream: "stderr", bytes: [128] },
      { stream: "stdout", bytes: [7] },
    ]);
    expect(await process.wait()).toEqual({ exitCode: 3, outputComplete: true });
    expect(fixture.calls.filter((call) => call.method === "Exec").at(-1)?.request).toMatchObject({
      command: "make test",
    });
    await process.detach();
  } finally {
    await client.close();
  }
});

test("text output decodes UTF-8 split across frames", async () => {
  const { fixture, client, box } = await setup();

  try {
    const bytes = new TextEncoder().encode("héllo");
    fixture.execFrames([
      { data: bytes.subarray(0, 2), exitCode: 0 },
      { data: bytes.subarray(2), exitCode: 0 },
    ]);

    const process = await box.processes.start({
      command: { kind: "shell", script: "echo héllo" },
      output: { mode: "stream" },
    });

    let text = "";

    for await (const chunk of process.output()) text += chunk.text;

    expect(text).toBe("héllo");
    expect(await process.wait()).toEqual({ exitCode: 0, outputComplete: true });
    await process.detach();
  } finally {
    await client.close();
  }
});

test("terminate cancels the native call, which ends the command", async () => {
  const { fixture, client, box } = await setup();

  try {
    fixture.execFrames([{ data: new TextEncoder().encode("running"), exitCode: 0 }]);
    fixture.holdExec();

    const process = await box.processes.start({
      command: { kind: "argv", argv: ["sleep", "600"] },
      output: { mode: "stream", format: "bytes" },
    });

    const first = await process.output()[Symbol.asyncIterator]().next();
    expect(new TextDecoder().decode(first.value?.bytes)).toBe("running");
    expect((await process.terminate()).status).toBe("requested");

    for (let attempt = 0; attempt < 50 && fixture.execCancelled === 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fixture.execCancelled).toBe(1);
    await expect(process.wait()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await process.detach();
  } finally {
    await client.close();
  }
});

test("callback exec streams text and returns the bounded byte capture", async () => {
  const { fixture, client, box } = await setup();

  try {
    fixture.execFrames([
      { data: new TextEncoder().encode("abc"), exitCode: 0 },
      { data: new TextEncoder().encode("de"), exitCode: 0, isStderr: true },
    ]);

    const chunks: string[] = [];

    const result = await box.exec(
      { command: { kind: "argv", argv: ["build"] }, maxOutputBytes: 4 },
      { onOutput: (chunk) => void chunks.push(`${chunk.stream}:${chunk.text}`) },
    );

    expect(chunks).toEqual(["stdout:abc", "stderr:de"]);
    expect(new TextDecoder().decode(result.stdout)).toBe("abc");
    expect(new TextDecoder().decode(result.stderr)).toBe("d");
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBe(0);
  } finally {
    await client.close();
  }
});

test("incremental stdin is refused before any command runs", async () => {
  const { fixture, client, box } = await setup();

  try {
    const before = execCalls(fixture);

    await expect(
      box.processes.start({
        command: { kind: "argv", argv: ["cat"] },
        stdin: "pipe",
        output: { mode: "stream" },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(execCalls(fixture)).toBe(before);
  } finally {
    await client.close();
  }
});
