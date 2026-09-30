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

## Capture and restore

Insert this capture/restore fragment inside the sandbox’s inner `try` block above, before cleanup. It uses the same connection policy. Follow the [complete example](/docs/guides/snapshots-and-volumes/#capture-and-restore) to persist the reference and clean up restored compute and the retained snapshot:

```ts
const captured = await box.snapshot();
const restored = await captured.snapshot.restore({
  networkPolicy: "blocked",
  requireIndependentLifecycle: true,
});
```

Capture uses E2B's native default: private filesystem, RAM and process state. It briefly pauses and resumes a running source, dropping connections. Restore resumes captured processes in independent compute with the explicit network policy applied before execution. There is no filesystem-only capture option; requirements demanding it reject before effects. Capture requires a running source with envd `v0.5.0` or newer. External mounts are unsupported.

Sandbar saves the raw native template ID and captured build UUID, then restores `templateId:buildUUID`. A later `default` tag cannot substitute another build. Deletion targets the dedicated containing template after identity, generation and dependency checks; known shared expansion blocks it. E2B has no transactional generation condition for deletion, so concurrent external changes remain a native limitation.

Persist resource and operation references in your application storage. Use verified `teamId` scope when credentials may rotate. Lost capture acknowledgements remain uncertain; a later tag lookup cannot establish the original build generation. See [Snapshots and volumes](/docs/guides/snapshots-and-volumes/) for cleanup-safe examples and [Errors and recovery](/docs/guides/recovery/) for uncertain outcomes.

## Private-beta volumes

E2B has native volumes in private beta. Sandbar maps create, inspect, list and deletion; the recorded account's create returned HTTP 403, so live CRUD validation is blocked. Inventory access alone does not prove create eligibility.

Sandbar create-time mounts are unsupported separately: E2B submits and observes reusable names without the mounted immutable volume ID. Read-only enforcement, subpaths and volume versions are unsupported; shutdown durability is unknown. Existing mounted compute can be explicitly cleaned up with `storage: "allow-unconfirmed"`, even when volume inventory is unavailable. Unresolved retained names are not verified IDs or deletion authority. Volumes survive compute destruction and need separate deletion.

## Evidence

E2B's snapshot round trip, two-way filesystem isolation and reopening saved references after source deletion passed live on premerge `5db0558`. Main includes later fixes; that historical run does not certify the final merged head. E2B volume CRUD did not pass. Consult [Tested provider support](/docs/providers/support/) and [Live test evidence](/docs/providers/live-qualification/) for the current qualification mapping.
