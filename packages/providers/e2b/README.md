# E2B built-in adapter

Install `sandbar-sdk` and import the built-in subpath:

```ts
import { Sandbar, Image } from "sandbar-sdk";
import { e2b } from "sandbar-sdk/e2b";

const client = await Sandbar.connect(e2b({ apiKey: process.env.E2B_API_KEY! }));

const box = await client.sandboxes.create({
  environment: Image.prepared("base"),
  networkPolicy: "blocked",
});

await box.writeFile("/home/user/data.bin", Uint8Array.from([0, 255, 129]), { overwrite: false });
const data = await box.readFile("/home/user/data.bin");
const result = await box.exec({ command: { kind: "argv", argv: ["wc", "-c", "/home/user/data.bin"] } });
await box.destroy();
await client.close();
```

To build an OCI image as a separate, recoverable operation, use the common image API and pass its scoped prepared result to create:

```ts
const built = await client.images.build({ source: Image.oci("node:24") });
const box = await client.sandboxes.create({
  environment: Image.prepared(built.prepared),
  networkPolicy: "blocked",
});
```

`built.retainedResources` identifies the E2B template and reports ownership as `unknown` with manual cleanup disposition. This metadata does not grant deletion authority. The prepared handle is bound to the verified E2B provider and connection scope. A handle from another scope is rejected before provider IO; a raw owned template ID still requires authenticated readiness/access verification. Image-build observation reads the correlated E2B build name and never retries a native allocation or trigger stage. If either native POST is interrupted before readiness can be confirmed, the outcome remains unknown and may retain a template.

The factory performs no provider IO. `Sandbar.connect` validates the API key with a bounded authenticated template-list read. With API-key-only configuration, scope is explicitly `api-key`: a domain-separated SHA-256 fingerprint identifies the successfully authenticated credential. This does not discover or claim a native team ID. Reopening with the same key preserves scope; changing or rotating the key produces a different scope and rejects old references and prepared handles. An API-key ID (`E2B_API_ID`) is not a team ID and is not required.

For scope that survives same-team key rotation, optionally pass `teamId`; Sandbar verifies it through an authenticated E2B team metrics read and uses `team` authority. Switching between these scope modes requires a separate connection. `templateId` defaults to `base`. To use an owned template, pass its canonical ID or untagged name (optionally namespaced or suffixed `:default`); connect and create verify a ready owned template and resolve it to its canonical ID. Other named tags and arbitrary public aliases are outside this slice. The partition includes the configured selector and fixed API endpoint. Alias selection does not promise an immutable build version.

The native default `base` is supported without requiring it to appear in the team's owned-template listing. Its preparation checks syntax and authenticated scope; the single native create request validates current public access/readiness after the submission marker. There is no probe sandbox or claim that read-only preparation verified public readiness. Authenticated sandbox reads bind the returned canonical template ID to the exact Sandbar scope, operation and submission metadata. Recovery observes those markers and never resolves an alias to submit another create. The adapter uses only the public `sandbar-adapter` contract.

Owned prepared images use the verified template ID; `base` retains the native selector until submission. An OCI reference runs E2B's `Template().fromImage(reference)` build inside the create submission, then creates a sandbox from the ready E2B template. OCI builds are paid effects and retain the built template after sandbox destruction; the destroy result names it as a retained resource. Public registry images are the supported input; private registry credentials have no common Sandbar input yet. Network modes are `internet` and `blocked` through E2B's `allowInternetAccess` control. Region selection is unsupported. Command forms are argv and Bash shell, with cwd and environment. E2B's command API decodes process output as text, so the adapter redirects each stream to a sandbox file and reads the bytes through E2B's streaming file API. Combined stdout and stderr are capped at 1 MiB; file reads and writes are capped at 1 MiB. A no-clobber write uploads to a temporary file in the destination directory and links it to the exact destination atomically with GNU `ln -T --`. Images without that utility fail without a fallback write; this path has not been qualified live across custom E2B images.

Ordinary `box.exec` accepts an optional finite stdin payload up to 1 MiB. Strings become UTF-8; byte arrays are preserved exactly. E2B reserves a private directory using one foreground `mkdir -m 700`, uploads and verifies the staged bytes, and redirects the command's stdin from the staged file. Omitted input redirects from `/dev/null`; explicit empty input still establishes EOF. The file is seekable in the guest, but Sandbar promises byte and EOF behavior rather than a pipe type. A staging acknowledgement/readback failure prevents command dispatch, and neither upload nor command start is replayed. If launch or local observation is interrupted, the stage can remain until the wrapper cleanup or sandbox removal. Existing execution receipts recover output/status read-only. Deterministic native fixtures and packed consumer checks cover this path; its maintained live finite-input scenario has not run.

