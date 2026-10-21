import { copyFile, lstat, mkdir, open, symlink, unlink, utimes, chmod } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./output";

/** One archive member. Paths are relative, `/`-separated, without a leading `./`. */
export type TarEntry =
  | { type: "directory"; path: string; mode: number; mtime: number }
  | {
      type: "file";
      path: string;
      mode: number;
      mtime: number;
      size: number;
      body: () => AsyncIterable<Uint8Array>;
    }
  | { type: "symlink"; path: string; target: string; mtime: number };

const Block = 512;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function put(header: Uint8Array, offset: number, width: number, text: string): void {
  header.set(encoder.encode(text).subarray(0, width), offset);
}

/** A pax record is `<length> <key>=<value>\n`, where the length counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bytes = encoder.encode(body).length;
  let length = bytes + String(bytes).length;

  if (String(length).length !== String(bytes).length) length = bytes + String(length).length;

  return `${length}${body}`;
}

/** Split a long name across ustar's prefix and name fields, or say it needs a pax record. */
function ustarName(path: string): { name: string; prefix: string } | null {
  if (encoder.encode(path).length <= 100) return { name: path, prefix: "" };

  for (let at = path.indexOf("/"); at > 0; at = path.indexOf("/", at + 1)) {
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);

    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100 && name)
      return { name, prefix };
  }

  return null;
}

function header(
  name: string,
  prefix: string,
  type: string,
  mode: number,
  size: number,
  mtime: number,
  link: string,
): Uint8Array {
  const block = new Uint8Array(Block);
  put(block, 0, 100, name);
  put(block, 100, 8, octal(mode & 0o777, 8));
  put(block, 108, 8, octal(0, 8));
  put(block, 116, 8, octal(0, 8));
  put(block, 124, 12, octal(size, 12));
  put(block, 136, 12, octal(Math.max(0, Math.floor(mtime)), 12));
  put(block, 148, 8, "        ");
  put(block, 156, 1, type);
  put(block, 157, 100, link);
  put(block, 257, 6, "ustar\0");
  put(block, 263, 2, "00");
  put(block, 345, 155, prefix);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);

  return block;
}

const MaxOctalSize = 0o77777777777;

/** Headers for one entry: a pax header first when a path, link or size does not fit ustar. */
function headers(entry: TarEntry): Uint8Array[] {
  const path = entry.type === "directory" ? `${entry.path}/` : entry.path;
  const link = entry.type === "symlink" ? entry.target : "";
  const size = entry.type === "file" ? entry.size : 0;
  const split = ustarName(path);
  let records = "";

  if (!split) records += paxRecord("path", path);

  if (encoder.encode(link).length > 100) records += paxRecord("linkpath", link);

  if (size > MaxOctalSize) records += paxRecord("size", String(size));
  const blocks: Uint8Array[] = [];

  if (records) {
    const data = encoder.encode(records);
    blocks.push(header("PaxHeader", "", "x", 0o644, data.length, entry.mtime, ""), pad(data));
  }

  const type = entry.type === "directory" ? "5" : entry.type === "symlink" ? "2" : "0";
  const mode = entry.type === "symlink" ? 0o777 : entry.mode;

  blocks.push(
    header(
      split?.name ?? path.slice(-100),
      split?.prefix ?? "",
      type,
      mode,
      size > MaxOctalSize ? 0 : size,
      entry.mtime,
      encoder.encode(link).length > 100 ? "" : link,
    ),
  );

  return blocks;
}

function pad(data: Uint8Array): Uint8Array {
  const length = Math.ceil(data.length / Block) * Block;

  if (length === data.length) return data;
  const padded = new Uint8Array(length);
  padded.set(data);

  return padded;
}

/** Stream entries as a POSIX tar archive (ustar, with pax records for long paths). */
export async function* tarStream(entries: AsyncIterable<TarEntry>): AsyncIterable<Uint8Array> {
  for await (const entry of entries) {
    yield* headers(entry);

    if (entry.type !== "file") continue;
    let written = 0;

    for await (const chunk of entry.body()) {
      written += chunk.length;

      if (written > entry.size)
        throw new CliError("CONFLICT", `${entry.path} grew while it was being archived`);
      yield chunk;
    }

    if (written !== entry.size)
      throw new CliError("CONFLICT", `${entry.path} shrank while it was being archived`);

    if (written % Block) yield new Uint8Array(Block - (written % Block));
  }

  yield new Uint8Array(Block * 2);
}

/** Exact-length reads over a chunk stream. */
class ByteReader {
  private pending: Uint8Array[] = [];
  private buffered = 0;
  private readonly iterator: AsyncIterator<Uint8Array>;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  /** At least one byte up to `limit`, or null at the end of the stream. */
  async some(limit: number): Promise<Uint8Array | null> {
    while (!this.buffered) {
      const next = await this.iterator.next();

      if (next.done) return null;

      if (next.value.length) {
        this.pending.push(next.value);
        this.buffered += next.value.length;
      }
    }

    const first = this.pending[0]!;

    if (first.length <= limit) {
      this.pending.shift();
      this.buffered -= first.length;

      return first;
    }

    this.pending[0] = first.subarray(limit);
    this.buffered -= limit;

    return first.subarray(0, limit);
  }

