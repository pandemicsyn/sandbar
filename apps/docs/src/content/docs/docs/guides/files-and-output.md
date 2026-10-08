---
title: Files and output
description: Transfer text and binary files and read bounded command output.
---

## Write and read text

Use `writeTextFile` and `readTextFile` for UTF-8 without encoding boilerplate:

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { e2b } from "sandbar-sdk/e2b";

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

These helpers call the byte APIs below and inherit their limits, absolute-path validation, cancellation, errors and recovery. Limits count encoded bytes, not string length; an oversized read fails instead of returning a prefix. Reads decode the complete bounded result, replace malformed UTF-8 and consume an initial UTF-8 BOM. Empty text is valid. Text is never parsed, shortened or newline-normalized; parent directories must exist, and helpers do not resume compute. Writes default to `overwrite: false`. Pass `{ signal }` to either helper for cancellation. Each helper uses the existing file-operation tracing spans.

## Write and read bytes

File APIs take absolute paths inside the sandbox and preserve bytes. This example uses E2B's default `/home/user` workspace:

```ts
const path = "/home/user/sandbar-example.bin";
await box.writeFile(path, Uint8Array.of(0, 255, 129));
const bytes = await box.readFile(path);
console.log(bytes);
```

File reads accept caller cancellation while keeping `readFile(path)` available:

```ts
const bytes = await box.readFile(path, { signal: AbortSignal.timeout(5000) });
```

One fixed **30-second local deadline** covers the provider response and all file chunks. Caller abort rejects with `WAIT_ABORTED`, the local deadline with `TIMEOUT`, and client close with `CLIENT_CLOSED`. These are read-only failures with no uncertain mutation or recovery reference. Native read failures retain their error code.

Sandbar stops the local wait promptly even if an adapter ignores its signal. It cancels and releases local readers, including streams returned after cancellation, without awaiting native cleanup. Daytona download requests and E2B detail/file requests receive cancellation signals; earlier scope inspection may finish independently. Native request cancellation is best effort and does not terminate remote commands or change sandbox lifetime. E2B retains its verified, non-resuming guest attachment checks.

Convenience reads and writes default to **1 MiB** and buffer in memory. Pass `maxBytes` to choose a bound up to **16 MiB**; larger data uses the streaming methods below. A read exceeding its bound rejects instead of returning a prefix. The parent directory must already exist and be writable by the provider's file operations.

`overwrite` defaults to `false`: writing to an existing destination must fail without replacing it. To replace a file deliberately:

```ts
await box.writeFile(path, new TextEncoder().encode("updated"), { overwrite: true });
```

Daytona and E2B implement no-clobber writes using staged files and exact-destination hard links. Their images need GNU-compatible `ln -T` and a filesystem that supports hard links. Check [tested provider support](/docs/providers/support/) before relying on a custom image.

For E2B, use `/home/user` for this workflow. An earlier live test failed when overwriting a user-owned file directly in root-owned sticky `/tmp`; a home-directory pass does not qualify arbitrary paths.

## Directories and metadata

Daytona and E2B support the same private-filesystem workflow:

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

`readDirectory` returns immediate `{ name, type }` children in deterministic code-unit order, an `observedAt` timestamp and `completeness: "complete" | "unknown"`. Types are `file`, `directory`, `symlink` or `unknown`. Unknown metadata remains visible. Completeness describes the enumeration, not an atomic snapshot of a changing directory. Authentication, permission and transport failures reject.

`listFiles` retains its strict complete-listing contract. Both methods reject more than **1,024 entries** or **65,536 summed UTF-8 bytes in names** with `OUTPUT_CAPACITY`; invalid or duplicate children reject with `INVALID_RESPONSE`. There is no implicit recursion or pagination, and local truncation never becomes a successful unknown listing.

`statFile` returns the entry type and available `sizeBytes`, `modifiedAt` and `mode`. Missing metadata is omitted. The final symlink is not followed by default, including dangling links; pass `{ followSymlinks: true }` to inspect its target. `fileExists` returns false only for confirmed entry absence. Credentials, permissions, missing compute and transport failures reject. Intermediate parent links follow the guest namespace.

