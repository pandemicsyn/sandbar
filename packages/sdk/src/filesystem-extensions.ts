import type { DirectoryResult, FileEntry } from "sandbar-adapter";
import { byteLimit, type FileStreamOptions } from "./file-transfer";
import { SandbarError, type ReadOptions } from "./resource";

export type WalkFilesOptions = ReadOptions & {
  maxDepth?: number;
  maxEntries?: number;
  /** Exact root-relative paths to omit, including their descendants. */
  exclude?: readonly string[];
};

export type WalkFileEntry = FileEntry & {
  path: string;
  relativePath: string;
  /** Immediate children have depth 1; the root is not emitted. */
  depth: number;
};

export type ReadTextLinesOptions = FileStreamOptions & {
  /** UTF-8 bytes per line, excluding LF and its preceding CR; defaults to 1 MiB. */
  maxLineBytes?: number;
};

export function walkFiles(
  root: string,
  read: (path: string) => Promise<DirectoryResult>,
  check: () => void,
  options: WalkFilesOptions,
): AsyncIterable<WalkFileEntry> {
  const maxDepth = options.maxDepth ?? 32;
  const maxEntries = options.maxEntries ?? 10_000;

  for (const value of [maxDepth, maxEntries])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new SandbarError("INVALID_ARGUMENT", "Traversal limits must be positive safe integers");

  if (
    options.exclude !== undefined &&
    (!Array.isArray(options.exclude) ||
      options.exclude.some(
        (path) =>
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate JavaScript exclusion paths before string operations.
          typeof path !== "string" ||
          !path ||
          path.includes("\0") ||
          path.split("/").some((part) => !part || part === "." || part === ".."),
      ))
  )
    throw new SandbarError("INVALID_ARGUMENT", "Exclusions must be canonical root-relative paths");
  const excluded = new Set(options.exclude);

  return (async function* () {
    let observed = 0;

    async function* visit(
      path: string,
      relative: string,
      depth: number,
    ): AsyncGenerator<WalkFileEntry> {
      check();
      const directory = await read(path);
      check();

      if (directory.completeness !== "complete")
        throw new SandbarError("INVALID_RESPONSE", `Cannot traverse incomplete directory: ${path}`);
      observed += directory.entries.length;

      if (observed > maxEntries)
        throw new SandbarError("OUTPUT_CAPACITY", "Traversal exceeds entry budget");

      for (const entry of directory.entries) {
        check();
        const relativePath = relative ? `${relative}/${entry.name}` : entry.name;

        if (excluded.has(relativePath)) continue;
        const child = `${path === "/" ? "" : path}/${entry.name}`;
        yield { ...entry, path: child, relativePath, depth };
        check();

        if (entry.type === "directory" && depth < maxDepth)
          yield* visit(child, relativePath, depth + 1);
      }
    }

    yield* visit(root, "", 1);
  })();
}

export function readTextLines(
  source: AsyncIterable<Uint8Array>,
  check: () => void,
  options: ReadTextLinesOptions,
): AsyncIterable<string> {
  const maxLineBytes = byteLimit(options.maxLineBytes, 1_048_576)!;

  return (async function* () {
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let firstText = true;
    let parts: string[] = [];
    let length = 0;
    let lastByte = -1;

    function decode(bytes?: Uint8Array): string {
      let text = bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode();

      if (text && firstText) {
        firstText = false;

        if (text.startsWith("\uFEFF")) text = text.slice(1);
      }

      return text;
    }

    function append(bytes: Uint8Array) {
      length += bytes.length;

      if (bytes.length) lastByte = bytes[bytes.length - 1]!;

      // A final CR may become part of a CRLF delimiter in the next chunk.
      if (length > maxLineBytes && !(length === maxLineBytes + 1 && lastByte === 13))
        throw new SandbarError("OUTPUT_CAPACITY", "Text line exceeds byte limit");
      const text = decode(bytes);

      if (text) parts.push(text);
    }

    for await (const chunk of source) {
      check();
      let start = 0;

      for (let index = 0; index < chunk.length; index++) {
        if (chunk[index] !== 10) continue;
        append(chunk.subarray(start, index));
        // Feed the delimiter through the decoder too, so malformed trailing UTF-8
        // is replaced at this line boundary rather than combined with the next line.
        const boundary = decode(chunk.subarray(index, index + 1));
        parts.push(boundary.slice(0, -1));
        let line = parts.join("");

        if (lastByte === 13) line = line.slice(0, -1);
        check();
        yield line;
        check();
        parts = [];
        length = 0;
        lastByte = -1;
        start = index + 1;
      }

      append(chunk.subarray(start));
    }

    check();

    if (length > maxLineBytes)
      throw new SandbarError("OUTPUT_CAPACITY", "Text line exceeds byte limit");
    const tail = decode();

    if (tail) parts.push(tail);

    if (length) yield parts.join("");
  })();
}
