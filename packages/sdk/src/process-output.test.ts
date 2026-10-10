import { expect, spyOn, test } from "bun:test";
import type { ProcessOutput, ProcessOutputBytes } from "sandbar-adapter";
import { createProcessTail, readProcessLines } from "./process-output";

const encode = (text: string) => new TextEncoder().encode(text);

async function* output(chunks: ProcessOutputBytes[]) {
  yield* chunks;
}

test("process lines decode split UTF-8 and CRLF independently, with final partial lines", async () => {
  const lines = [];

  for await (const line of readProcessLines(
    output([
      { stream: "stdout", bytes: Uint8Array.of(0xe2) },
      { stream: "stderr", bytes: encode("error\r") },
      { stream: "stdout", bytes: Uint8Array.of(0x82, 0xac, 13) },
      { stream: "stderr", bytes: encode("\nlast") },
      { stream: "stdout", bytes: encode("\nnext") },
    ]),
  ))
    lines.push(line);

  expect(lines).toEqual([
    { stream: "stderr", text: "error", partial: false, truncated: false },
    { stream: "stdout", text: "€", partial: false, truncated: false },
    { stream: "stderr", text: "last", partial: true, truncated: false },
    { stream: "stdout", text: "next", partial: true, truncated: false },
  ]);
});

test("oversized lines clip at code points and discard until newline without losing later lines", async () => {
  const lines = [];

  for await (const line of readProcessLines(
    output([
      { stream: "stdout", bytes: encode("a€€" + "x".repeat(32 * 1024 * 1024)) },
      { stream: "stdout", bytes: encode("\nok\n") },
      { stream: "stderr", bytes: Uint8Array.of(255) },
    ]),
    { maxLineBytes: 4 },
  ))
    lines.push(line);

  expect(lines).toEqual([
    { stream: "stdout", text: "a€", partial: false, truncated: true },
    { stream: "stdout", text: "ok", partial: false, truncated: false },
    { stream: "stderr", text: "�", partial: true, truncated: false },
  ]);
});

test("line abort promptly releases quiet output without awaiting a stalled iterator return", async () => {
  let returns = 0;
  let reads = 0;
  const cancel = new AbortController();

  const source = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          reads++;

          return new Promise<IteratorResult<ProcessOutputBytes>>(() => {});
        },
        return: () => {
          returns++;

          return new Promise<IteratorResult<ProcessOutputBytes>>(() => {});
        },
      };
    },
  };

  const lines = readProcessLines(source, { signal: cancel.signal });
  const pending = lines.next();
  await Bun.sleep(0);
  cancel.abort();
  await expect(pending).rejects.toMatchObject({ code: "WAIT_ABORTED" });
  expect(reads).toBe(1);
  expect(returns).toBe(1);

  const aborted = readProcessLines(source, { signal: cancel.signal });
  await expect(aborted.next()).rejects.toMatchObject({ code: "WAIT_ABORTED" });
  expect(reads).toBe(1);
});

test.each(["text", "bytes"] as const)(
  "line abort stops remaining lines in one %s frame and releases the source",
  async (format) => {
    const cancel = new AbortController();
    let reads = 0;
    let returns = 0;
    const text = "first\nsecond\nlast";

    const source: AsyncIterable<ProcessOutput | ProcessOutputBytes> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            reads++;

            return {
              done: false,
              value:
                format === "bytes"
                  ? { stream: "stdout", bytes: encode(text) }
                  : { stream: "stdout", text },
            };
          },
          async return() {
            returns++;

            return { done: true, value: undefined };
          },
        };
      },
    };

    const lines = readProcessLines(source, { signal: cancel.signal });
    expect(await lines.next()).toMatchObject({ value: { text: "first", partial: false } });
    cancel.abort();
    await expect(lines.next()).rejects.toMatchObject({ code: "WAIT_ABORTED" });
    expect(reads).toBe(1);
    expect(returns).toBe(1);
  },
);

test.each(["text", "bytes"] as const)(
  "line abort stops remaining final partial lines from %s output",
  async (format) => {
    const cancel = new AbortController();
    let reads = 0;
    let returns = 0;
    const streams = ["stdout", "stderr"] as const;

    const source: AsyncIterable<ProcessOutput | ProcessOutputBytes> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const stream = streams[reads++];

            if (!stream) return { done: true, value: undefined };

            return {
              done: false,
              value:
                format === "bytes" ? { stream, bytes: encode(stream) } : { stream, text: stream },
            };
          },
          async return() {
            returns++;

            return { done: true, value: undefined };
          },
        };
      },
    };

    const lines = readProcessLines(source, { signal: cancel.signal });
    expect(await lines.next()).toMatchObject({ value: { text: "stdout", partial: true } });
    cancel.abort();
    await expect(lines.next()).rejects.toMatchObject({ code: "WAIT_ABORTED" });
    expect(reads).toBe(3);
    expect(returns).toBe(1);
  },
);

