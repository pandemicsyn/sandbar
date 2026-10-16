# @sandbar-sdk/vercel

Official Vercel Sandbox adapter for Sandbar, installed separately as `@sandbar-sdk/vercel`. Implements disposable sessions, binary execution/stdin, filesystem helpers/streams, snapshots, renewal, optional public previews and universal-image processes/PTYs. Live provider behavior is unverified; deterministic fixtures and packed consumer checks are separate from live qualification.

Install with `npm install sandbar-sdk @sandbar-sdk/vercel`:

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

`Sandbar.connect` verifies the team and project ownership with authenticated reads and checks project sandbox access. Scope includes the verified team ID, project ID and region. Tokens stay in credentials. Importing the adapter and constructing a connection definition perform no provider IO. The transport uses source-derived Vercel API routes audited from published SDK 3.6.1, with single-attempt requests (see [native boundary provenance](NATIVE.md)); `createVercelAdapter` accepts host-owned transport injection for deterministic fixtures.

| Configuration | Requirement/default |
| --- | --- |
| `teamId`, `projectId` | Existing team/project; authenticated ownership is checked. |
| `region` | Default `iad1`; all 19 regions in the audited native catalog are accepted. No automatic failover. |
| `image` | Default `vercel/sandbox/node:24`; also Node 22, Node 26, or `vercel/sandbox/universal:latest`. The universal image enables Python-backed process/PTY support. |
| `vcpus` | 2 (default), 4, or 8; native memory is 2 GiB per vCPU. Account quotas apply. |
| `timeoutSeconds` | Initial lifetime 60–300 seconds, default 300. |
| `network` | `blocked` (default, native deny-all) or `internet` (native allow-all). Deprecated: `networkPolicy`, `vercel-deny-all`, `vercel-allow-all`. No measured isolation claim. |
| `ports` | Default empty; up to 15 distinct explicitly exposed public HTTP ports. |
| `credentials.token` | Bearer token with team/project sandbox access. |

Ordinary `sandboxes.create()` uses the configured managed image and named policy. Explicit image/policy/region inputs must match setup. Creation validates the acknowledged session, image, CPU count, timeout, mount-free configuration and exposed routes. An incomplete or mismatched ACK preserves the known session through a partial outcome for explicit cleanup; it never substitutes a resource or repeats creation. OCI builds, arbitrary images, mounts and automatic region failover remain unsupported. Custom VCR images are native functionality, but their readiness and helper prerequisites have no implemented verified mapping here.

By default every sandbox ID and saved reference names an immutable VM session. Destroy stops and polls that original session until `stopped` or `aborted` confirms termination, and reports `vercel-named-sandbox-metadata` retained. Named metadata is not deleted: published name-addressed DELETE has no generation predicate. Native timeout is fallback, never a cleanup receipt. Closing the client releases local transport and waits; explicitly destroy owned compute.

`renew({ forSeconds })` sends one additive timeout extension to a running original session. The requested window is 1–300 seconds, defaulting to setup lifetime; native cumulative-runtime/plan caps still apply. The result preserves acknowledgement separately from expiry observation. A missing ACK remains unknown, even if later inspection shows a longer deadline, and is never replayed. `get`/inspect/preview never renew or resume.

Commands preserve argv, explicit `/bin/sh -c`, cwd/env, exit evidence and original stdout/stderr bytes. Combined finite output is bounded to 1 MiB with truthful truncation. Finite stdin accepts up to 1 MiB, staged internally with private permissions, then supplied to the child followed by EOF. Applications use ordinary `box.exec`; they configure no encoding or helper. Staged input identity is saved before upload and retained when launch acknowledgement is lost. Capture receipts and interrupted input stages can remain until compute teardown. Deadlines kill the helper's child process group; aborting a local request does not prove remote termination. Confirmed exit is checkpointed before output retrieval and survives output-read failure; recovery reads the original receipt without rerunning the command.

On `image: "vercel/sandbox/universal:latest"`, ordinary process and terminal calls support sustained text/original-byte output, incremental byte stdin/EOF, status, SIGTERM/SIGKILL, explicit PTYs with resize, bounded callback-exec capture, disconnect and leased reopening. A Python standard-library supervisor owns one private Unix socket and bounded pipe queue per child. It installs no packages and exposes no network listener. Native command invocations carry bounded ASCII JSON control replies; user output is encoded before entering text logs. Process runtime is bounded by the sandbox lifetime, not an invented process timeout. Local detach is separate from remote exit. Reopening fences stale attachment leases and honestly reports an output gap; no transcript replay or descendant-termination guarantee. The Node-only image choices reject these process profiles before launch because Python is not an established prerequisite there.

Files preserve bytes. Buffered reads/writes are capped at 1 MiB; use SDK streams for larger files. Paths are absolute and exclude trailing slashes (except root browsing), NUL and dot segments. Directory results are complete, sorted and bounded to 1,024 entries/65,536 name bytes; overflow rejects. Stat defaults to lstat, dangling links exist, mkdir/remove honor recursive opt-in and refuse root mutation. Copy accepts regular files. Same-filesystem move never falls back to copy/delete; no-clobber move requires the universal image's Python3 and Linux `renameat2`. Other image choices support overwrite moves and reject no-clobber moves before mutation.

Writes and copies stage in the destination directory, then publish with rename for overwrite or a race-safe hard link for no-clobber. Stream writes upload/append sequential 64 KiB chunks with bounded memory and publish only after EOF; stream reads consume the native binary body incrementally. There is no default whole-file ceiling or adapter-imposed total stream timeout. Transfer cancellation/unknown outcomes retain known temporary paths and confirmed publication effects; staging is not a rollback or durable-storage guarantee. Ordinary confirmed write conflicts clean their staging file. Interrupted stages remain within the owned sandbox until explicit teardown. Filesystem mutation observation never repeats a mutation.