Mkdir accepts an existing directory. Without `recursive: true`, parents must exist. Removal accepts missing entries and permits files, links and empty directories; nonempty directories require explicit recursion. Directory paths collapse repeated slashes and trailing slashes, and root removal is refused. Recursive removal never walks final or descendant symlink entries. This is ordinary filesystem access, not a confinement boundary.

Copy initially accepts regular-file operands only. Move renames a file or directory on the same filesystem, without a copy/delete fallback. Both reject identical source/destination paths and default to no-clobber; `{ overwrite: true }` deliberately replaces a compatible destination. Parents must exist. Copy does not promise a snapshot of a concurrently changing source, metadata cloning or storage durability. Linux native rename collision guarantees do not imply global atomicity on object-backed mounts.

Both built-ins use adapter-owned Python 3 helpers for complete directory/link observations and race-safe filesystem changes. Their private Linux filesystem requires Python 3; no-clobber native rename requires Linux `renameat2`. See the provider pages for transport and image prerequisites. Experimental Modal can reject optional hooks with `UNSUPPORTED`.

## Large byte transfers

The application supplies byte chunks and owns its download sink:

```ts
const uploaded = await box.writeFileStream("/home/user/archive.bin", inputChunks, { signal });
console.log(uploaded);
for await (const chunk of box.readFileStream("/home/user/archive.bin", { signal })) {
  await destination.write(chunk);
}
```

These methods transfer incrementally without a default whole-file size ceiling. Pass `maxBytes` to impose one. Large chunks are split into at most **64 KiB**, with bounded queued bytes/chunks and awaited IO. Reads fail on incomplete delivery. A successful write returns the confirmed byte count; empty files and arbitrary binary bytes are valid. Slow consumer processing does not consume the network inactivity allowance.

Transfers separate setup, inactivity and optional overall timeouts. Defaults are **30 seconds** for setup and **60 seconds** without active network progress, with no overall deadline. Set `transfers: { setupTimeoutMs, inactivityTimeoutMs, overallTimeoutMs }` on the SDK connection, or use these timeout fields in the per-transfer options to override the policy. Caller abort or client close stops local waiting and cancels readers promptly. The SDK requests producer cleanup with `iterator.return()`; producer-owned blocked IO must observe the caller signal to stop, since JavaScript cannot interrupt an arbitrary pending `next()`. Cancellation does not roll back already dispatched remote work.

Writes and copies reserve same-directory staging before publication. No-clobber is enforced at publication, including concurrent destination creation. Cleanup targets only the correlated staging artifact. A lost acknowledgement or interrupted cleanup preserves known source, destination and temporary-path effects in typed errors; never automatically retry an uncertain mutation. A confirmed transfer remains confirmed if later inspection fails. Mounted storage may lack the required publish guarantee and rejects unsupported requests before effects.

See the compiled [artifact recipe](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/directory-files.ts). Deterministic fixtures and packed consumers verify these additions separately from dated live evidence in [provider support](/docs/providers/support/).

## Traversal and text lines

`walkFiles` composes directory reads into deterministic depth-first traversal. It yields `{ name, type, path, relativePath, depth }` entries; the root itself is omitted and immediate children have depth 1. Directory entries are yielded before their descendants. Symlinks and unknown types are yielded without descent. Each directory must have complete enumeration; unreadable subtrees, unknown completeness and entry-budget overflow reject rather than silently skipping data.

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

Traversal defaults to depth **32** and **10,000 observed entries**. `maxDepth` is an intentional descent boundary. Exclusions are exact canonical root-relative paths, with directory exclusions pruning whole subtrees; they are not glob patterns. Excluded entries still count against the observed-entry budget. This observes a changing namespace and does not promise a snapshot or confinement against intermediate symlinks.

`readTextLines` incrementally decodes UTF-8 over `readFileStream`, including code points and CRLF split across chunks. It strips LF and CRLF delimiters, preserves lone CR, and yields a final unterminated line without adding an empty line after a final delimiter. Malformed UTF-8 uses replacement characters, matching the text helpers. The default maximum line is **1 MiB of source bytes**, excluding the delimiter; oversized lines reject with `OUTPUT_CAPACITY`. All byte-transfer options, including `maxBytes`, cancellation and timeout overrides, also apply. These SDK helpers need existing directory/stream adapter hooks, with no new provider endpoint. Range reads, batches, glob/search and tree copy remain deferred.

