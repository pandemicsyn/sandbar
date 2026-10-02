---
title: E2B
description: Connect to E2B with an API key, select a template, and use the tested file workspace.
---

Import `e2b` from `sandbar-sdk/e2b`. The built-in adapter uses the E2B API key and public `base` template by default.

E2B also supports [finite text streaming](/docs/guides/text-streaming/) through `sandbox.processes.start()`. Separate stdout/stderr text, confirmed zero/nonzero exit and prompt local detach use bounded queues and a cumulative output budget. No process runtime deadline, binary streaming or remote process kill is provided. Live streaming validation remains unrun.

```ts
import { Sandbar } from "sandbar-sdk";
import { e2b } from "sandbar-sdk/e2b";

// Provider setup: adapter credentials, region/template and prepared image.
const client = await Sandbar.connect(
  e2b({ apiKey: process.env.E2B_API_KEY!, lifecycle: { lifetimeSeconds: 600 } }),
);

try {
  const box = await client.sandboxes.create();
  try {
    await box.exec(["/bin/sh", "-c", "printf ready"]);
    const renewed = await box.renew();
    await box.renew({ forSeconds: 61 });
    console.log(renewed.requested, renewed.observation?.expires);
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

Set `E2B_API_KEY` before running this on the server. `E2B_API_ID` is not required and is not a team ID.

## Connection options

| Option                      | Default  | Purpose                                                                              |
| --------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `apiKey`                    | Required | Authenticated E2B API key.                                                           |
| `templateId`                | `base`   | Public base template or a ready owned template ID/name.                              |
| `lifecycle.lifetimeSeconds` | Omitted  | Initial/default renewal window in seconds; mutually exclusive with `timeoutSeconds`. |
| `timeoutSeconds`            | `300`    | Native sandbox lifetime, from 60 to 3,600 seconds.                                   |
| `teamId`                    | Omitted  | Optional verified team scope.                                                        |

For an owned template, configure its selector once with `templateId`. Supported names are untagged or use `:default`; arbitrary named tags and public aliases are outside this integration's current scope.

Without `teamId`, Sandbar verifies the API key with an authenticated read and binds recovery to that key's scope. Rotating the key changes scope. With `teamId`, Sandbar verifies the team; this allows same-team key rotation without changing authority. Switching scope modes requires a separate connection.

`create()`, `create({ labels: { job: "report" } })`, `checkCreate()` and `submitCreate()` use `templateId`, including its existing `base` default. An explicit per-call `environment` wins for that call only. Invalid or unavailable overrides never fall back to `base`; scoped prepared images retain scope checks. Omitted networking stays blocked. Default-creation live acceptance remains unrun.

## Files and commands

Use `/home/user` for file workflows on `base`. The live baseline covers binary transfer, overwrite, and no-clobber in that directory. An earlier overwrite attempt directly in sticky `/tmp` failed; custom paths, users, and images need their own validation.

The adapter supports argument arrays and Bash shell scripts, working directory and environment options, and bounded binary stdout/stderr. No-clobber writes require GNU `ln -T` and hard-link support. Files and captured output are capped at 1 MiB.

## Images, networking, and cleanup

Prepared templates and explicit OCI builds are implemented. Builds can retain a template after sandbox destruction; see [Images and networking](/docs/guides/images-and-networking/). The adapter maps `blocked` and `internet` to E2B's native internet-access setting. The maintained paired probe failed at `431cdaa`: requested blocking still allowed direct IPv4 TCP, while hostname resolution failed. There is no passing outbound-isolation claim; see the [generated network evidence](/docs/providers/support/). Region selection is not supported.

Destroy each sandbox explicitly, then close the client. Native timeout is a fallback, not a cleanup confirmation. The [support matrix](/docs/providers/support/) distinguishes live baseline coverage from image-build and network tests.

## Configured lifetime renewal

The application workflow is the same for both built-in adapters:

```ts
const box = await client.sandboxes.create();
await box.exec(["/bin/sh", "-c", "printf ready"]);
const renewed = await box.renew();
await box.renew({ forSeconds: 61 });
await box.destroy();
await client.close();
```

Set `lifecycle: { lifetimeSeconds: 600 }` in adapter setup for the initial lifetime and default `renew()` window. Omission keeps the existing 300-second `timeoutSeconds` default. Supplying both `lifecycle.lifetimeSeconds` and `timeoutSeconds` rejects during connection before native effects. These defaults stay local to the connection: reopening uses the new connection's default only when you explicitly call `renew()`. `get()` and `inspect()` never apply it.

E2B raises positive requests below 60 seconds to 60; other seconds remain exact, up to a resolved 3,600-second SDK ceiling. One native timeout POST resets the active session deadline from provider processing. New Sandbar compute uses kill on timeout with auto-resume off. Paused retention is separate from the running-session clock: stale `endAt` is ignored while paused, and native paused state has indefinite retention requiring explicit cleanup. The returned observation reports running `endAt` when available. See [native timeout reset](https://docs.e2b.dev/api-reference/sandboxes/set-sandbox-timeout) and [paused retention](https://docs.e2b.dev/sandbox/persistence).

Both mappings require running compute. E2B also requires known native kill-on-timeout with auto-resume off; missing or externally changed policy rejects `UNAVAILABLE` before reset. Use positive safe integer seconds; upper bounds and invalid inputs reject before the renewal POST without downward rounding or clamping. Native account/region/runtime limits can be tighter and native rejection remains an error. Renewal may shorten an existing longer deadline, is not additive, and does not guarantee uninterrupted execution or exact expiry scheduling. Serialize lifecycle changes across application and external controllers.

`RenewResult.requested.forSeconds` records the resolved native setting, `acknowledged: true` confirms provider acceptance, and `observation` is current metadata or `null` if the follow-up read failed. A lost ACK stays `OUTCOME_UNKNOWN` even if a later deadline looks right. `submitRenew()` and `client.recover(savedOperationReference)` use existing typed recovery; observation never sends another renewal POST. Caller cancellation before dispatch has no effect; after possible dispatch it stops local waiting with the recovery reference. Persist ordinary sandbox references in your own trusted store, and save result metadata separately when useful.

Renewal has deterministic native-boundary and packed Node/Bun coverage. The maintained `lifecycle-renew` live scenario is not run. Sandbar suspend/resume methods use the native policies below; the E2B lifecycle case passed at `26f516d` with confirmed cleanup, retaining the earlier failures described below.

## Runtime snapshots and volumes

`box.snapshot()` uses E2B's reusable native capture with no snapshot configuration. It includes private filesystem, memory and process state. E2B briefly pauses the running source and resumes it; active connections are dropped. Restore resumes captured process state in new compute. Sandbar saves the raw native template ID and captured build UUID separately and submits `templateId:buildUUID`, with the requested network policy in the original create request before resumed memory executes. External volume capture is unsupported. These workflows have fixture coverage and historical live evidence at the revisions recorded in the [generated support table](/docs/providers/support/). The Bun roundtrip passed at `8449def`; this is not current-head certification.

There is no memory-exclusion option for this native capture. Optional requirements for filesystem-only preservation reject before effects. Capture requires a running source with envd `v0.5.0` or newer; the adapter verifies eligibility. Filesystem-only suspension of the same logical sandbox is a separate native operation. See [E2B snapshots](https://docs.e2b.dev/sandbox/snapshots).

Lost capture acknowledgements remain uncertain and are never resubmitted. Recovery cannot establish original build generation from a later tag lookup. Save operation references. Unnamed capture allocates a dedicated containing template. Inspection checks the saved build and its current addressability without substituting `default`. Cleanup deletes the raw containing template after identity, alias, current builds, names, visibility and dependency checks; it rejects known expansion into shared storage. Native deletion has no transactional generation condition, so external changes between the read and delete remain a provider limitation. Automatic cleanup requires correlated creation history. Save resource references in your application storage; for recovery with rotated credentials use an authenticated, verified `teamId` scope. The default API-key scope changes with the key.

Private-beta volume create, inspect, list and owned deletion are mapped; names allow letters, numbers and hyphens. Sandbar create-time mounts are unsupported because E2B selects reusable names and does not expose the mounted native volume ID. Account access is checked before effects. Live volume creation was blocked by account HTTP 403; the maintained built-in acceptance profile skips volume cases before setup. This is separate from the unsupported Sandbar mount mapping. Read-only enforcement, subpaths and volume versions are unsupported. Shutdown durability remains unknown; writable mounted compute requires explicit `storage: "allow-unconfirmed"` cleanup. Retained mounted storage is reported by unresolved name, without assigning a native volume ID from inventory. Volumes retain independent custody and require separate owned deletion. See [Snapshots and volumes](/docs/guides/snapshots-and-volumes/) and [E2B volume management](https://docs.e2b.dev/volumes/manage).

## Scoped sandbox reopening

Persist `sandbox.reference` from create, restore or recovered results, then use `freshClient.sandboxes.get(savedReference)` to reopen the same native compute. `inspect()` reports fresh state, native state, local observation time and available deadline/policy facts. Reopening never creates, resumes or extends lifetime; inactive compute remains inactive and guest calls require running state. Unknown expiry is not unlimited lifetime, and elapsed expiry does not prove deletion. Native absence, forbidden access, unavailable reads and identity/configuration conflict remain distinct errors.

References contain no credentials or historical observations. Configure current credentials with the original native binding. Applications own trusted persistence and the crash window before saving. Legacy adapters and failed optional native identity reads may leave `reference` null; inspect again for verified identity rather than fabricating a locator from `id`. See the [compiled reopening example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-reopen.ts). This slice has deterministic/packed coverage; its new live workflow remains not-run. Configured renewal is available; native suspension/resumption are available on eligible compute.

E2B same-team key rotation requires configured `teamId`; API-key-scoped references reject rotation. Keep the original configured template. Running deadlines use native `endAt`; paused resources ignore stale session deadlines and report documented indefinite paused retention. Exec/files attach through authenticated detail and a local pinned client, requiring explicit `autoResume: false`, a guest token and trusted routing. Missing or changed guest policy fails unavailable before guest IO. There is no implicit connect POST. An external policy change after the check remains a documented native race.

## Bounded execution deadlines

`deadlineSeconds` defaults to 300. The pinned `e2b@2.51.0` client receives this value in milliseconds as foreground RPC `timeoutMs` and handshake `requestTimeoutMs`; the handshake timer clears when a PID arrives. This establishes observation deadlines, without a verified remote command-termination guarantee. A command may continue after RPC observation ends. Sandbar polls its original status/output files without replaying submission; setup, polling and output reads mean this is not a total SDK wait budget.

Use an explicit caller `signal` to stop local waiting. Neither a local abort nor an RPC timeout implicitly kills compute or changes the independent sandbox `timeoutSeconds`. A valid exit marker followed by failed output retrieval can still leave the public result pending or unknown. See [execution and waiting timeouts](/docs/guides/resources/#execution-and-waiting-timeouts). Offline fixtures exercise the pinned client timers and no-kill request paths; they do not prove deployed envd termination.

## Suspend and resume

**Live confirmation passed.** The maintained Bun `lifecycle-suspend-resume` case passed at `26f516d` on October 2, 2026 with confirmed owned cleanup and client close. It verified inactive fresh-process reopening without implicit wake, the same identity/files, preserved RAM nonce and an advancing counter after explicit resume. Earlier failures at `6796b30` (guest routing) and `cb39884` (missing mount facts) remain recorded. This pass covers the private-state mapping, not external storage or remote connection continuity.

Configure a minimum guarantee once in adapter setup, then use the same application calls:

```ts
const suspended = await box.suspend();
// Save box.reference in your trusted store, then close the original connection.
const reopened = await freshClient.sandboxes.get(savedReference); // stays inactive
const resumed = await reopened.resume();
await reopened.destroy(); // explicit cleanup of the same native sandbox
```

`e2b({ apiKey, teamId, templateId: "base", lifecycle: { suspension: { preserve: "filesystem" } } })` uses native `memory: true` pause. Its filesystem-plus-memory default satisfies either filesystem or memory minimum. Filesystem-only pause is deferred. Only running compute with known kill-on-timeout/auto-resume-off policy qualifies. Known nonempty native mounts reject `UNSUPPORTED`; absent mount metadata stays unknown and does not block preservation of the private root filesystem and RAM. Native mount enumeration does not prove all guest storage is local. External storage flush, durability, atomic consistency and remote connection continuity are excluded; changed or unknown lifecycle policy still rejects before mutation. Pausing preserves process memory and drops existing sockets; reconnect application sockets after resumption.

Paused state has indefinite native retention and requires explicit cleanup; its stale running-session `endAt` is not a retention deadline. Explicit `resume()` sends one v2 connect from paused with the current adapter's resolved initial lifetime (300 seconds by default, or `lifecycle.lifetimeSeconds`). It sends no reboot override or second renewal. Execution remains `unknown`: neither saved receipts nor PIDs prove that an external actor preserved the original pause provenance. `get()`, `inspect()`, exec and files never resume implicitly. Missing, expired or deleted state is `NOT_FOUND`, with no replacement allocation.

Both operations have one dispatch stage and no automatic retry or inverse action. Already inactive suspend and already running resume reject `CONFLICT`; transitional resources reject `UNAVAILABLE`. ACK plus a target-state read establishes completion. An acknowledged partial error retains native preservation facts even if the later read fails; ACK alone does not certify target state. A lost response, 409 or 503 stays uncertain even if a later read matches the target. Use the error's recovery reference to observe without replay. Applications serialize lifecycle changes across external controllers.

See the [compiled same-workflow example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-suspend-resume.ts). Deterministic native-boundary and packed Node/Bun checks cover this mapping; live qualification is recorded above. Existing snapshot requirements retain their exact matching semantics.
