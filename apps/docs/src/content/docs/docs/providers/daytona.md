---
title: Daytona
description: Connect to Daytona with explicit region, prepared image, and network policy settings.
---

Import `daytona` from `sandbar-sdk/daytona`. Start with an active Linux snapshot in your target region. The example uses strict blocked networking, which requires eligible organization settings; the policy section below shows the explicit `daytona-default` alternative.

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

// Provider setup: adapter credentials, region/template and prepared image.
const client = await Sandbar.connect(
  daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    target: "us",
    environment: Image.prepared("daytona-small"),
    lifecycle: { lifetimeSeconds: 600 },
  }),
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

Set `DAYTONA_API_KEY` before running this on the server. The snapshot must be active, Linux-compatible, and available to the verified organization in the selected region. Public/general snapshots can be borrowed; they are never owned cleanup targets.

## Connection options

| Option                          | Default   | Purpose                                                                          |
| ------------------------------- | --------- | -------------------------------------------------------------------------------- |
| `apiKey`                        | Required  | Daytona API key.                                                                 |
| `environment`                   | Omitted   | Default prepared or OCI environment for creation; per-call environment wins.     |
| `target`                        | Required  | Available native region ID, such as `us`.                                        |
| `lifecycle.lifetimeSeconds`     | Omitted   | Initial/default renewal window in seconds; mutually exclusive with `ttlMinutes`. |
| `ttlMinutes`                    | `60`      | Native sandbox lifetime, from 1 to 1,440 minutes.                                |
| `snapshots.restartAfterCapture` | `true`    | Restart only a previously running capture source.                                |
| `networkPolicy`                 | `blocked` | `blocked` or explicit `daytona-default`.                                         |

`Sandbar.connect` verifies native organization and region with authenticated reads. Scope includes the organization, target, endpoint, and selected network policy. Use the same scope to recover a prior operation.

`create()`, `create({ labels: { job: "report" } })`, `checkCreate()` and `submitCreate()` use the configured environment. Without one, pass `create({ environment: Image.prepared("your-snapshot") })`; missing both rejects with `INVALID_ARGUMENT` before creation. Scoped prepared images retain scope checks. An invalid override never falls back or triggers an unrequested build. Default-creation live acceptance remains unrun.

## Choose the policy deliberately

`daytona-default` preserves Daytona's organization-managed restrictions, including essential-service access. Select it on **both** the connection and create request. It does not promise unrestricted internet or strict blocked egress.

Omitting the policy selects `blocked`. This requires successful organization eligibility verification and native block-all support; a restricted or unreadable eligibility response disables creation. Tier 1/2 essential-service exceptions do not meet Sandbar's strict blocked contract. There is no automatic fallback, and the adapter does not expose an unrestricted `internet` mode.

## Image requirements

Commands support argv and POSIX shell. Binary output capture requires `/bin/sh`, `mktemp`, `mkfifo`, `cat`, `wc`, `head`, `od`, and `rm`. File staging and receipts also need `mkdir`, `rmdir`, `mv`, and compatible copy/link utilities. Atomic no-clobber requires `ln -T` and hard-link support.

The live baseline uses the prepared `daytona-small` workflow in `us`; it does not qualify arbitrary snapshots. Explicit OCI builds are implemented but need separate live evidence and cleanup for retained snapshots. See [Images and networking](/docs/guides/images-and-networking/).

## Everyday filesystem and transfers

`readDirectory`, strict `listFiles`, `statFile`, `fileExists`, mkdir/remove, copy/move and byte streams share the [portable file API](/docs/guides/files-and-output/). Complete enumeration, link identity and race-safe nonrecursive removal use a bounded adapter-owned Python 3 subprocess. Paths travel as exact arguments; no human-formatted listing is parsed and no dependencies are installed. The image must supply Python 3 and Linux; no-clobber rename additionally needs Linux libc `renameat2`. Intermediate links follow the guest namespace, while final links remain entries. Directory observations do not stat each child through a remote request.