The pinned `e2b@2.51.0` SDK retries rate limited control requests by default. This adapter passes `retries: 0` for sandbox and build mutations. Creation embeds Sandbar submission and operation IDs in E2B metadata. After a lost create response, observation searches that metadata without creating another sandbox. OCI builds use a name derived from the submission ID. If a build succeeds but sandbox creation is not confirmed, observation reports the retained template and the original create remains unknown; reconnecting with that template ID and issuing a new prepared-image create is the recovery path. Exec completion is recorded in sandbox files for observation after a lost response. Uncertain file writes retain a bounded digest token and sanitized native failure classification (connection, upload or link stage, allowlisted error class and HTTP status when available). Native exception messages, URLs, trace IDs and bodies are discarded. A failed readback includes the original classification and bounded length, truncation and digest-match facts. Matching bytes still confirm a lost-response write without resubmission. Older tokens without failure classification remain recoverable. In recovery, observation checks the final bytes, and for no-clobber it also checks that the staged file and destination have the same inode. Observation does not remove the staged file; the sandbox TTL bounds its lifetime. Destroy checkpoints retained template identity and observed volume names before termination dispatch, then checkpoints acknowledgement before readback. Custody that exceeds the 4096-byte recovery-token bound rejects with `CAPACITY` before native termination. Uncertain outcomes confirm sandbox absence without retrying termination. Applications must durably persist each checkpoint for cross-process recovery; an unavailable persistence callback blocks dispatch. Aborting local waits or closing the client does not terminate remote compute; destroy confirms absence before reporting `computeStopped`.

