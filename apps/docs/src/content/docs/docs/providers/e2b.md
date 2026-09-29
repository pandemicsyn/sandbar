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

## Runtime snapshots and volumes

`box.snapshot()` uses E2B's reusable native capture with no snapshot configuration. It includes private filesystem, memory and process state. E2B briefly pauses the running source and resumes it; active connections are dropped. The native artifact contains resumed process state, but Sandbar restore is unsupported: E2B creates from a mutable template tag and exposes no restored build ID to confirm the captured generation. External volume capture is unsupported. These workflows have fixture coverage and are **not yet live-qualified**.

There is no memory-exclusion option for this native capture. Optional requirements for filesystem-only preservation reject before effects. Capture requires a running source with envd `v0.5.0` or newer; the adapter verifies eligibility. Filesystem-only suspension of the same logical sandbox is a separate native operation. See [E2B snapshots](https://docs.e2b.dev/sandbox/snapshots).

Lost capture acknowledgements remain uncertain and are never resubmitted. Recovery cannot establish original build generation from a later tag lookup. Save operation references. SDK snapshot deletion is unsupported because E2B deletes by mutable alias without a captured-generation precondition. Retained snapshots require separate manual cleanup through E2B after checking their current identity.

Private-beta volume create, inspect, list and owned deletion are mapped; names allow letters, numbers and hyphens. Sandbar create-time mounts are unsupported because E2B selects reusable names and does not expose the mounted native volume ID. Account access is checked before effects. Read-only enforcement, subpaths and volume versions are unsupported. Shutdown durability remains unknown; writable mounted compute requires explicit `storage: "allow-unconfirmed"` cleanup. Retained mounted storage is reported by unresolved name, without assigning a native volume ID from inventory. Volumes retain independent custody and require separate owned deletion. See [Snapshots and volumes](/docs/guides/snapshots-and-volumes/) and [E2B volume management](https://docs.e2b.dev/volumes/manage).
