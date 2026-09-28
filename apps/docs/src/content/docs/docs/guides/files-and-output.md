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
console.log(result.stdoutText(4096));
if (result.truncated) console.warn("Command output was truncated");
```

`stdout` and `stderr` are `Uint8Array` values. Keep those bytes for binary processing; `stdoutText(maxBytes)` and `stderrText(maxBytes)` decode bounded UTF-8 for display. The helpers default to 16 KiB.

The execution output limit defaults to 1 MiB combined across both streams. `truncated` means output may be incomplete, including when a stream reaches the cap before its end can be confirmed. Streaming file APIs are not implemented.

## Recover an uncertain write

A timeout after upload does not establish that a file was unchanged. Save the reference from an uncertain-outcome error and [observe the write](/docs/guides/recovery/) before deciding what to do next. Do not blindly retry it.
