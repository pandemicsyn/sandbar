---
title: Files and output
description: Read and write sandbox files, transfer large files, and use command output safely.
---

## Write and read text

Use `writeTextFile` and `readTextFile` to work with UTF-8 text. This example connects with E2B; use your chosen adapter and a writable directory in its sandbox:

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { e2b } from "@sandbar-sdk/e2b";

const client = await Sandbar.connect(e2b({ apiKey: process.env.E2B_API_KEY! }));
try {
  const box = await client.sandboxes.create({ environment: Image.prepared("base") });
  try {
    await box.writeTextFile("/home/user/input.json", JSON.stringify({ name: "Ada" }));
    console.log(await box.readTextFile("/home/user/input.json"));
    await box.writeTextFile("/home/user/input.json", "", { overwrite: true });
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

The later snippets are separate examples to place inside the inner `try` block, before `box.destroy()`. They assume any input files and directories they read already exist.

The parent directory must already exist. Writes leave existing files alone unless you pass `{ overwrite: true }`. Empty text is valid, and these methods do not parse JSON or change line endings.

Text files use the same limits, cancellation and error handling as the byte methods below. Limits count UTF-8 bytes, which can differ from the number of characters. A read that exceeds its limit fails instead of returning part of the text. Reading replaces malformed UTF-8 with the replacement character (`�`) and removes an initial byte-order mark (BOM). Pass `{ signal }` to cancel either method. File operations do not resume a suspended sandbox.

## Write and read bytes

Use `writeFile` and `readFile` for binary data. Paths must be absolute paths inside the sandbox. This example uses E2B's `/home/user` workspace:

```ts
const path = "/home/user/sandbar-example.bin";
await box.writeFile(path, Uint8Array.of(0, 255, 129));
const bytes = await box.readFile(path);
console.log(bytes);
```

To stop waiting for a file read after five seconds, pass an abort signal:

```ts
const bytes = await box.readFile(path, { signal: AbortSignal.timeout(5000) });
```

A buffered read has a fixed **30-second deadline** for the provider response and all file data. An abort signal rejects with `WAIT_ABORTED`; the deadline rejects with `TIMEOUT`; closing the client rejects with `CLIENT_CLOSED`. Reads do not change the file, so these failures have no mutation to recover. Provider read errors keep their error code.

Sandbar stops local waiting promptly and asks the adapter to cancel the request. Provider cancellation is best effort: earlier checks may still finish. Cancelling a read does not terminate commands or change the sandbox lifetime.

Buffered reads and writes default to a **1 MiB** limit. Pass `maxBytes` to choose a limit up to **16 MiB**; your adapter may enforce a lower limit. Use the streaming methods below for larger files. The parent directory must already exist and be writable by the provider's file operations.

`overwrite` defaults to `false`: writing to an existing file fails without replacing it. To replace a file:

```ts
await box.writeFile(path, new TextEncoder().encode("updated"), { overwrite: true });
```

Daytona and E2B protect existing files by writing a temporary file first, then using a hard link to publish it at the destination. Their images need GNU-compatible `ln -T` and a filesystem that supports hard links. Check [tested provider support](/docs/providers/support/) before using a custom image.

For E2B, use `/home/user` for this workflow. Overwriting a user-owned file in the root-owned `/tmp` directory failed in live testing because of its sticky-bit permissions. Successful tests in `/home/user` do not guarantee the same behavior at every path.

## Directories and metadata

Use these methods to create directories, inspect entries, copy or move files, and remove them. This workflow is tested on Daytona and E2B sandbox filesystems; mounted storage can have different limits:

```ts
await box.makeDirectory("/home/user/job/results", { recursive: true });
await box.writeTextFile("/home/user/job/results/report.json", JSON.stringify({ ready: true }));
const directory = await box.readDirectory("/home/user/job/results");
for (const entry of directory.entries) console.log(entry.name, entry.type);
const info = await box.statFile("/home/user/job/results/report.json");
await box.copyFile("/home/user/job/results/report.json", "/home/user/job/copy.json");
await box.moveFile("/home/user/job/copy.json", "/home/user/job/final.json");
await box.removeFile("/home/user/job", { recursive: true });
```

`readDirectory` lists the immediate children, sorted by name using JavaScript string order. Each entry has `{ name, type }`, where `type` is `file`, `directory`, `symlink` or `unknown`. The result also includes an `observedAt` timestamp and `completeness`, which is `"complete"` or `"unknown"`. Unknown entry types remain in the list. A complete list is still an observation of a directory that may change while it is being read. Authentication, permission and connection errors reject the read.

`listFiles` returns only the entries and requires the adapter to provide a complete list. Neither method searches subdirectories or fetches additional pages. Both reject more than **1,024 entries** or **65,536 UTF-8 bytes across all entry names** with `OUTPUT_CAPACITY`. Invalid or duplicate entries reject with `INVALID_RESPONSE`. Sandbar does not silently shorten a list.

`statFile` returns the entry type and any available `sizeBytes`, `modifiedAt` and `mode`. Missing fields are omitted. If the path ends in a symlink, it inspects the link by default, even if the target is missing. Pass `{ followSymlinks: true }` to inspect the target. Symlinks in parent directories are followed.

`fileExists` returns `false` only when the entry is confirmed missing. Authentication, permission, unavailable compute and connection errors reject instead of returning `false`.

`makeDirectory` succeeds if the directory already exists. Pass `{ recursive: true }` to create missing parents. `removeFile` succeeds if the entry is already missing and can remove files, symlinks and empty directories. Removing a nonempty directory requires `{ recursive: true }`. Recursive removal removes symlinks themselves without walking their targets.

Directory methods normalize repeated and trailing slashes. Sandbar refuses to remove `/`. These methods do not keep access inside a particular directory: paths can still pass through symlinks in parent directories.

`copyFile` copies regular files. `moveFile` renames a file or directory within the same filesystem; it does not fall back to copying and deleting across filesystems. Both require existing parents, reject identical source and destination paths, and protect existing destinations by default. Pass `{ overwrite: true }` to replace a compatible destination.

Copying does not freeze a changing source, preserve all metadata, or guarantee durable storage. Object-backed mounts may not provide the same atomic behavior as a local Linux filesystem.

Daytona and E2B use Python 3 helpers for these directory operations. Custom images need Python 3, and moving without replacing an existing destination needs Linux `renameat2`. See the provider pages for image and transport requirements. Other adapters can reject unsupported methods with `UNSUPPORTED`.

## Large byte transfers

Use `writeFileStream` and `readFileStream` for files that are too large to keep in memory. In this example, `inputChunks` supplies byte chunks, `destination.write()` saves downloaded chunks, and `signal` is your abort signal:

```ts
const uploaded = await box.writeFileStream("/home/user/archive.bin", inputChunks, { signal });
console.log(uploaded);
for await (const chunk of box.readFileStream("/home/user/archive.bin", { signal })) {
  await destination.write(chunk);
}
```

Streaming methods have no default total-file size limit; pass `maxBytes` to set one. Sandbar splits large chunks into pieces of at most **64 KiB** and limits how much data waits in memory. Reads reject incomplete delivery. A successful write returns the confirmed byte count. Empty files and binary data are supported. Time spent processing a downloaded chunk does not count as network inactivity.

Streaming has three timeout settings:

- `setupTimeoutMs`: time to start the transfer; defaults to **30 seconds**.
- `inactivityTimeoutMs`: time without network progress; defaults to **60 seconds**.
- `overallTimeoutMs`: total transfer time; no deadline by default.

Set defaults with `transfers: { setupTimeoutMs, inactivityTimeoutMs, overallTimeoutMs }` when connecting, or override them in the options for one transfer.

An abort signal or client close stops local waiting and asks readers and input iterators to clean up. If your input iterator is waiting on its own I/O, that I/O must observe the abort signal too. JavaScript cannot interrupt an arbitrary pending iterator call. Cancellation does not undo remote work already started.

Daytona and E2B streaming writes and copies use a temporary file in the destination directory before publishing the result. With the default `overwrite: false`, publication fails if another process creates the destination during the transfer. Cleanup targets only temporary files belonging to that operation. Mounted storage may not support these guarantees; an adapter must reject unsupported requests before changing files.

A lost response does not prove that a write failed. Errors retain known changes and related temporary paths. Once publication is confirmed, a later inspection or cleanup failure keeps `effect: "applied"`; remaining temporary paths show what still needs cleanup. Do not automatically retry an uncertain write.

See the complete [artifact recipe](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/directory-files.ts) and [tested provider support](/docs/providers/support/) for the images and storage paths covered by live tests.

## Traversal and text lines

Use `walkFiles` to visit a directory tree. It yields `{ name, type, path, relativePath, depth }` for each entry, starting with the root's children at depth 1. The root itself is omitted. Entries are sorted by name within each directory, and each directory is followed by its contents before traversal continues to the next sibling. Symlinks and unknown entry types are yielded without being followed.

Every directory must have a complete listing. Unreadable directories, unknown completeness and exceeded entry limits reject the traversal instead of silently skipping data.

```ts
for await (const entry of box.walkFiles("/home/user/job", {
  maxDepth: 4,
  maxEntries: 1000,
  exclude: ["cache", "results/private.txt"],
  signal,
})) {
  console.log(entry.relativePath, entry.type);
}
for await (const line of box.readTextLines("/home/user/job/results/events.txt", {
  maxLineBytes: 1024,
  signal,
})) {
  console.log(line);
}
```

Traversal stops descending at depth **32** by default and allows **10,000 observed entries**. Set `maxDepth` and `maxEntries` to change these limits. `exclude` accepts exact paths relative to the root, such as `"cache"` or `"results/private.txt"`; it does not accept glob patterns. Paths must omit leading/trailing slashes and `.` or `..` segments. Excluding a directory skips its contents. Entries found in a listing still count toward the limit even when excluded.

Traversal does not freeze the tree while reading it or prevent paths from passing through symlinks in parent directories.

Use `readTextLines` to read a UTF-8 file one line at a time. It handles characters and Windows line endings split across chunks. Returned lines omit LF or CRLF endings; a lone CR remains in the text. A final line without a newline is returned, and a trailing newline does not add an extra empty line. Malformed UTF-8 is replaced with `�`.

The default line limit is **1 MiB of source bytes**, excluding the line ending. Larger lines reject with `OUTPUT_CAPACITY`. Set `maxLineBytes` to change it. Streaming options such as `maxBytes`, `signal` and timeout overrides also apply. These helpers require an adapter that supports directory reads and file streams, respectively. They do not add glob search, range reads or whole-tree copy.

Both helpers are covered by offline tests and the shared artifact recipe. Live tests passed on the E2B and Daytona images listed in [provider support](/docs/providers/support/); those results do not qualify every custom image or mount.

## Read command output

```ts
const result = await box.exec({
  command: { kind: "argv", argv: ["cat", path] },
  maxOutputBytes: 65_536,
});
const preview = result.stdoutPreview({ maxBytes: 4096 });
console.log(preview.text);
if (preview.shortened) console.log("Display shortened; captured bytes remain available");
if (result.truncated) console.warn("Command output was truncated");
```

Execution results keep `stdout` and `stderr` as `Uint8Array` values. Use those bytes for binary data. `stdoutText()`, `stderrText()` and the exported `outputText(bytes)` decode **all captured bytes** as UTF-8 by default.

For display, pass a byte limit such as `result.stdoutText(4096)`. If the captured bytes exceed that limit, the text ends with `…`. Display limits must be safe integers from **0 to 1,048,576**; invalid limits throw `RangeError`.

`stdoutPreview()` and `stderrPreview()` return `{ text, shortened }` and default to **16,384 input bytes**. Pass `{ maxBytes }` to change the limit. `shortened` tells you whether this preview omitted captured bytes. An empty stream or a stream exactly at the limit is not shortened. A zero limit on nonempty output returns `{ text: "…", shortened: true }`. Use the flag rather than looking for an ellipsis, which may be part of the command's own output.

Before parsing captured output, check `truncated`:

```ts
const result = await box.exec(["cat", "/home/user/report.json"]);
if (result.truncated) throw new Error("Captured report may be incomplete");
const report = JSON.parse(result.stdoutText());
console.error(result.stderrText());
```

`stdoutText({ full: true })`, `stderrText({ full: true })` and `outputText(bytes, { full: true })` also decode all captured bytes. Full decoding uses memory proportional to the output size. Text option objects allow only `full: true`; preview option objects allow only `maxBytes`. Invalid options throw `RangeError` without changing the captured result.

By default, execution captures at most **1 MiB across stdout and stderr combined**, keeping stdout first and using the remaining space for stderr. Set `maxOutputBytes` in the execution request to change that limit. `result.truncated` means the captured output may be incomplete, including when a stream reaches the limit before its end can be confirmed.

Capture limits and display limits are separate. A complete result can have a shortened preview, and an incomplete result can fit entirely in a preview. Full decoding or a larger preview cannot recover bytes that were never captured.

Text helpers replace malformed UTF-8 with `�` and remove an initial BOM. A byte limit can cut a character in half, which also produces `�`. The replacement character and added ellipsis can make the displayed text longer in bytes than the input limit.

For strict UTF-8 validation, use `new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)`. Checking `truncated` does not prove that output is valid UTF-8 or JSON, so decoding and parsing can still fail. Parse the complete captured bytes, never a shortened display string.

The same text and preview helpers are available on recovered execution results and on `NonzeroExitError.result` and `NoExitCodeError.result`.

## Supply finite command input

`box.exec` accepts a string or byte array as input, then closes the command's stdin to signal that no more data is coming:

```ts
const payload = "Ada 🌊\0";
const result = await box.exec({
  command: { kind: "argv", argv: ["cat"] },
  stdin: payload,
});

console.log(result.stdoutText());
```

Strings are encoded as UTF-8. `Uint8Array` input keeps its exact bytes, including NUL and binary data. The input limit is **1 MiB**; larger input rejects before contacting the provider. Empty or omitted input still closes stdin. Output and exit status use the same result format and capture limit as other executions.

An adapter may supply this input through a temporary file rather than a pipe. For ongoing input, use [`processes.start({ command, stdin: "pipe", output: { mode: "stream" } })`](/docs/guides/text-streaming/), then call `write()` and `closeStdin()`. Process stdin defaults to closed. See the complete [finite-input example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/finite-stdin.ts) and [tested provider support](/docs/providers/support/) for provider limits and live test coverage.

## Recover an uncertain write

A timeout or lost response does not prove that the destination was left unchanged. Keep the error details and check the outcome before retrying.

For buffered `writeFile` and `writeTextFile` calls submitted as operations, an uncertain result can include a recovery reference. Use it with [`recover()`](/docs/guides/recovery/) to inspect the original operation. Buffered writes larger than **1 MiB** use streaming when the adapter supports it, so they follow the streaming error behavior below.

`writeFileStream` does not return an operation recovery reference. Its `FilesystemError` exposes `effect` and `details`, which can include `source`, `destination`, `temporaryPaths` and `bytesTransferred`. Inspect the destination and only the related temporary files in the original sandbox. An error with `effect: "applied"` means publication was confirmed even if temporary-file cleanup failed.
