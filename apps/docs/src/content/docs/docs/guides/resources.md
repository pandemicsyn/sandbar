---
title: Sandboxes and execution
description: Create, inspect, execute, and clean up resources with the TypeScript SDK.
---

`Image.prepared('fake-starter')` is the only image verified with the fake provider. The `Image.oci(reference)` input exists in the SDK, but no real OCI importer is qualified.

`sandbar.sandboxes.create({ environment })` returns a `SandboxHandle` with `id`, `inspect()`, `exec()`, `readFile()`, `writeFile()` and `destroy()`. The default network policy is `blocked`; the fake only simulates this policy and provides no guest network isolation.

```ts
const box = await sandbar.sandboxes.create({ environment: Image.prepared('fake-starter') });
try {
  const state = await box.inspect();
  const output = await box.exec({ command: { kind: 'argv', argv: ['fixture', 'hello'] } });
  console.log(state.state, output.stdoutText(4096));
} finally {
  await box.destroy();
}
```

The fake accepts `exec` only when the matching command fixture has been seeded through its **test-only** control endpoint. A nonzero exit throws `NonzeroExitError` with the captured result. A completed execution without an exit code throws `NoExitCodeError`. `exec` returns exact `Uint8Array` stdout and stderr plus a `truncated` flag; the text helpers decode a bounded number of bytes for display.
