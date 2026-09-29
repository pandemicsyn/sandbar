---
title: E2B
description: Connect to E2B with an API key, select a template, and use the tested file workspace.
---

Import `e2b` from `sandbar-sdk/e2b`. The built-in adapter uses the E2B API key and public `base` template by default.

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { e2b } from "sandbar-sdk/e2b";

const sandbar = await Sandbar.connect(
  e2b({
    apiKey: process.env.E2B_API_KEY!,
  }),
);
try {
  const box = await sandbar.sandboxes.create({
    environment: Image.prepared("base"),
    networkPolicy: "blocked",
  });
  try {
    await box.writeFile("/home/user/example.txt", new TextEncoder().encode("hello"));
    console.log((await box.exec(["cat", "/home/user/example.txt"])).stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await sandbar.close();
}
```

Set `E2B_API_KEY` before running this on the server. `E2B_API_ID` is not required and is not a team ID.

## Connection options

| Option           | Default  | Purpose                                                 |
| ---------------- | -------- | ------------------------------------------------------- |
| `apiKey`         | Required | Authenticated E2B API key.                              |
| `templateId`     | `base`   | Public base template or a ready owned template ID/name. |
| `timeoutSeconds` | `300`    | Native sandbox lifetime, from 60 to 3,600 seconds.      |
| `teamId`         | Omitted  | Optional verified team scope.                           |

For an owned template, configure its selector on the connection and pass it to `Image.prepared(...)`. Supported names are untagged or use `:default`; arbitrary named tags and public aliases are outside this integration's current scope.

Without `teamId`, Sandbar verifies the API key with an authenticated read and binds recovery to that key's scope. Rotating the key changes scope. With `teamId`, Sandbar verifies the team; this allows same-team key rotation without changing authority. Switching scope modes requires a separate connection.

## Files and commands

Use `/home/user` for file workflows on `base`. The live baseline covers binary transfer, overwrite, and no-clobber in that directory. An earlier overwrite attempt directly in sticky `/tmp` failed; custom paths, users, and images need their own validation.

The adapter supports argument arrays and Bash shell scripts, working directory and environment options, and bounded binary stdout/stderr. No-clobber writes require GNU `ln -T` and hard-link support. Files and captured output are capped at 1 MiB.

## Images, networking, and cleanup

Prepared templates and explicit OCI builds are implemented. Builds can retain a template after sandbox destruction; see [Images and networking](/docs/guides/images-and-networking/). The adapter supports `blocked` and `internet` policies through E2B's native internet-access setting. Region selection is not supported.

Destroy each sandbox explicitly, then close the client. Native timeout is a fallback, not a cleanup confirmation. The [support matrix](/docs/providers/support/) distinguishes live baseline coverage from image-build and network tests.

## Planned runtime snapshot defaults

Runtime capture through `box.snapshot()` is planned, not an available or live-qualified operation in this documented release. The planned E2B adapter needs no snapshot configuration: reusable native snapshots include the private filesystem, memory, and process state. E2B automatically pauses the running source briefly and resumes it; active connections, including command streams and PTYs, are dropped. Restoring creates a new sandbox that resumes captured process state. External volumes are not included in the proposed contract.

There is no memory-exclusion or pause-selection option for this native reusable capture. E2B's filesystem-only pause/resume feature resumes the same logical sandbox and is a different operation. A stopped source is not automatically started for capture. Native reusable snapshots require a running sandbox and a template with envd `v0.5.0` or newer; adapter support must verify the applicable prerequisites. See [E2B snapshots](https://docs.e2b.dev/sandbox/snapshots) and [filesystem-only pause/resume](https://docs.e2b.dev/sandbox/filesystem-only-snapshots).

Applications may optionally require filesystem-only capture, in which case this E2B path must reject before effects. A lost capture response is an uncertain outcome: preserve operation evidence and reconcile without submitting another capture. Retained snapshots need explicit artifact cleanup independent of sandbox destruction. Default capture, resumed processes, connection effects, and artifact cleanup must be covered by implementation and live qualification before this page claims support.