  async exactly(length: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(length);
    let filled = 0;

    while (filled < length) {
      const chunk = await this.some(length - filled);

      if (!chunk) {
        if (filled === 0) return null;
        throw truncated();
      }

      out.set(chunk, filled);
      filled += chunk.length;
    }

    return out;
  }

  async skip(length: number): Promise<void> {
    while (length > 0) {
      const chunk = await this.some(length);

      if (!chunk) throw truncated();
      length -= chunk.length;
    }
  }
}

function truncated(): CliError {
  return new CliError("INVALID_RESPONSE", "The archive from the sandbox ended early");
}

function text(block: Uint8Array, offset: number, width: number): string {
  const field = block.subarray(offset, offset + width);
  const end = field.indexOf(0);

  return decoder.decode(end < 0 ? field : field.subarray(0, end));
}

function number(block: Uint8Array, offset: number, width: number): number {
  const field = block.subarray(offset, offset + width);

  // GNU base-256: the high bit of the first byte marks a big-endian binary number.
  if (field[0]! & 0x80) {
    let value = field[0]! & 0x7f;

    for (const byte of field.subarray(1)) value = value * 256 + byte;

    return value;
  }

  const digits = text(block, offset, width).trim();

  return digits ? Number.parseInt(digits, 8) : 0;
}

function validHeader(block: Uint8Array): boolean {
  const stored = number(block, 148, 8);
  let sum = 0;

  for (let at = 0; at < Block; at++) sum += at >= 148 && at < 156 ? 32 : block[at]!;

  return sum === stored;
}

function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;

  while (at < data.length) {
    const space = data.indexOf(32, at);

    if (space < 0) break;
    const length = Number.parseInt(decoder.decode(data.subarray(at, space)), 10);

    if (!Number.isSafeInteger(length) || length <= 0 || at + length > data.length) break;
    const record = decoder.decode(data.subarray(space + 1, at + length - 1));
    const equals = record.indexOf("=");

    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }

  return records;
}

/** An archive member as read; `kind` keeps the types the extractor does not create. */
export type ReadEntry = {
  kind: "file" | "directory" | "symlink" | "hardlink" | "other";
  path: string;
  link: string;
  mode: number;
  mtime: number;
  size: number;
};

/** Read a tar stream, calling `visit` for each member; `body` must be consumed or is skipped. */
export async function readTar(
  source: AsyncIterable<Uint8Array>,
  visit: (entry: ReadEntry, body: AsyncIterable<Uint8Array>) => Promise<void>,
): Promise<void> {
  const reader = new ByteReader(source);
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax = new Map<string, string>();

  for (;;) {
    const block = await reader.exactly(Block);

    if (!block || block.every((byte) => byte === 0)) return;

    if (!validHeader(block))
      throw new CliError("INVALID_RESPONSE", "The archive from the sandbox is not a valid tar");
    const type = String.fromCharCode(block[156]!);
    const size = pax.has("size") ? Number(pax.get("size")) : number(block, 124, 12);

    if (!Number.isSafeInteger(size) || size < 0)
      throw new CliError("INVALID_RESPONSE", "The archive from the sandbox has an invalid size");
    const padding = (Block - (size % Block)) % Block;

    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (size > 1_048_576)
        throw new CliError("INVALID_RESPONSE", "The archive has an oversized metadata header");
      const data = (await reader.exactly(size)) ?? new Uint8Array();
      await reader.skip(padding);

      if (type === "x") pax = paxRecords(data);

      if (type === "L") longName = text(data, 0, data.length);

      if (type === "K") longLink = text(data, 0, data.length);
      continue;
    }

    const magic = text(block, 257, 6);
    const prefix = magic.startsWith("ustar") ? text(block, 345, 155) : "";
    const name = text(block, 0, 100);

    const entry: ReadEntry = {
      kind:
        type === "0" || type === "\0" || type === "7"
          ? "file"
          : type === "5"
            ? "directory"
            : type === "2"
              ? "symlink"
              : type === "1"
                ? "hardlink"
                : "other",
      path: pax.get("path") ?? longName ?? (prefix ? `${prefix}/${name}` : name),
      link: pax.get("linkpath") ?? longLink ?? text(block, 157, 100),
      mode: number(block, 100, 8),
      mtime: number(block, 136, 12),
      size,
    };

    pax = new Map();
    longName = undefined;
    longLink = undefined;
    let remaining = size;

    const body: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        while (remaining > 0) {
          const chunk = await reader.some(Math.min(remaining, 1_048_576));

          if (!chunk) throw truncated();
          remaining -= chunk.length;
          yield chunk;
        }
      },
    };

    await visit(entry, body);
    await reader.skip(remaining + padding);
  }
}

