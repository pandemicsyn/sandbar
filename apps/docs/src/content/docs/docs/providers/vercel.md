---
title: Vercel Sandbox
description: Run commands, work with files, suspend persistent sandboxes, and restore filesystem snapshots on Vercel.
---

Use `@sandbar-sdk/vercel` with `sandbar-sdk` to run short-lived Vercel sandboxes. The adapter supports commands with byte input/output, files and file streams, filesystem snapshots, lifetime extensions, and public HTTP previews. The default universal image also provides long-running processes and terminals.

Set `persistent: true` to save files when compute stops and explicitly resume them in a fresh VM.

The implementation has automated and packaged-consumer tests. It has **not been tested against the live Vercel service** yet.

## Connect and run a command

Install with `npm install sandbar-sdk @sandbar-sdk/vercel`. Use an existing Vercel team and project, plus a token that can access their sandboxes.

```ts
import { Sandbar } from "sandbar-sdk";
import { vercel } from "@sandbar-sdk/vercel";

const client = await Sandbar.connect({
  adapter: vercel,
  config: {
    teamId: process.env.SANDBAR_VERCEL_TEAM_ID!,
    projectId: process.env.SANDBAR_VERCEL_PROJECT_ID!,
    region: "iad1",
    timeoutSeconds: 300,
    network: "blocked",
  },
  credentials: { token: process.env.VERCEL_TOKEN! },
});
try {
  const box = await client.sandboxes.create();
  try {
    await box.writeFile("/tmp/example.bin", new Uint8Array([0, 255, 129]), { overwrite: true });
    console.log(await box.readFile("/tmp/example.bin"));
    console.log((await box.exec(["node", "-e", "console.log('ready')"])).stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

`Sandbar.connect` checks the team, project and access using read-only requests. Creating the client does not allocate compute. Keep the token in `credentials`; saved sandbox references contain no credentials.

## Choose the sandbox setup

| Option                | Default                           | What it controls                                                                                                                                                                                             |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `teamId`, `projectId` | Required                          | The existing team and project to use.                                                                                                                                                                        |
| `region`              | `iad1`                            | One of the 19 supported Vercel regions. There is no automatic region failover.                                                                                                                               |
| `image`               | `vercel/sandbox/universal:latest` | Vercel's native default, with processes and terminals. Also accepts Node 22, Node 24 or Node 26 images. Set `vercel/sandbox/node:24` to keep using sandboxes and snapshots created with the earlier default. |
| `vcpus`               | `2`                               | Accepts 2, 4 or 8 CPUs, with 2 GiB memory per CPU. Account limits still apply.                                                                                                                               |
| `timeoutSeconds`      | `900`                             | Initial sandbox lifetime, from 60 to 86,400 seconds. Vercel enforces lower plan limits itself (Hobby: 45 minutes).                                                                                           |
| `network`             | `blocked`                         | `blocked` (native deny-all) or `internet` (native allow-all). Strict network isolation has not been independently tested. Deprecated: `networkPolicy`, `vercel-deny-all`, `vercel-allow-all`.                |
| `ports`               | `[]`                              | Up to 15 distinct public HTTP ports. Leave empty to expose none.                                                                                                                                             |
| `persistent`          | `false`                           | Keep files across stopped sessions. Resume starts fresh compute; processes and RAM are lost.                                                                                                                 |
| `credentials.token`   | Required                          | Token with access to the selected team and project.                                                                                                                                                          |

`client.sandboxes.create()` uses this setup. Any image, region or policy supplied on an individual create call must match it. Arbitrary container images, OCI builds and mounted drives are not supported.

`create({ env })` sets Vercel's native session `env`, which every command inherits unless its own `env` overrides a name; it applies after reopening. Values are not saved in recovery tokens and are redacted from Vercel's error text. Snapshot restore does not take `env`. See [environment variables](/docs/guides/images-and-networking/#set-environment-variables). Live acceptance remains unrun.

## Commands, processes and files

Use ordinary `box.exec` for a command, with arguments or an explicit shell script. It supports working directory, environment variables, and up to 1 MiB of finite stdin. Input bytes are verified before the command starts, and stdin ends after the supplied bytes. Separate stdout and stderr preserve the original bytes, with a combined output limit of 1 MiB and a truncation indicator. See [files and command output](/docs/guides/files-and-output/).

For ongoing input/output or a terminal, keep the default `vercel/sandbox/universal:latest` image. The process APIs support text and binary output, byte input, closing stdin, status, SIGTERM/SIGKILL, terminal resize, and disconnect/reopen. A reopened process reports a possible output gap; it does not replay old output. Disconnecting locally does not stop the remote process. Node-only images do not provide these process features.

File reads and writes preserve bytes. Use file streams for files larger than the 1 MiB buffered limit. Directory listing, stat, exists, mkdir, remove, copy and move are supported. Paths must be absolute. Directory listings are sorted and complete, with a limit of 1,024 entries and 65,536 bytes of names; larger listings fail instead of returning an incomplete result.

Writes and copies prepare a temporary file before replacing the destination. `overwrite: false` protects an existing destination even if another writer races the operation. Moves stay on the same filesystem; a move with `overwrite: false` requires the universal image. Recursive directory changes require explicit opt-in. Interrupted transfers report known temporary paths, which may remain until the sandbox is destroyed. See the [adapter README](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/README.md) for detailed filesystem limits.

## Lifetime, cleanup and reopening

By default, each sandbox reference identifies one original VM session. `box.destroy()` stops that session and waits for confirmed termination. It retains Vercel's named sandbox metadata because this default reference identifies only the VM session. Persistent mode tracks the logical sandbox separately, as described below. Closing the client releases local resources; destroy owned sandboxes separately. The native timeout is a fallback, not proof that cleanup finished.

`box.renew({ forSeconds: 61 })` **adds** 61 seconds to the running session's timeout. Each request accepts 1–86,400 seconds; Vercel caps total session time by plan (Hobby 45 minutes, Pro/Enterprise 24 hours) and native rejection remains an error. See [Vercel Sandbox pricing and limits](https://vercel.com/docs/sandbox/pricing). Inspecting or reopening a sandbox never renews or resumes it.

Save `box.reference` in trusted application storage, then pass it to `freshClient.sandboxes.get(savedReference)` using the same team, project and region with current credentials. This reopens the original session without creating compute. A lookup searches at most 10,000 project sessions and fails if it cannot verify membership. See [resource references](/docs/guides/resources/) and [recovery](/docs/guides/recovery/).

`sandboxes.list()` lists sandboxes in the configured project and region. In session mode it reports `coverage: "provider-scope"` and lists every session-mode sandbox. With `persistent: true` it reports `"sandbar-managed"` and lists only named sandboxes with Sandbar's creation tag; their references carry the native generation used to detect a replaced name. Vercel does not record the creating operation, so listed references have `ownership: "unknown"` and no creation receipt. They reopen with `get()`.

If a mutation response is lost, the adapter preserves known IDs and uncertainty. Recovery reads the original operation's evidence; it never repeats create, input delivery, snapshot, restore or delete. A confirmed command exit remains available even if reading its output later fails. Unverified or interrupted input stages and capture receipts can remain until sandbox teardown.

When Vercel refuses a create outright, `create()` rejects with a matching error code and Vercel's own reason: HTTP 400 and 422 map to `INVALID_ARGUMENT`, 401 to `UNAUTHENTICATED`, 402 to `CAPACITY`, 403 to `FORBIDDEN`, 404 to `NOT_FOUND` and 429 to `RATE_LIMIT`. Nothing was created, so you can fix the cause and create again. A 409, a server error or a lost response stays `OUTCOME_UNKNOWN`.

## Save files and resume later

Set `persistent: true` in adapter configuration before creating the sandbox. Use `await box.suspend()` to stop compute and save its filesystem. Later, call `await box.resume()` to start a fresh VM with those files. The saved sandbox reference stays the same; `inspect().execution` identifies the current VM session.

Suspension ends running processes and drops connections. **RAM is not saved.** Restart servers and other processes after resume. Commands, file operations, inspection and reopening never resume an inactive sandbox automatically; call `resume()` first. The session timeout also stops persistent compute and triggers Vercel's filesystem checkpoint.

Save `box.reference`, close the client, and reopen with `freshClient.sandboxes.get(savedReference)` using the same persistent setup and current credentials. This works while compute is inactive. The adapter checks Vercel's creation timestamp and saved creation tag, so a detected replacement with the same name is rejected.

Serialize lifecycle changes for a sandbox, including changes made outside Sandbar. Vercel has no atomic generation condition on named resume or deletion: an external actor could replace a name between validation and dispatch. The adapter checks before and after; it cannot prevent an effect on that replacement during this race. Keep Sandbar's generated names and reserved creation tags under your application's control. Changing sandbox settings outside Sandbar is unsupported; named reads reject observed mount, CPU, image, port or policy mismatches.

Vercel bills stored checkpoints separately. The adapter requests one rolling checkpoint and deletion of evicted automatic checkpoints. Vercel's expiration limits still apply, so persistence is not a permanent storage guarantee. Persistent `destroy()` stops compute, deletes the named sandbox without cascading snapshot deletion, and reports retained snapshot IDs. Delete those snapshots separately when no longer needed. A lost response remains uncertain and is never retried automatically.

Reusable `box.snapshot()` capture uses the default disposable mode. In persistent mode, use suspension for a checkpoint of the same logical sandbox; reusable capture is unsupported. Restoring a previously captured snapshot can create a new persistent sandbox when configured that way.

## Filesystem snapshots

**`box.snapshot()` terminates the source sandbox.** It captures filesystem state, drops processes and connections, and does not preserve RAM. Restoring creates a new, independent session with fresh execution; it does not restart the source. See [snapshots and volumes](/docs/guides/snapshots-and-volumes/) for the SDK workflow.

Capture requires a disposable sandbox with no mounted drives, using a supported managed image. The source must have been created or restored in the current connection, or its validated creation operation must have been recovered there. Reopening only a sandbox reference does not provide the image evidence needed for capture.

Keep the snapshot's saved reference. It records the captured source and image so later inspection and restore can check them against Vercel. Restore requires the same configured managed image. Snapshots found only through native inventory have unknown capture details and cannot automatically be restored through Sandbar.

Snapshot consistency is unknown. You can explicitly assert that you stopped writes before capture; the adapter preserves that assertion without independently verifying it. Minimum retention is not guaranteed. Requests requiring RAM, an uninterrupted source, guaranteed crash consistency or guaranteed minimum retention fail before capture. Scheduled deletion is unsupported. Vercel's snapshot expiration and billing still apply; **delete owned snapshots independently of compute cleanup**.

A lost capture response may leave an artifact whose ID is unknown. The adapter does not guess ownership from a name or source match. Retain the operation reference for investigation instead of creating another snapshot or deleting a possible match.

## Public previews

Set `ports: [3000]` in adapter configuration, then use `box.preview(3000)` to obtain the running session's public HTTPS URL. The port is public from sandbox creation, even before your application is ready. The URL itself does not prove readiness.

Protected previews are not supported. Outbound network policy does not authenticate incoming requests. See [preview access](/docs/guides/preview-access/).

## Remaining limits and evidence

Drives and mounts remain unsupported. Persistent mode supports filesystem suspension and fresh execution on resume, with the concurrency and retention limits above. Custom images, custom firewall rules and automatic OIDC credential discovery are also outside the implemented setup.

The [native audit](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/NATIVE.md) records the published Vercel SDK 3.6.1 evidence and implementation choices. [Support declarations](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/qualification/support.md) are separate from [live test results](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/qualification/live-qualification.md), which remain not-run. The [live qualification proposal](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/qualification-plan.md) lists resource budgets and cleanup requirements; running it needs separate authorization.
