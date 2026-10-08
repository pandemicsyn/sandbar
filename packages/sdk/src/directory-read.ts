import { z } from "zod";
import {
  AdapterError,
  MAX_DIRECTORY_ENTRIES,
  MAX_DIRECTORY_NAME_BYTES,
  type FileEntry,
  type ReadContext,
} from "sandbar-adapter";
import { filesystemError } from "./file-transfer";
import { SandbarError, raceAbort, type ReadOptions } from "./resource";

const Entry = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(4096)
    .refine((name) => name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0")),
  type: z.enum(["file", "directory", "symlink", "unknown"]),
});

export function directoryResult(
  result: import("sandbar-adapter").DirectoryResult,
): import("sandbar-adapter").DirectoryResult {
  const parsed = z
    .strictObject({
      entries: z.custom<FileEntry[]>(Array.isArray),
      completeness: z.enum(["complete", "unknown"]),
      observedAt: z.iso.datetime({ offset: true }),
    })
    .safeParse(result);

  if (!parsed.success) throw new SandbarError("INVALID_RESPONSE", "Invalid directory result");

  return { ...parsed.data, entries: directoryEntries(parsed.data.entries) };
}

export function directoryEntries(entries: FileEntry[]): FileEntry[] {
  if (!Array.isArray(entries))
    throw new SandbarError("INVALID_RESPONSE", "Invalid directory listing");

  if (entries.length > MAX_DIRECTORY_ENTRIES)
    throw new SandbarError("OUTPUT_CAPACITY", "Directory exceeds 1024 entries");
  const result: FileEntry[] = [];
  const names = new Set<string>();
  let bytes = 0;

  for (const entry of entries) {
    const parsed = Entry.safeParse(entry);

    if (!parsed.success || names.has(parsed.data.name))
      throw new SandbarError("INVALID_RESPONSE", "Invalid or duplicate directory entry");
    bytes += new TextEncoder().encode(parsed.data.name).length;

    if (bytes > MAX_DIRECTORY_NAME_BYTES)
      throw new SandbarError("OUTPUT_CAPACITY", "Directory names exceed 65536 UTF-8 bytes");
    names.add(parsed.data.name);
    result.push(parsed.data);
  }

  return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** One deadline bounds the complete read, including adapter dispatch. */
export async function directoryRead<T>(
  read: (context: ReadContext) => Promise<T>,
  closed: AbortSignal,
  options: ReadOptions,
): Promise<T> {
  const controller = new AbortController();

  const cancel = () =>
    controller.abort(new SandbarError("WAIT_ABORTED", "Filesystem read cancelled"));

  const close = () => controller.abort(new SandbarError("CLIENT_CLOSED", "Client is closed"));
  const deadline = Date.now() + 30_000;

  const timer = setTimeout(
    () => controller.abort(new SandbarError("TIMEOUT", "Filesystem read timed out")),
    30_000,
  );

  options.signal?.addEventListener("abort", cancel, { once: true });
  closed.addEventListener("abort", close, { once: true });

  if (closed.aborted) close();
  else if (options.signal?.aborted) cancel();

  try {
    controller.signal.throwIfAborted();
    const value = await raceAbort(read({ signal: controller.signal, deadline }), controller.signal);
    controller.signal.throwIfAborted();

    return value;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;

    if (error instanceof AdapterError) throw filesystemError(error);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    closed.removeEventListener("abort", close);
  }
}

/** Native enumeration capacity is the same output-bound failure as a local listing limit. */
export async function directoryListingRead<T>(
  read: (context: ReadContext) => Promise<T>,
  closed: AbortSignal,
  options: ReadOptions,
): Promise<T> {
  try {
    return await directoryRead(read, closed, options);
  } catch (error) {
    if (error instanceof SandbarError && error.code === "CAPACITY")
      throw new SandbarError("OUTPUT_CAPACITY", error.message, error.effect);
    throw error;
  }
}