Transfers use the existing authenticated `/files/download` response body and incremental multipart `/files/upload-v2` request body. Writes reserve a private same-directory staging directory, then publish once with native rename collision handling. Copy stages regular-file bytes with bounded guest IO. Move uses native same-filesystem rename and never falls back to copy/delete. Object-backed mounted destinations cannot provide the staging/publication guarantee and reject these mutations before effects; private-filesystem guarantees do not qualify mounted storage. Request abort is best effort, and uncertain publish or cleanup retains known paths without replay.

The expanded ordinary Bun `file-directories` case passed at `2f6afe8` on October 8, 2026, using the shared compiled artifact recipe and one 32 MiB streaming roundtrip with a complete SHA-256 comparison. Owned sandbox destruction and client close were confirmed. This qualifies the recorded borrowed image/configuration; other images and mounted storage remain outside that pass. Native-boundary fixtures, packed consumers and exact live provenance are reported separately in [provider support](/docs/providers/support/).

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

Set `lifecycle: { lifetimeSeconds: 600 }` in adapter setup for the initial lifetime and default `renew()` window. Omission keeps the existing 60-minute `ttlMinutes` default. Supplying both `lifecycle.lifetimeSeconds` and `ttlMinutes` rejects during connection before native effects. These defaults stay local to the connection: reopening uses the new connection's default only when you explicitly call `renew()`. `get()` and `inspect()` never apply it.