`box.preview(port)` returns the original running session's public HTTPS route for an explicitly configured port. It is read-only and is not readiness evidence. Exposed ports are public from creation, including image-owned services. Default `ports: []` publishes none. Protected previews have no implemented native credential mapping; egress policy does not provide preview authentication.

`box.snapshot()` captures native filesystem state and **terminates the disposable source session**, dropping processes/connections. It captures no RAM and never creates a replacement source to simulate restart. Only a verified mount-free disposable managed Node/universal source is accepted. Default consistency and minimum retention are unknown; exact memory, uninterrupted/source-unchanged, crash-consistency or minimum-retention requirements reject before capture. Caller-quiesced consistency is retained as a caller assertion. Scheduled deletion is unsupported. Vercel's native retention/expiration policy and billing apply; independently delete owned snapshots.

Snapshot capture checkpoints the exact artifact ID before parsing full capture evidence. Capture requires a source created, restored or recovered from its validated creation attempt in the current connection, so its observed digest is checked against native metadata. Reopening only a sandbox reference does not retain that evidence. Saved snapshot references retain observed source/image/mount/consistency provenance, separately from authorization; fresh credentials still verify project membership and region by native reads. Capture and restore require the same configured managed image. Restore omits an image selector and requests the native snapshot source, then verifies the configured managed image, resources, policy and new session identity. Restored execution is fresh with an independent lifecycle. Snapshot inspect/list/delete use immutable artifact IDs; deletion requires a native deleted receipt, not absence alone. Native inventory entries without Sandbar's observed capture provenance report unknown mount handling and do not automatically become restorable. Original compute teardown retains named metadata; snapshot references survive it. Lost capture acknowledgement without an artifact ID cannot be safely attributed from source/name matching alone; preserve the source attempt for manual investigation rather than adopting or deleting an unrelated snapshot. No capture/restore/delete mutation is replayed to recover a response.

Persistent sandbox mode supports explicit filesystem suspension and fresh-session resume as described below. Drives and mounts remain unsupported: their separate storage lifecycle and name-addressed selection have no established safe mapping. Native sandbox persistence does not preserve RAM.

Save the ordinary sandbox reference in trusted application storage, then reopen the same session on a fresh connection with current credentials:

```ts
const box = await client.sandboxes.create();
if (!box.reference) throw new Error("Verified sandbox reference is unavailable");
await save(box.reference); // Application-owned persistence.
// After opening freshClient with the original team/project/region:
const reopened = await freshClient.sandboxes.get(await load());
console.log((await reopened.inspect()).state);
```

`save` and `load` represent your application's trusted reference store. `get` reads the original identity without creating, resuming or renewing compute. Reopened membership lookup is bounded to 100 pages of 100 sessions; an identity outside that window fails closed. Saved operation references remain useful for uncertain submitted operations and read-only reconciliation; they are separate from the sandbox's resource reference.

The qualification profile selects the universal image, native lifetime 300 seconds, exercise 120 seconds and cleanup 60 seconds. Ordinary Bun workflows now cover terminating-source snapshots and additive renewal; provider fixtures cover faults separately. Loading the profile performs no IO. No live calls have been run. See [the concrete live proposal](qualification-plan.md) for budgets, retained artifacts and owned cleanup; it requires separate user authorization.

Declared support and the empty live record are rendered in [qualification/support.md](qualification/support.md) and [qualification/live-qualification.md](qualification/live-qualification.md). Regenerate from the repository root without provider IO:

```sh
bun packages/sdk-qualification/provider-qualification/render.ts \
  --profile packages/sdk-qualification/provider-qualification/vercel-profile.ts \
  --results packages/providers/vercel/qualification/results \
  --output packages/providers/vercel/qualification
```

Append `--check` to verify drift. The empty results file intentionally supplies no fabricated fixture or live observations.


## Persistent mode

Set `persistent: true` in adapter configuration. A sandbox ID is then Vercel's generated sandbox name, with creation generation evidence from native `createdAt` and the acknowledged `sandbarSubmission` tag. The current VM session is execution identity, not resource identity. `suspend()` checkpoints the filesystem and ends processes/connections; `resume()` starts fresh execution with the saved files and a new session ID. RAM is not preserved. Reopen and inspect use explicit `resume=false`; commands and files require explicit resume before guest IO. Every guest operation pins one exact session; it never follows a changed session midway through an upload or command. Saved references work across fresh connections with current credentials.

Caller serialization includes external lifecycle controllers. Named resume and DELETE have no atomic generation predicate. Checks reject a detected replacement, but cannot prevent a concurrent external replacement between check and dispatch from receiving an effect. Generated names and reserved tags must remain application-controlled. Out-of-band configuration changes are unsupported; named reads reject observed mounts, CPU, image, port or policy mismatches. Lost mutation responses remain unknown and are never replayed.

The adapter requests one rolling automatic checkpoint with eviction deletion; native expiration and storage billing apply. Persistent destroy stops the pinned compute, lists retained snapshots, validates generation again, deletes named metadata without an orphan cascade, confirms absence and checks retained snapshot IDs. Those IDs are reported for separate storage cleanup. Uncertain deletion retains known snapshot identities in its recovery checkpoint. More than 128 retained snapshots prevents metadata deletion and leaves stopped compute with uncertain cleanup. Disposable destroy retains its original behavior. Reusable snapshot capture requires disposable mode; suspension is the persistent checkpoint workflow. Snapshot restore supports creating a new persistent sandbox.
