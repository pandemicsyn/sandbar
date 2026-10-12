---
title: Vercel Sandbox
description: Use the Vercel adapter with disposable Node 24 sessions and configured network policies.
---

Vercel Sandbox is an official adapter distributed as `@sandbar-sdk/vercel`, used alongside `sandbar-sdk`. It is implemented for immutable, nonpersistent sessions with managed Node 24 in `iad1`. The adapter landed in #93 and is included in the initial 0.1.0 release group. Live provider behavior is unverified; version preparation and registry publication are separate from implementation. Use the [checkout setup](/docs/direct-quickstart/) until a usable release is available.

```ts
import { Sandbar } from "sandbar-sdk";
import { vercel } from "@sandbar-sdk/vercel";

const client = await Sandbar.connect({
  adapter: vercel,
  config: {
    teamId: process.env.SANDBAR_VERCEL_TEAM_ID!,
    projectId: process.env.SANDBAR_VERCEL_PROJECT_ID!,
    networkPolicy: "vercel-deny-all",
    timeoutSeconds: 300,
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

The bearer token must access the existing team, project and sandbox API. Connection verifies team/project ownership and binds scope to the verified team, project and `iad1` region. Credentials are separate from saved routing and recovery identities. The adapter owns a version-sensitive REST transport audited against published `@vercel/sandbox@3.6.1`, without installing that native SDK. No public stability guarantee for this source-derived boundary has been established, and the audit supplies no live acceptance evidence.

Calling `client.sandboxes.create()` uses the managed prepared environment `vercel/sandbox/node:24` and the connection's configured named policy. Explicit creation inputs must select that same environment and policy. `region` defaults to `iad1`, `timeoutSeconds` defaults to 300 and accepts 60–300, and `networkPolicy` defaults to `vercel-deny-all`. The alternative `vercel-allow-all` maps to native `allow-all`; deny maps to native `deny-all`. Acknowledged policy is checked, but measured network isolation has no live acceptance. Generic `blocked`/`internet` policies, custom images, OCI builds, resource requirements and mounts are unsupported.

Commands support argv, `/bin/sh` scripts, cwd/env and nonzero exits. A managed Node helper captures binary stdout/stderr in a private receipt, with a combined 1 MiB bound and truncation reporting. The adapter manages capture internally: `const result = await box.exec(["my-command"]); const bytes = result.stdout;` requires no helper installation or encoding configuration. File reads preserve binary API bytes; writes send gzip/tar archives. Absolute paths and at most 1 MiB per file are supported. Writes require `overwrite:true`; atomic no-clobber rejects before mutation. Stdin, process handles, streaming interaction and PTYs are unsupported.

Destroy stops and polls the exact original session, confirming compute stop only on native `stopped` or `aborted`. It reports retained `vercel-named-sandbox-metadata`; deleting that metadata is unsupported. Native timeout is fallback, not cleanup confirmation. Close releases the local client; explicit sandbox destruction remains necessary.

An acknowledged create saves its exact session ID for read-only recovery. Losing the response before an ID is known leaves uncertainty; inventory and tags cannot recover that attempt. Acknowledged commands checkpoint the original command/session IDs and recover the saved receipt through read-only observation without replay. When the helper confirms the guest exit, the adapter checkpoints `confirmedExit` in the existing recovery token before reading the output receipt. If output retrieval then fails, the public operation recovery reference retains that confirmed exit status; it does not claim complete output or a successful execution result. Read-only recovery checks later receipt evidence against the saved exit and never reruns the command. A lost launch acknowledgement has no command ID to recover. Writes have no reconciliation token and are never automatically replayed. Destroy observation reads the original session without another stop; a missing session is not proof of termination. Save `box.reference` in trusted application storage and reopen with `await freshClient.sandboxes.get(savedReference)` using current credentials and matching scope. `get` reads the original identity without creating, resuming or renewing compute; project session reads verify membership before accessing a reopened session. Saved operation references remain separate evidence for uncertain submissions.

Snapshots, memory preservation, restored execution, volumes, persistent sandboxes, mounts, suspension, resumption and lifetime renewal are unsupported. Snapshot requirements reject before capture, so no capture exclusions, source transitions or restore guarantees apply.

The repository's external `vercel-profile.ts` supplies declared support, nonsecret saved routing and finite bounds to the ordinary Bun qualification suites: 300-second native lifetime, 120-second exercise and 60-second cleanup. Baseline fixtures permit one compute allocation each; storage suites skip unsupported workflows. The existing E2B-only paired network test does not qualify Vercel policies. No live evidence has been recorded. Deterministic fixtures, packed consumers and live acceptance remain separate statuses.

See the generated [Vercel support declarations](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/qualification/support.md) and [live evidence](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/vercel/qualification/live-qualification.md) for per-feature status.
