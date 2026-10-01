---
title: E2B
description: Connect to E2B with an API key, select a template, and use the tested file workspace.
---

Import `e2b` from `sandbar-sdk/e2b`. The built-in adapter uses the E2B API key and public `base` template by default.

E2B also supports [finite text streaming](/docs/guides/text-streaming/) through `sandbox.processes.start()`. Separate stdout/stderr text, confirmed zero/nonzero exit and prompt local detach use bounded queues and a cumulative output budget. No process runtime deadline, binary streaming or remote process kill is provided. Live streaming validation remains unrun.

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

Prepared templates and explicit OCI builds are implemented. Builds can retain a template after sandbox destruction; see [Images and networking](/docs/guides/images-and-networking/). The adapter maps `blocked` and `internet` to E2B's native internet-access setting. The maintained paired probe failed at `431cdaa`: requested blocking still allowed direct IPv4 TCP, while hostname resolution failed. There is no passing outbound-isolation claim; see the [generated network evidence](/docs/providers/support/). Region selection is not supported.

Destroy each sandbox explicitly, then close the client. Native timeout is a fallback, not a cleanup confirmation. The [support matrix](/docs/providers/support/) distinguishes live baseline coverage from image-build and network tests.

## Runtime snapshots and volumes

`box.snapshot()` uses E2B's reusable native capture with no snapshot configuration. It includes private filesystem, memory and process state. E2B briefly pauses the running source and resumes it; active connections are dropped. Restore resumes captured process state in new compute. Sandbar saves the raw native template ID and captured build UUID separately and submits `templateId:buildUUID`, with the requested network policy in the original create request before resumed memory executes. External volume capture is unsupported. These workflows have fixture coverage and historical live evidence at the revisions recorded in the [generated support table](/docs/providers/support/). The Bun roundtrip passed at `8449def`; this is not current-head certification.

There is no memory-exclusion option for this native capture. Optional requirements for filesystem-only preservation reject before effects. Capture requires a running source with envd `v0.5.0` or newer; the adapter verifies eligibility. Filesystem-only suspension of the same logical sandbox is a separate native operation. See [E2B snapshots](https://docs.e2b.dev/sandbox/snapshots).

Lost capture acknowledgements remain uncertain and are never resubmitted. Recovery cannot establish original build generation from a later tag lookup. Save operation references. Unnamed capture allocates a dedicated containing template. Inspection checks the saved build and its current addressability without substituting `default`. Cleanup deletes the raw containing template after identity, alias, current builds, names, visibility and dependency checks; it rejects known expansion into shared storage. Native deletion has no transactional generation condition, so external changes between the read and delete remain a provider limitation. Automatic cleanup requires correlated creation history. Save resource references in your application storage; for recovery with rotated credentials use an authenticated, verified `teamId` scope. The default API-key scope changes with the key.

Private-beta volume create, inspect, list and owned deletion are mapped; names allow letters, numbers and hyphens. Sandbar create-time mounts are unsupported because E2B selects reusable names and does not expose the mounted native volume ID. Account access is checked before effects. Live volume creation was blocked by account HTTP 403; the maintained built-in acceptance profile skips volume cases before setup. This is separate from the unsupported Sandbar mount mapping. Read-only enforcement, subpaths and volume versions are unsupported. Shutdown durability remains unknown; writable mounted compute requires explicit `storage: "allow-unconfirmed"` cleanup. Retained mounted storage is reported by unresolved name, without assigning a native volume ID from inventory. Volumes retain independent custody and require separate owned deletion. See [Snapshots and volumes](/docs/guides/snapshots-and-volumes/) and [E2B volume management](https://docs.e2b.dev/volumes/manage).

## Scoped sandbox reopening

Persist `sandbox.reference` from create, restore or recovered results, then use `freshClient.sandboxes.get(savedReference)` to reopen the same native compute. `inspect()` reports fresh state, native state, local observation time and available deadline/policy facts. Reopening never creates, resumes or extends lifetime; inactive compute remains inactive and guest calls require running state. Unknown expiry is not unlimited lifetime, and elapsed expiry does not prove deletion. Native absence, forbidden access, unavailable reads and identity/configuration conflict remain distinct errors.

References contain no credentials or historical observations. Configure current credentials with the original native binding. Applications own trusted persistence and the crash window before saving. Legacy adapters and failed optional native identity reads may leave `reference` null; inspect again for verified identity rather than fabricating a locator from `id`. See the [compiled reopening example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-reopen.ts). This slice has deterministic/packed coverage; its new live workflow remains not-run. Timeout control and suspension/resumption are later slices.

E2B same-team key rotation requires configured `teamId`; API-key-scoped references reject rotation. Keep the original configured template. Running deadlines use native `endAt`; paused resources ignore stale session deadlines and report documented indefinite paused retention. Exec/files attach through authenticated detail and a local pinned client, requiring explicit `autoResume: false`, a guest token and trusted routing. Missing or changed guest policy fails unavailable before guest IO. There is no implicit connect POST. An external policy change after the check remains a documented native race.
