---
title: Files and output
description: Transfer binary files and read bounded command output.
---

## Write and read a file

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

Each file read or write is capped at **1 MiB** and buffered in memory. The parent directory must already exist and be writable by the provider's file operations.

`overwrite` defaults to `false`: writing to an existing destination must fail without replacing it. To replace a file deliberately:

```ts
await box.writeFile(path, new TextEncoder().encode("updated"), { overwrite: true });
```

Daytona and E2B implement no-clobber writes using staged files and exact-destination hard links. Their images need GNU-compatible `ln -T` and a filesystem that supports hard links. Check [tested provider support](/docs/providers/support/) before relying on a custom image.

For E2B, use `/home/user` for this workflow. An earlier live test failed when overwriting a user-owned file directly in root-owned sticky `/tmp`; a home-directory pass does not qualify arbitrary paths.

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

The same helpers are available on recovered execution results and on `NonzeroExitError.result` and `NoExitCodeError.result`. Code manually constructing `ExecOutput` must now implement the two preview methods and full overloads; adapter authors still return `ExecValue` byte arrays. Streaming file APIs are not implemented.

## Recover an uncertain write

A timeout after upload does not establish that a file was unchanged. Save the reference from an uncertain-outcome error and [observe the write](/docs/guides/recovery/) before deciding what to do next. Do not blindly retry it.
