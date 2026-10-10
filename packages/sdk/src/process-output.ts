import type { ProcessOutput, ProcessOutputBytes } from "sandbar-adapter";
import { z } from "zod";
import { SandbarError, raceAbort } from "./resource";

export type ProcessLine = {
  stream: "stdout" | "stderr";
  text: string;
  /** No newline has been observed for this line. */
  partial: boolean;
  /** The line exceeded its byte limit and its remainder was discarded. */
  truncated: boolean;
};

export type ProcessLineOptions = { maxLineBytes?: number; signal?: AbortSignal };

export type ProcessTailOptions = {
  maxBytes?: number;
  maxChunks?: number;
  maxLines?: number;
  maxLineBytes?: number;
};

export interface ProcessTail {
  push(chunk: ProcessOutput | ProcessOutputBytes): void;
  /** A bounded, independent snapshot; quiet processes return immediately. */
  snapshot(): { lines: ProcessLine[]; truncated: boolean };
}

const encoder = new TextEncoder();

function limit(value: number | undefined, fallback: number, ceiling: number): number {
  const result = value ?? fallback;

  if (!Number.isSafeInteger(result) || result < 1 || result > ceiling)
    throw new SandbarError("INVALID_ARGUMENT", "Invalid process output helper limit");

  return result;
}

const Chunk = z.union([
  z.object({ stream: z.enum(["stdout", "stderr"]), bytes: z.instanceof(Uint8Array) }),
  z.object({ stream: z.enum(["stdout", "stderr"]), text: z.string() }),
]);

function parseChunk(chunk: ProcessOutput | ProcessOutputBytes): z.infer<typeof Chunk> {
  const parsed = Chunk.safeParse(chunk);

  if (!parsed.success) throw new SandbarError("INVALID_ARGUMENT", "Invalid process output chunk");

  return parsed.data;
}

function* encoded(text: string): Generator<Uint8Array> {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 4096, text.length);
    const last = text.charCodeAt(end - 1);

    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield encoder.encode(text.slice(offset, end));
    offset = end;
  }
}

class Lines {
  private readonly streams = {
    stdout: {
      decoder: new TextDecoder(),
      text: "",
      bytes: 0,
      truncated: false,
      order: 0,
      cr: false,
    },
    stderr: {
      decoder: new TextDecoder(),
      text: "",
      bytes: 0,
      truncated: false,
      order: 0,
      cr: false,
    },
  };
  private order = 0;

  constructor(private readonly maxLineBytes: number) {}

  private append(stream: "stdout" | "stderr", character: string): void {
    const state = this.streams[stream];

    if (state.truncated) return;
    const bytes = encoder.encode(character).byteLength;

    if (state.bytes + bytes > this.maxLineBytes) state.truncated = true;
    else {
      state.text += character;
      state.bytes += bytes;
    }
  }

  private *text(stream: "stdout" | "stderr", text: string): Generator<ProcessLine> {
    const state = this.streams[stream];

    for (const character of text) {
      state.order = ++this.order;

      if (state.cr && character !== "\n") this.append(stream, "\r");
      state.cr = false;

      if (character === "\r") state.cr = true;
      else if (character === "\n") {
        yield { stream, text: state.text, partial: false, truncated: state.truncated };
        state.text = "";
        state.bytes = 0;
        state.truncated = false;
      } else this.append(stream, character);
    }
  }

  *feed(stream: "stdout" | "stderr", bytes: Uint8Array): Generator<ProcessLine> {
    // Decode bounded sections even when an independently authored source supplies a large frame.
    for (let offset = 0; offset < bytes.length; offset += 4096)
      yield* this.text(
        stream,
        this.streams[stream].decoder.decode(bytes.subarray(offset, offset + 4096), {
          stream: true,
        }),
      );
  }

  *finish(): Generator<ProcessLine> {
    for (const stream of ["stdout", "stderr"] as const)
      yield* this.text(stream, this.streams[stream].decoder.decode());

    for (const stream of ["stdout", "stderr"] as const)
      if (this.streams[stream].cr) {
        this.append(stream, "\r");
        this.streams[stream].cr = false;
      }

    const pending = (["stdout", "stderr"] as const)
      .filter((stream) => this.streams[stream].text || this.streams[stream].truncated)
      .sort((left, right) => this.streams[left].order - this.streams[right].order);

    for (const stream of pending) {
      const state = this.streams[stream];

      yield { stream, text: state.text, partial: true, truncated: state.truncated };
    }
  }
}