test("tail snapshots are bounded, independent and immediately available during quiet output", () => {
  const tail = createProcessTail({ maxBytes: 8, maxChunks: 2, maxLines: 2, maxLineBytes: 4 });
  expect(tail.snapshot()).toEqual({ lines: [], truncated: false });
  const bytes = encode("a\nb\n");
  tail.push({ stream: "stdout", bytes });
  bytes.fill(255);
  tail.push({ stream: "stderr", text: "c\n" });
  const snapshot = tail.snapshot();
  expect(snapshot).toEqual({
    lines: [
      { stream: "stdout", text: "b", partial: false, truncated: false },
      { stream: "stderr", text: "c", partial: false, truncated: false },
    ],
    truncated: true,
  });
  snapshot.lines[0]!.text = "changed";
  expect(tail.snapshot().lines[0]!.text).toBe("b");
  tail.push({ stream: "stdout", text: "0123456789" });
  expect(tail.snapshot()).toEqual({
    lines: [{ stream: "stdout", text: "2345", partial: true, truncated: true }],
    truncated: true,
  });
});

test("tail preserves decoder boundaries in retained chunks and reports chunk eviction", () => {
  const tail = createProcessTail({ maxBytes: 16, maxChunks: 2 });
  tail.push({ stream: "stdout", bytes: Uint8Array.of(0xe2) });
  tail.push({ stream: "stdout", bytes: Uint8Array.of(0x82, 0xac) });
  expect(tail.snapshot()).toEqual({
    lines: [{ stream: "stdout", text: "€", partial: true, truncated: false }],
    truncated: false,
  });
  tail.push({ stream: "stderr", text: "x" });
  expect(tail.snapshot().truncated).toBe(true);
  expect(tail.snapshot().lines.length).toBe(2);
});

test("tail and line limits reject invalid bounds and malformed chunks", async () => {
  for (const value of [0, -1, NaN, 1.2, 1_048_577])
    expect(() => createProcessTail({ maxBytes: value })).toThrow();

  expect(() => createProcessTail({ maxBytes: 4, maxLineBytes: 5 })).toThrow();
  // SAFETY: Deliberately malformed runtime input exercises validation at this public boundary.
  expect(() => createProcessTail().push({ stream: "other", text: "x" } as never)).toThrow();
  await expect(readProcessLines(output([]), { maxLineBytes: 0 }).next()).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("large custom text frames are encoded in bounded sections and tails encode only a suffix", async () => {
  const original = TextEncoder.prototype.encode;
  let largest = 0;

  const spy = spyOn(TextEncoder.prototype, "encode").mockImplementation(function (text) {
    largest = Math.max(largest, (text ?? "").length);

    return original.call(this, text);
  });

  try {
    const text = "x".repeat(32 * 1024 * 1024);
    const tail = createProcessTail({ maxBytes: 8 });
    tail.push({ stream: "stdout", text });
    expect(tail.snapshot()).toEqual({
      lines: [{ stream: "stdout", text: "xxxxxxxx", partial: true, truncated: false }],
      truncated: true,
    });

    async function* chunks() {
      yield { stream: "stdout" as const, text };
    }

    const lines = [];

    for await (const line of readProcessLines(chunks(), { maxLineBytes: 8 })) lines.push(line);
    expect(lines).toEqual([{ stream: "stdout", text: "xxxxxxxx", partial: true, truncated: true }]);
    expect(largest).toBeLessThanOrEqual(4096);
  } finally {
    spy.mockRestore();
  }
});

test("CRLF terminators do not count against an exactly fitting line budget", async () => {
  const lines = [];

  for await (const line of readProcessLines(
    output([
      { stream: "stdout", bytes: encode("a€\r") },
      { stream: "stdout", bytes: encode("\nx\r") },
    ]),
    { maxLineBytes: 4 },
  ))
    lines.push(line);

  expect(lines).toEqual([
    { stream: "stdout", text: "a€", partial: false, truncated: false },
    { stream: "stdout", text: "x\r", partial: true, truncated: false },
  ]);
});