Daytona rounds positive integer seconds upward to whole minutes: 1 → 60, 61 → 120. The resolved ceiling is 86,400 seconds (24 hours). One native TTL POST resets the hard deadline from provider processing and expiry destroys the sandbox. This clock keeps ticking while stopped or archived and can delete saved files. Idle stop and deletion after stopping are separate policies; renewing does not disable them. The returned observation reports `autoDestroyAt` when available. See [native wall-clock TTL](https://www.daytona.io/docs/en/sandboxes/#wall-clock-ttl).

Both mappings require running compute. Use positive safe integer seconds; upper bounds and invalid inputs reject before the renewal POST without downward rounding or clamping. Native account/region/runtime limits can be tighter and native rejection remains an error. Renewal may shorten an existing longer deadline, is not additive, and does not guarantee uninterrupted execution or exact expiry scheduling. Serialize lifecycle changes across application and external controllers.

`RenewResult.requested.forSeconds` records the resolved native setting, `acknowledged: true` confirms provider acceptance, and `observation` is current metadata or `null` if the follow-up read failed. A lost ACK stays `OUTCOME_UNKNOWN` even if a later deadline looks right. `submitRenew()` and `client.recover(savedOperationReference)` use existing typed recovery; observation never sends another renewal POST. Caller cancellation before dispatch has no effect; after possible dispatch it stops local waiting with the recovery reference. Persist ordinary sandbox references in your own trusted store, and save result metadata separately when useful.

Renewal has deterministic native-boundary and packed Node/Bun coverage. The maintained `lifecycle-renew` case passed at `3188e33` in us with confirmed owned cleanup; the pass covers its recorded configuration. Sandbar suspend/resume methods use the native policies below; the Daytona lifecycle case passed at `6796b30` with confirmed cleanup.

## Runtime snapshots

`box.snapshot()` stops a running container, captures its private filesystem, and starts the source again. An already-stopped source stays stopped. Stopping ends the former processes; restart and restore use fresh process execution. Memory and external volumes are not captured. The Bun filesystem roundtrip passed at `1505ee0` in `us` using `daytona-default`, including two-way isolation, separate-process reopening, source deletion and owned cleanup. The [generated support table](/docs/providers/support/) retains historical revisions and limits; this is not a current-head live pass.

Configure `snapshots: { restartAfterCapture: false }` on `daytona(...)` to leave a running source stopped. The default is `true`, restarting only a previously running source. Optional snapshot requirements validate the configured behavior without selecting another mode. Consistency defaults to unknown; `consistency: "caller-quiesced"` attests that the application quiesced writers.

A definitive capture failure permits one bounded restart attempt. A successful capture followed by a definitive restart failure throws `SOURCE_RESTART_FAILED` with the snapshot reference and capture details directly in its typed partial outcome. An uncertain restart remains `OUTCOME_UNKNOWN` and preserves known capture details. Uncertain stop/capture/start outcomes are observed without repeating lifecycle calls. If a delayed capture later completes or definitively fails, explicit `operation.continue()` can finish a configured restart proven never submitted. The SDK awaits reference persistence before each stage dispatch. Serialize continuations through an application lease or compare-and-swap across processes; a lost response after a dispatch marker cannot be replayed. Saved history reopens with current valid credentials for the same verified organization scope. Native capture is experimental; VM filesystem/memory capture is not mapped. See [Daytona snapshot requirements](https://www.daytona.io/docs/en/snapshots/#create-snapshot-from-sandbox).

## Cleanup and recovery

Deletion can be asynchronous. `destroy()` waits for confirmed termination; if the response becomes uncertain, save its reference and observe instead of issuing another delete. `close()` does not stop compute. Borrowed snapshots remain untouched, and built snapshots need separate owned-artifact cleanup.

See [Tested provider support](/docs/providers/support/) for measured coverage and [Errors and recovery](/docs/guides/recovery/) for handling lost responses.

## Snapshots and retained volumes

Application-retained capture history supports independent restore after source deletion; borrowed image selectors do not become owned snapshot artifacts. Snapshot deletion rechecks organization warm pools, blocking when dependencies are present or unreadable because native deletion cascades to warm pools and unclaimed compute. Writable object-backed volumes attach at create, or during fresh restore of a known mount-free filesystem snapshot, with optional subpaths. Restore with mounts requires explicit `daytona-default`; `blocked` rejects because first-workload policy ordering is unqualified. Exact snapshot and complete selected volume IDs are checked without post-create attachment. Mounted capture and memory composition remain unsupported. The first bounded startup case at `824946d` passed A startup evidence, then failed a harness snapshot-name/ID assertion before B. The corrected full workflow passed at `5911ccc` on Bun 1.3.14 in `us` with `daytona-default` and the pinned first-action image: selected A data, independently empty B, captured private state, exact native identities and fresh-client reopening. All owned compute, volumes, capture and temporary import were cleaned up. This pass covers that tested configuration. Native readiness is checked; read-only, volume versions and verified shutdown durability are unavailable. Independent volume CRUD and mounted persistence passed in the Bun acceptance at `1505ee0`; those passes cover the recorded configuration and revision. See [Snapshots and volumes](/docs/guides/snapshots-and-volumes/).

Native mapping evidence: [Daytona snapshots](https://www.daytona.io/docs/snapshots/) and [volumes](https://www.daytona.io/docs/en/volumes/), checked against REST 0.218.0 DTOs.

Mounted volumes are object-backed rather than POSIX filesystems. `writeFile(..., { overwrite: true })` stages bytes privately on the sandbox filesystem before writing and verifying the mounted destination. Atomic no-clobber `writeFile` on mounted paths is unsupported and rejects before effects; ordinary root-filesystem no-clobber writes remain supported. The private staging location must remain outside mounted storage. A completed file write does not certify a shutdown durability barrier.

## Scoped sandbox reopening

Persist `sandbox.reference` from create, restore or recovered results, then use `freshClient.sandboxes.get(savedReference)` to reopen the same native compute. `inspect()` reports fresh state, native state, local observation time and available deadline/policy facts. Reopening never creates, resumes or extends lifetime; inactive compute remains inactive and guest calls require running state. Unknown expiry is not unlimited lifetime, and elapsed expiry does not prove deletion. Native absence, forbidden access, unavailable reads and identity/configuration conflict remain distinct errors.

References contain no credentials or historical observations. Configure current credentials with the original native binding. Applications own trusted persistence and the crash window before saving. Legacy adapters and failed optional native identity reads may leave `reference` null; inspect again for verified identity rather than fabricating a locator from `id`. See the [compiled reopening example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-reopen.ts). This slice has deterministic/packed coverage; its fresh-process `lifecycle-reopen` case passed at `3188e33` in us with confirmed owned cleanup, for the recorded configuration. Configured renewal is available; native suspension/resumption are available on eligible unmounted compute.

Daytona validates organization, region, endpoint, toolbox origin, native network policy and private visibility. `autoDestroyAt` remains a sandbox-wide expiry while stopped/archived. Idle-stop and deletion-after-stop intervals are separate observed policies. A rotated key in the same organization works with the same binding.

## Bounded execution deadlines

Sandbar uses direct REST rather than a Daytona SDK pin; native fixtures follow REST 0.218.0. `deadlineSeconds` (default 300) maps to `/process/execute`'s `timeout` field. Local HTTP waiting uses a separate `(deadlineSeconds + 10) * 1000` timer after preflight; the adapter's receipt window begins after submission. Neither is a total SDK wall-clock bound.

Daytona's [process reference](https://www.daytona.io/docs/en/typescript-sdk/process/) documents server command termination on timeout. Deployed capture-wrapper cleanup, forced-termination receipts and descendant/process-group coverage remain unverified. HTTP timeout or loss alone proves neither command exit nor absence of side effects. Sandbar investigates the original receipt without resubmission or implicit destroy; successful execution with unavailable or malformed output remains unconfirmed. Sandbox `ttlMinutes` is independent. See [execution and waiting timeouts](/docs/guides/resources/#execution-and-waiting-timeouts), including the experimental Modal mapping and caller signals. Offline fixtures establish request wiring and receipt recovery, not live termination.

## Suspend and resume

Configure a minimum guarantee once in adapter setup, then use the same application calls:

```ts
const suspended = await box.suspend();
// Save box.reference in your trusted store, then close the original connection.
const reopened = await freshClient.sandboxes.get(savedReference); // stays inactive
const resumed = await reopened.resume();
await reopened.destroy(); // explicit cleanup of the same native sandbox
```

`daytona({ apiKey, target: "us", lifecycle: { suspension: { preserve: "filesystem" } } })` uses native container stop/start. Omitting the requirement uses the same filesystem default. A memory minimum rejects `UNSUPPORTED` at connection before allocation. Only known containers with known empty mounts and a negative native auto-delete interval qualify; memory/VM/GPU/Windows and mounted suspension are outside this release. Native stop ends processes and drops sockets; resume reports fresh execution with unknown native execution identity. Stopped or archived containers start under the same scoped UUID. There is no force-kill fallback or replacement creation.

The hard TTL continues while stopped/archived and can delete saved files. Resume neither disables nor resets it. Use `inspect()` to read its absolute deadline and request `renew()` while running when needed. Unknown policy/class/mount facts reject before mutation; mounted resources and unmapped classes reject `UNSUPPORTED`; enabled native auto-delete rejects `UNAVAILABLE`. A missing, expired or deleted resource is `NOT_FOUND`.

Both operations have one dispatch stage and no automatic retry or inverse action. Already inactive suspend and already running resume reject `CONFLICT`; transitional resources reject `UNAVAILABLE`. ACK plus a target-state read establishes completion. An acknowledged partial error retains native preservation facts even if the later read fails; ACK alone does not certify target state. A lost response, 409 or 503 stays uncertain even if a later read matches the target. Use the error's recovery reference to observe without replay. Applications serialize lifecycle changes across external controllers.

See the [compiled same-workflow example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-suspend-resume.ts). Deterministic native-boundary and packed Node/Bun checks cover this mapping; the tested live scope is described below. Existing snapshot requirements retain their exact matching semantics.

The maintained Bun `lifecycle-suspend-resume` case passed at `6796b30` on October 2, 2026 with confirmed owned cleanup and client close. It verified inactive fresh-process reopening, unchanged identity/files/expiry, and terminated processes after resume.
