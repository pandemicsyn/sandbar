---
title: Vercel Sandbox
description: Run commands, work with files, and restore filesystem snapshots in disposable Vercel sandboxes.
---

Use `@sandbar-sdk/vercel` with `sandbar-sdk` to run short-lived Vercel sandboxes. The adapter supports commands with byte input/output, files and file streams, filesystem snapshots, lifetime extensions, and public HTTP previews. Select the universal image to also use long-running processes and terminals.

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
    networkPolicy: "vercel-deny-all",
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

| Option                | Default                  | What it controls                                                                                                   |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `teamId`, `projectId` | Required                 | The existing team and project to use.                                                                              |
| `region`              | `iad1`                   | One of the 19 supported Vercel regions. There is no automatic region failover.                                     |
| `image`               | `vercel/sandbox/node:24` | Also accepts Node 22, Node 26, or `vercel/sandbox/universal:latest`. Choose universal for processes and terminals. |
| `vcpus`               | `2`                      | Accepts 2, 4 or 8 CPUs, with 2 GiB memory per CPU. Account limits still apply.                                     |
| `timeoutSeconds`      | `300`                    | Initial sandbox lifetime, from 60 to 300 seconds.                                                                  |
| `networkPolicy`       | `vercel-deny-all`        | Choose the native deny policy or `vercel-allow-all`. Strict network isolation has not been independently tested.   |
| `ports`               | `[]`                     | Up to 15 distinct public HTTP ports. Leave empty to expose none.                                                   |
| `credentials.token`   | Required                 | Token with access to the selected team and project.                                                                |

`client.sandboxes.create()` uses this setup. Any image, region or policy supplied on an individual create call must match it. Arbitrary container images, OCI builds and mounted drives are not supported.

## Commands, processes and files

Use ordinary `box.exec` for a command, with arguments or an explicit shell script. It supports working directory, environment variables, and up to 1 MiB of finite stdin. Input bytes are verified before the command starts, and stdin ends after the supplied bytes. Separate stdout and stderr preserve the original bytes, with a combined output limit of 1 MiB and a truncation indicator. See [files and command output](/docs/guides/files-and-output/).

For ongoing input/output or a terminal, set `image: "vercel/sandbox/universal:latest"`. The process APIs support text and binary output, byte input, closing stdin, status, SIGTERM/SIGKILL, terminal resize, and disconnect/reopen. A reopened process reports a possible output gap; it does not replay old output. Disconnecting locally does not stop the remote process. Node-only images do not provide these process features.

File reads and writes preserve bytes. Use file streams for files larger than the 1 MiB buffered limit. Directory listing, stat, exists, mkdir, remove, copy and move are supported. Paths must be absolute. Directory listings are sorted and complete, with a limit of 1,024 entries and 65,536 bytes of names; larger listings fail instead of returning an incomplete result.

Writes and copies prepare a temporary file before replacing the destination. `overwrite: false` protects an existing destination even if another writer races the operation. Moves stay on the same filesystem; a move with `overwrite: false` requires the universal image. Recursive directory changes require explicit opt-in. Interrupted transfers report known temporary paths, which may remain until the sandbox is destroyed. See the [adapter README](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/README.md) for detailed filesystem limits.

## Lifetime, cleanup and reopening

Each sandbox reference identifies one original VM session. `box.destroy()` stops that session and waits for confirmed termination. It retains Vercel's named sandbox metadata: the native delete API addresses a reusable name, so the adapter cannot safely guarantee it would delete the original resource. Closing the client releases local resources; destroy owned sandboxes separately. The native timeout is a fallback, not proof that cleanup finished.

`box.renew({ forSeconds: 61 })` **adds** 61 seconds to the running session's timeout. Each request accepts 1–300 seconds; Vercel's plan and total-runtime limits still apply. Inspecting or reopening a sandbox never renews or resumes it.

Save `box.reference` in trusted application storage, then pass it to `freshClient.sandboxes.get(savedReference)` using the same team, project and region with current credentials. This reopens the original session without creating compute. A lookup searches at most 10,000 project sessions and fails if it cannot verify membership. See [resource references](/docs/guides/resources/) and [recovery](/docs/guides/recovery/).

If a mutation response is lost, the adapter preserves known IDs and uncertainty. Recovery reads the original operation's evidence; it never repeats create, input delivery, snapshot, restore or delete. A confirmed command exit remains available even if reading its output later fails. Unverified or interrupted input stages and capture receipts can remain until sandbox teardown.

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

Persistent sandboxes, suspend/resume, drives and mounts remain unsupported. Their native operations use reusable names without a way to restrict a mutation to the saved resource generation. The adapter does not silently switch an old reference to a replacement session. Custom images, custom firewall rules and automatic OIDC credential discovery are also outside the implemented setup.

The [native audit](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/NATIVE.md) records the published Vercel SDK 3.6.1 evidence and implementation choices. [Support declarations](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/qualification/support.md) are separate from [live test results](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/qualification/live-qualification.md), which remain not-run. The [live qualification proposal](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/qualification-plan.md) lists resource budgets and cleanup requirements; running it needs separate authorization.
