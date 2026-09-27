---
title: Binary files and output
description: Handle binary file transfer and bounded execution output.
---

`writeFile(path, Uint8Array, { overwrite })` and `readFile(path)` use exact virtual paths. The SDK caps a file read or write at **1 MiB**. `overwrite` defaults to `false`. The fake has no directories, symlinks or durable mounts.

```ts
await box.writeFile('/data.bin', Uint8Array.of(0, 255));
const bytes = await box.readFile('/data.bin');
```

The execution request accepts `maxOutputBytes`; the default is **1 MiB**. `stdout` and `stderr` are byte arrays. Use `stdoutText(maxBytes)` or `stderrText(maxBytes)` only for display, and check `truncated` when complete output matters. File transfer is buffered in this build; streaming file APIs are not implemented.