The compiled artifact recipe exercises both helpers through deterministic fixtures and packed consumers. Historical live artifact passes at `2f6afe8` predate these helpers and do not qualify them; the expanded recipe passed at `e91f2d5` on both borrowed provider images with confirmed cleanup. Exact scope is recorded in provider support.

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

`stdout` and `stderr` are `Uint8Array` values. Keep those bytes for binary processing. `stdoutText(maxBytes?)`, `stderrText(maxBytes?)` and exported `outputText(bytes, maxBytes?)` decode bounded UTF-8 for display, defaulting to **16,384 input bytes**. Numeric display limits are safe integers from **0 to 1,048,576**, including zero. Invalid limits throw a local `RangeError`.

`stdoutPreview({ maxBytes? })` and `stderrPreview({ maxBytes? })` return `OutputPreview`: `{ text, shortened }`. They use the same defaults, byte limits and text as the bounded helpers. `shortened` concerns only that stream's display: exact-bound or empty input is not shortened; nonempty input with a zero bound returns `{ text: "…", shortened: true }`. A literal ellipsis in command output does not establish display loss.

For full decoding of captured output, use `{ full: true }`:

```ts
const result = await box.exec(["cat", "/home/user/report.json"]);
if (result.truncated) throw new Error("Captured report may be incomplete");
const report = JSON.parse(result.stdoutText({ full: true }));
console.error(result.stderrText({ full: true }));
```

Full decoding also works with `outputText(bytes, { full: true })`, decodes every supplied byte, and adds no suffix. It allocates a string proportional to input size. Full options must contain only `full: true`; preview options allow only optional `maxBytes`. Invalid option objects throw `RangeError` without changing the execution result. Omitted or undefined options preserve defaults.

The execution capture limit defaults to **1 MiB combined across both streams**, retaining stdout first and stderr with the remainder. `result.truncated` means output may be incomplete, including when a stream reaches the cap before its end can be confirmed. Capture loss and display shortening are independent: complete capture can have a shortened preview; truncated capture can have an unshortened preview. Full decoding and larger display bounds cannot recover discarded capture.

All helpers use standard UTF-8 replacement decoding and consume an initial UTF-8 BOM. Limits count input bytes, so clipping inside a multibyte sequence produces U+FFFD; malformed bytes and incomplete captured suffixes are also replaced. The replacement and display suffix can make the rendered string exceed the input byte bound. For strict parsing, use `new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)`. A capture guard does not establish valid UTF-8 or JSON, and parsing can still fail. Never parse a bounded display string.

The same helpers are available on recovered execution results and on `NonzeroExitError.result` and `NoExitCodeError.result`. Code manually constructing `ExecOutput` must now implement the two preview methods and full overloads; adapter authors still return `ExecValue` byte arrays.

## Supply finite command input

`box.exec` accepts a finite UTF-8 string or exact byte array, then closes guest stdin with EOF:

```ts
const payload = "Ada 🌊\0";
const result = await box.exec({
  command: { kind: "argv", argv: ["cat"] },
  stdin: payload,
});

console.log(result.stdoutText({ full: true }));
```

String input is encoded as UTF-8. `Uint8Array` input preserves its bytes, including NUL and binary values. The payload limit is **1 MiB**; an oversized value rejects before provider dispatch. Explicit empty input still sends EOF, and omitted input is closed. The result keeps stdout, stderr and exit status separate under the ordinary capture limit. Adapters may implement this with a seekable staging file; the contract promises bytes and EOF, not a pipe descriptor. `processes.start` still has closed stdin and does not expose incremental or interactive input. See the [compiled finite-input example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/finite-stdin.ts) and [provider support](/docs/providers/support/); deterministic and packed coverage does not establish live provider qualification.

## Recover an uncertain write

A timeout after upload does not establish that a file was unchanged. Save the reference from an uncertain-outcome error and [observe the write](/docs/guides/recovery/) before deciding what to do next. Do not blindly retry it.