export type ExtractSummary = {
  files: number;
  directories: number;
  symlinks: number;
  bytes: number;
  skipped: string[];
};

/**
 * Normalize an archive path to its components: no absolute paths, no `..`, no NUL. A leading
 * `./` and trailing `/` are dropped.
 */
export function archivePath(path: string): string[] {
  if (path.includes("\0") || path.startsWith("/"))
    throw new CliError("INVALID_RESPONSE", `The archive holds an unsafe path: ${path}`);

  const parts = path.split("/").filter((part) => part !== "" && part !== ".");

  if (parts.includes(".."))
    throw new CliError("INVALID_RESPONSE", `The archive holds an unsafe path: ${path}`);

  return parts;
}

async function kind(path: string): Promise<"missing" | "file" | "directory" | "symlink" | "other"> {
  try {
    const info = await lstat(path);

    return info.isSymbolicLink()
      ? "symlink"
      : info.isDirectory()
        ? "directory"
        : info.isFile()
          ? "file"
          : "other";
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return "missing";
    throw cause;
  }
}

/**
 * Write archive members under `root` without ever following a link: every parent below `root`
 * must be a real directory, and an existing link at a member's own path is replaced, not
 * written through. Modes keep only permission bits; owners are not restored.
 */
export class Extractor {
  readonly summary: ExtractSummary = {
    files: 0,
    directories: 0,
    symlinks: 0,
    bytes: 0,
    skipped: [],
  };
  private readonly checked = new Set<string>();
  private readonly modes: { path: string; mode: number }[] = [];

  constructor(
    private readonly root: string,
    private readonly noClobber: boolean,
  ) {}

  /** The local path for archive components, after checking its parents are safe to write in. */
  private async target(parts: string[]): Promise<string> {
    let current = this.root;

    for (const part of parts.slice(0, -1)) {
      current = join(current, part);

      if (this.checked.has(current)) continue;
      const found = await kind(current);

      if (found === "missing") await mkdir(current, { mode: 0o755 });
      else if (found !== "directory")
        throw new CliError(
          "CONFLICT",
          found === "symlink"
            ? `Refusing to write through the link ${current}`
            : `${current} exists and is not a directory`,
        );
      this.checked.add(current);
    }

    return parts.length ? join(current, parts.at(-1)!) : this.root;
  }

  /** Make room for a new file or link at `path`, honoring --no-clobber. */
  private async clear(path: string): Promise<void> {
    const found = await kind(path);

    if (found === "missing") return;

    if (found === "directory")
      throw new CliError("CONFLICT", `${path} is a directory; cannot replace it with a file`);

    if (this.noClobber)
      throw new CliError("CONFLICT", `${path} already exists`, "drop --no-clobber to overwrite it");
    await unlink(path);
  }

  async add(
    entry: ReadEntry,
    parts: string[],
    body: AsyncIterable<Uint8Array>,
    resolve: (link: string) => string[],
  ): Promise<void> {
    const path = await this.target(parts);

    if (entry.kind === "directory") {
      const found = await kind(path);

      if (found === "missing") {
        // Owner write access until the end, so children can be created; the mode follows later.
        await mkdir(path, { mode: (entry.mode & 0o777) | 0o700 });
        this.modes.push({ path, mode: entry.mode & 0o777 });
      } else if (found !== "directory")
        throw new CliError("CONFLICT", `${path} exists and is not a directory`);
      this.checked.add(path);
      this.summary.directories++;

      return;
    }

    if (entry.kind === "file") {
      await this.clear(path);
      const handle = await open(path, "wx", entry.mode & 0o777);

      try {
        for await (const chunk of body) {
          await handle.write(chunk);
          this.summary.bytes += chunk.length;
        }
      } finally {
        await handle.close();
      }

      await utimes(path, entry.mtime, entry.mtime);
      this.summary.files++;

      return;
    }

    if (entry.kind === "symlink") {
      await this.clear(path);
      await symlink(entry.link, path);
      this.summary.symlinks++;

      return;
    }

    if (entry.kind === "hardlink") {
      // A hard link becomes a copy of a regular file extracted earlier from the same archive.
      const source = await this.target(resolve(entry.link));

      if ((await kind(source)) !== "file")
        throw new CliError("INVALID_RESPONSE", `The archive links ${entry.path} to a non-file`);
      await this.clear(path);
      await copyFile(source, path);
      this.summary.files++;

      return;
    }

    this.summary.skipped.push(entry.path);
  }

  /** Apply directory modes deepest first, after their contents are written. */
  async finish(): Promise<ExtractSummary> {
    for (const { path, mode } of this.modes.reverse()) await chmod(path, mode);

    return this.summary;
  }
}