Deterministic fixtures and packed Node/Bun consumers cover this integration. Bounded API-key/public-base live runs confirmed sandbox lifecycle and exposed overwrite failure for a file directly in sticky `/tmp`; no-clobber remained blocked. A documentation-led unmerged retest in `/home/user` passed all 13 baseline checks, including overwrite and no-clobber, with confirmed cleanup. A September 28, 2026 rerun against merged SDK `3be54464` also passed all 13 baseline checks in `/home/user`, with cleanup confirmed. See the [tested support matrix](https://sandbarsdk.dev/docs/providers/support/). This qualifies the recorded workflow, not arbitrary-path overwrite. Blocked internet was requested, but egress was not measured. The native upload failed while opening a user-owned file in root-owned sticky `/tmp` under Linux protected-regular restrictions. Detailed debugging records stay private. E2B documents `user` and `/home/user` as its default user/workdir and uses `/home/user` in its [upload example](https://docs.e2b.dev/quickstart/upload-download-files). The qualification profile now records that file root explicitly. This does not repair or qualify overwrite of arbitrary paths, other users or custom template workdirs.

Reusable capture tokens checkpoint the raw native template ID and first acknowledged build UUID before checking the source's final state. Once generation is verified, they retain the snapshot resource reference and application-owned native history. If the source expires or is destroyed, capture completion remains unknown, but the saved reference can be reopened through `client.snapshots.get(reference)` for independent inspection and cleanup. Treat serialized references and their history as application-owned custody records, not provider authorization.

Snapshot restore submits `templateId:buildUUID` with the requested network policy in the original create request. Native retained build assignments and the captured generation must still match. Snapshot deletion targets the dedicated containing template after authenticated scope, native identity, generation, containing-template membership and compute-dependency checks. Snapshot and volume deletion persist a dispatch-uncertain checkpoint before DELETE and acknowledgement afterward. A fresh connection can reconcile authenticated exact-ID absence from the last durable uncertain checkpoint without replay; this confirms the requested absent state, not actor attribution or billing completion. Legacy tokens without dispatch evidence and failed inventory reads remain unknown. The native delete API has no generation compare-and-delete condition, so a concurrent external change between validation and deletion remains a provider boundary limitation.

Create-time mounts remain unsupported in this pinned integration. Volume mounts are submitted and observed by reusable name, so the acknowledged volume ID cannot be enforced atomically. Capability discovery and request checks reject mount submission before allocation. Private-beta volume artifact management remains independent. Successful inventory does not establish create eligibility; native create may still reject the account. Volume creation preserves HTTP 400/401/403 as durable no-effect rejection, while transport, rate-limit and server failures remain uncertain and cannot be replayed or adopted by name. Existing mounted compute can be explicitly cleaned up with `storage: "allow-unconfirmed"`; unavailable volume inventory does not prevent compute cleanup, and retained volume names remain reported as unconfirmed identity.


## Reopen Sandbar-created compute

Direct SDK sandbox handles expose `reference: SandboxReference | null`. Save that reference in an application-owned trusted store and configure a fresh connection with the same native binding:

```ts
const reference = sandbox.reference ?? (await sandbox.inspect()).reference;
if (!reference) throw new Error("Verified sandbox identity is unavailable");
const saved = JSON.parse(JSON.stringify(reference));
await client.close();
const reopened = await freshClient.sandboxes.get(saved);
const info = await reopened.inspect();
if (info.state === "running") {
  const bytes = await reopened.readFile("/tmp/work.txt");
  const output = await reopened.exec(["/bin/sh", "-c", "printf reopened"]);
}
```

References contain native identity, provider/scope and the native creation selectors required for verification; no credentials, observations or workflow journal. Successful create, snapshot restore and recovered results issue references after native verification. Legacy adapters may return null; a failed optional identity read after confirmed Daytona creation also returns a usable handle with null reference rather than hiding completed creation. A later `inspect().reference` can supply verified identity when native metadata becomes readable. Do not save null or synthesize a reference from the display ID.

`get` reads native detail and never creates, resumes or extends lifetime. Stopped/suspended resources remain inactive. `inspect` supplies current `nativeState`, local receipt `observedAt`, hard expiry, idle-stop policy and stopped-retention facts. Unknown facts remain unknown; an elapsed deadline alone does not establish deletion. Missing/expired/deleted resources fail `NOT_FOUND`, native authorization fails `FORBIDDEN`, transport/detail access fails `UNAVAILABLE`, and identity/configuration mismatch fails `CONFLICT`. A destroyed tombstone can be inspected but cannot be reopened.

Applications own persistence, fresh credentials and serialization of competing operations. There is a crash window before the reference is saved. Existing operation recovery remains separate and read-only; reopening compute does not replay a command or recover a mutation. Configured renewal and native suspend/resume are available through explicit calls. Deterministic/packed tests cover this slice; fresh-process `lifecycle-reopen` passed at `3188e33` in #68 with confirmed owned cleanup, for the recorded configuration.

E2B keeps the original team/endpoint/template partition, including restored-template provenance. Configure `teamId` for same-team credential rotation; API-key-scoped references reject a changed key. Guest exec/files use authenticated detail plus a locally constructed pinned `e2b@2.51.0` client, without `Sandbox.connect`. New create/restore explicitly requests kill-on-timeout and `autoResume: false`. Guest access requires current running state, explicit auto-resume-off, envd version/token and trusted domain (omitted/null native domain uses the fixed `e2b.app` default); unsupported/missing detail makes guest access unavailable while control-plane inspection remains usable. External actors can change policy between the check and guest IO; no transactional native guard is claimed. Paused state reports suspended, no active-session deadline, and documented indefinite paused retention; stale `endAt` is ignored. Running `endAt` remains an absolute session deadline, or unknown when absent/invalid. Tokens are never saved in references.

## Finite text streaming

`sandbox.processes.start({ command, cwd?, env?, maxOutputBytes? })` starts once with closed stdin and returns a local handle with `output()`, `wait()` and `detach()`. Separate decoded stdout/stderr text arrives before exit; ordinary zero/nonzero exits return `{ exitCode, outputComplete }`. One output consumer is allowed. Completeness requires native completion and consumer drain. Confirmed exit survives later output failure.

Cumulative UTF-8 text defaults to 1 MiB (configurable 1–1,048,576), queue 64 KiB/256 chunks, and emitted chunks 16 KiB on code-point boundaries. Overflow disconnects locally with `OUTPUT_CAPACITY`; an established consumer can drain the admitted prefix before the error. E2B accumulates decoded text internally, so the cumulative budget applies even to fast consumers. Incoming decoding/in-flight flush allocations are outside Sandbar admission bounds. Native text replacement is preserved; binary fidelity, workload backpressure and provider log-storage bounds are not promised.

Setup has a 30-second bound separate from stream lifetime. Native `timeoutMs: 0`, `requestTimeoutMs: 30_000`, `stdin: false` and retries 0 use read-only guest attachment. Requested `deadlineSeconds` is unsupported before dispatch. `processes.start` still has closed stdin and does not provide incremental input; PTY, arbitrary signals, process reopen and replay remain unsupported. Wait cancellation affects only its waiter; output cancellation/iterator return/detach/client close promptly releases local observation and never kills compute. Finite text workloads only. Deterministic pinned-native and packed Node/Bun coverage does not qualify live behavior; the maintained finite-streaming case passed at `3188e33` in #68 on borrowed base with confirmed owned cleanup; other configurations remain unqualified.

## Configured renewal

Set `lifecycle: { lifetimeSeconds: 600 }` at adapter setup, then use `await box.renew()` or `await box.renew({ forSeconds: 61 })`. The setting controls initial lifetime and the default renewal window; supplying it with the legacy `timeoutSeconds` option rejects before connection IO. Renewal requires running compute and a verified sandbox reference. E2B resolves positive seconds below 60 upward to 60 with a 3,600-second ceiling; omitted configuration retains 300 seconds. Active-session expiry kills compute; paused retention is separate and indefinite. A reset can shorten an existing longer deadline and is not a guaranteed execution period. Native limits may be tighter. ACK survives failed metadata reads (`observation: null`); lost ACK remains uncertain and recovery never resets again. See the provider setup guide for expiry/clock/recovery details. Deterministic and packed coverage; `lifecycle-renew` passed at `3188e33` in #68 with confirmed owned cleanup, for the recorded configuration. Native suspend/resume is implemented for eligible compute; its live evidence is described below.

## Native suspension

**Live confirmation passed.** The maintained Bun `lifecycle-suspend-resume` case passed at `26f516d` on October 2, 2026 with confirmed owned cleanup and client close. It verified inactive fresh-process reopening without implicit wake, the same identity/files, preserved RAM nonce and an advancing counter after explicit resume. Earlier failures at `6796b30` (guest routing) and `cb39884` (missing mount facts) remain recorded. This pass covers the private-state mapping, not external storage or remote connection continuity.

Use no-argument `box.suspend()` and `box.resume()`, or their submit forms, with setup-time `lifecycle.suspension.preserve` as a minimum. The result reports native preservation and process/socket effects. Saved sandbox references reopen inactive without waking or renewal; explicit resume keeps the same identity. Known nonempty native mounts are unsupported; absent mount metadata stays unknown and does not block private filesystem/RAM preservation. External storage flush, durability, atomic consistency and remote connection continuity are excluded. Each mutation dispatches once; lost acknowledgements remain unknown even when a later state matches, and recovery never replays. ACK and confirmed partial facts survive observation or checkpoint failure.  See the public provider guide and `apps/docs/examples/sandbox-suspend-resume.ts`.

E2B maps memory pause and one explicit v2 connect with the resolved configured initial lifetime, no reboot override or hidden renewal. Filesystem-plus-memory satisfies a filesystem minimum. Resume reports execution unknown because current native detail does not establish pause provenance. Paused retention is indefinite and requires owned explicit kill cleanup; active session expiry is separate. Filesystem-only mode is deferred.

## Preview access

`box.preview(port, { signal? })` resolves ephemeral HTTP access to existing running compute, without server start, implicit resume, readiness polling or outbound policy changes. See the [preview guide](https://sandbarsdk.dev/docs/guides/preview-access/) for setup, token authority/lifetime and unsupported modes. Daytona implements protected sandbox-wide header access; E2B implements explicitly public access and creates/restores private compute by default while protected token lookup remains unsupported. This slice has deterministic native/packed coverage. Daytona protected and E2B explicit public preview passed at `3188e33` in #68 with confirmed owned cleanup; E2B private-default ingress denial remains unqualified.

## Directory primitives

`fileExists` uses pinned native lstat-backed Stat: false only for confirmed guest absence, including true for dangling entries. Recursive mkdir/remove retain native MakeDir/Remove; default nonrecursive requests use adapter-owned Python 3 `mkdir`, `unlink` and `rmdir` with checked outcomes. Existing directories (including links to directories) succeed; nonempty-directory removal requires recursion. Final/descendant links are not walked, while intermediate parent links follow the guest namespace. Absolute directory paths are normalized and root removal is refused.

`listFiles` and `readDirectory` use bounded Python 3 `scandir` with final-link identity and visible unknown types, rather than the pinned SDK's filtered list. `statFile` uses lstat or explicit follow. The helper receives exact quoted argv, has checked output/exit bounds and installs nothing. Images need Python 3. One semantic operation dispatches once; ordinary mkdir/remove recovery retains intent and never replays uncertain acknowledgements.

Streams use pinned `e2b@2.51.0` response-body reads and octet-stream request bodies, with backpressure. Upload requires envd >=0.5.7; older guests reject before staging because the native SDK otherwise buffers a whole-file Blob. Publication checks source EOF, receipt path and staged regular-file size before changing the destination. Writes/copy reserve same-directory stages and publish through hardlink/no-clobber or overwrite rename. Only correlated artifacts are cleanup targets; uncertain results preserve paths and byte counts in typed errors. Copy opens the source without following its final link and checks the opened descriptor; operands must be regular files. Move uses same-filesystem native rename, with Linux libc renameat2 for no-clobber and no cross-filesystem copy/delete fallback.

Buffered file IO preserves its 1 MiB default; explicit maxBytes permits up to16 MiB. Larger files use streams. SDK transfer policy separates setup, active IO inactivity and optional overall deadlines; native reader inactivity is disabled so slow consumer processing does not time out. The helper/stream tests are deterministic fixtures, including32 MiB hash verification and short-upload refusal. Historical live passes do not qualify these new mappings.