/** Incremental UTF-8 lines, independently decoded per stream; oversized lines are clipped, not buffered. */
export async function* readProcessLines(
  output: AsyncIterable<ProcessOutput | ProcessOutputBytes>,
  options: ProcessLineOptions = {},
): AsyncGenerator<ProcessLine> {
  const lines = new Lines(limit(options.maxLineBytes, 16_384, 1_048_576));
  const iterator = output[Symbol.asyncIterator]();
  const signal = options.signal ?? new AbortController().signal;

  function* observe(source: Generator<ProcessLine>): Generator<ProcessLine> {
    for (const line of source) {
      if (signal.aborted)
        throw new SandbarError("WAIT_ABORTED", "Process line observation stopped");
      yield line;

      if (signal.aborted)
        throw new SandbarError("WAIT_ABORTED", "Process line observation stopped");
    }
  }

  try {
    while (true) {
      if (signal.aborted)
        throw new SandbarError("WAIT_ABORTED", "Process line observation stopped");

      const next = await raceAbort(
        Promise.resolve().then(() => iterator.next()),
        signal,
      );

      if (next.done) break;

      const chunk = parseChunk(next.value);

      if ("bytes" in chunk) yield* observe(lines.feed(chunk.stream, chunk.bytes));
      else for (const bytes of encoded(chunk.text)) yield* observe(lines.feed(chunk.stream, bytes));
    }

    yield* observe(lines.finish());
  } catch (error) {
    if (signal.aborted) throw new SandbarError("WAIT_ABORTED", "Process line observation stopped");

    throw error;
  } finally {
    // Iterator return has the source's ordinary output-only disposal semantics. Never await a stalled source.
    try {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    } catch {
      /* Best effort local output release. */
    }
  }
}

/** Keep a rolling diagnostic byte window, never a cumulative process transcript. */
export function createProcessTail(options: ProcessTailOptions = {}): ProcessTail {
  const maxBytes = limit(options.maxBytes, 65_536, 1_048_576);
  const maxChunks = limit(options.maxChunks, 256, 4096);
  const maxLines = limit(options.maxLines, 200, 4096);
  const maxLineBytes = limit(options.maxLineBytes, Math.min(16_384, maxBytes), maxBytes);
  const chunks: ProcessOutputBytes[] = [];
  let retained = 0;
  let truncated = false;

  return {
    push(chunk) {
      const parsed = parseChunk(chunk);
      // UTF-8 has at least one byte per UTF-16 code unit. Encode only a bounded suffix for diagnostics.
      const bytes = "bytes" in parsed ? parsed.bytes : encoder.encode(parsed.text.slice(-maxBytes));
      truncated ||= "text" in parsed && parsed.text.length > maxBytes;

      if (!bytes.byteLength) return;

      const keep = new Uint8Array(bytes.subarray(Math.max(0, bytes.byteLength - maxBytes)));
      truncated ||= keep.length < bytes.length;
      chunks.push({ stream: chunk.stream, bytes: keep });
      retained += keep.length;

      while (chunks.length > maxChunks || retained > maxBytes) {
        const first = chunks[0]!;
        const excess = retained - maxBytes;

        if (chunks.length <= maxChunks && excess > 0 && excess < first.bytes.length) {
          first.bytes = new Uint8Array(first.bytes.subarray(excess));
          retained -= excess;
        } else retained -= chunks.shift()!.bytes.length;

        truncated = true;
      }
    },
    snapshot() {
      const decoder = new Lines(maxLineBytes);
      const result: ProcessLine[] = [];
      let size = 0;
      let clipped = truncated;

      const append = (line: ProcessLine) => {
        result.push(line);
        size += encoder.encode(line.text).length;
        clipped ||= line.truncated;

        while (result.length > maxLines || size > maxBytes) {
          size -= encoder.encode(result.shift()!.text).length;
          clipped = true;
        }
      };

      for (const chunk of chunks)
        for (const line of decoder.feed(chunk.stream, chunk.bytes)) append(line);

      for (const line of decoder.finish()) append(line);

      return { lines: result, truncated: clipped };
    },
  };
}
