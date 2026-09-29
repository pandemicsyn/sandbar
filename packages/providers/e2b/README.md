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

`built.retainedResources` identifies the E2B template and reports ownership as `unknown` with manual cleanup disposition. This metadata does not grant deletion authority. The prepared handle is bound to the verified E2B provider and connection scope. A handle from another scope is rejected before provider IO; a raw owned template ID still requires authenticated readiness/access verification. The service persists image builds as operations without creating a sandbox record and uses the same invocation, submission marker and encrypted recovery-token machinery. Image-build observation reads the correlated E2B build name and never retries a native allocation or trigger stage. If either native POST is interrupted before readiness can be confirmed, the outcome remains unknown and may retain a template.

The factory performs no provider IO. `Sandbar.connect` validates the API key with a bounded authenticated template-list read. With API-key-only configuration, scope is explicitly `api-key`: a domain-separated SHA-256 fingerprint identifies the successfully authenticated credential. This does not discover or claim a native team ID. Reopening with the same key preserves scope; changing or rotating the key produces a different scope and rejects old references and prepared handles. An API-key ID (`E2B_API_ID`) is not a team ID and is not required.

For scope that survives same-team key rotation, optionally pass `teamId`; Sandbar verifies it through an authenticated E2B team metrics read and uses `team` authority. Switching between these scope modes requires a separate connection. `templateId` defaults to `base`. To use an owned template, pass its canonical ID or untagged name (optionally namespaced or suffixed `:default`); connect and create verify a ready owned template and resolve it to its canonical ID. Other named tags and arbitrary public aliases are outside this slice. The partition includes the configured selector and fixed API endpoint. Alias selection does not promise an immutable build version.

The native default `base` is supported without requiring it to appear in the team's owned-template listing. Its preparation checks syntax and authenticated scope; the single native create request validates current public access/readiness after the submission marker. There is no probe sandbox or claim that read-only preparation verified public readiness. Authenticated sandbox reads bind the returned canonical template ID to the exact Sandbar scope, operation and submission metadata. Recovery observes those markers and never resolves an alias to submit another create. The adapter uses only the public `sandbar-adapter` contract; the optional service registers the same definition explicitly, accepts empty configuration for the defaults, and keeps the API key in its normal encrypted credential store.

Owned prepared images use the verified template ID; `base` retains the native selector until submission. An OCI reference runs E2B's `Template().fromImage(reference)` build inside the create submission, then creates a sandbox from the ready E2B template. OCI builds are paid effects and retain the built template after sandbox destruction; the destroy result names it as a retained resource. Public registry images are the supported input; private registry credentials have no common Sandbar input yet. Network modes are `internet` and `blocked` through E2B's `allowInternetAccess` control. Region selection is unsupported. Command forms are argv and Bash shell, with cwd and environment. E2B's command API decodes process output as text, so the adapter redirects each stream to a sandbox file and reads the bytes through E2B's streaming file API. Combined stdout and stderr are capped at 1 MiB; file reads and writes are capped at 1 MiB. A no-clobber write uploads to a temporary file in the destination directory and links it to the exact destination atomically with GNU `ln -T --`. Images without that utility fail without a fallback write; this path has not been qualified live across custom E2B images.

The pinned `e2b@2.51.0` SDK retries rate limited control requests by default. This adapter passes `retries: 0` for sandbox and build mutations. Creation embeds Sandbar submission and operation IDs in E2B metadata. After a lost create response, observation searches that metadata without creating another sandbox. OCI builds use a name derived from the submission ID. If a build succeeds but sandbox creation is not confirmed, observation reports the retained template and the original create remains unknown; reconnecting with that template ID and issuing a new prepared-image create is the recovery path. Exec completion is recorded in sandbox files for observation after a lost response. Uncertain file writes retain a bounded digest token and sanitized native failure classification (connection, upload or link stage, allowlisted error class and HTTP status when available). Native exception messages, URLs, trace IDs and bodies are discarded. A failed readback includes the original classification and bounded length, truncation and digest-match facts. Matching bytes still confirm a lost-response write without resubmission. Older tokens without failure classification remain recoverable. In recovery, observation checks the final bytes, and for no-clobber it also checks that the staged file and destination have the same inode. Observation does not remove the staged file; the sandbox TTL bounds its lifetime. Uncertain destroy outcomes retain the template identity and confirm sandbox absence without retrying termination. A crash before a recovery token is saved can still leave an unknown outcome. Aborting local waits or closing the client does not terminate remote compute; destroy confirms absence before reporting `computeStopped`.

Deterministic fixtures and packed Node/Bun consumers cover this integration. Bounded API-key/public-base live runs confirmed sandbox lifecycle and exposed overwrite failure for a file directly in sticky `/tmp`; no-clobber remained blocked. A documentation-led unmerged retest in `/home/user` passed all 13 baseline checks, including overwrite and no-clobber, with confirmed cleanup. A September 28, 2026 rerun against merged SDK `3be54464` also passed all 13 baseline checks in `/home/user`, with cleanup confirmed. See the [tested support matrix](https://sandbarsdk.dev/docs/providers/support/). This qualifies the recorded workflow, not arbitrary-path overwrite. Blocked internet was requested, but egress was not measured. The native upload failed while opening a user-owned file in root-owned sticky `/tmp` under Linux protected-regular restrictions. Detailed debugging records stay private. E2B documents `user` and `/home/user` as its default user/workdir and uses `/home/user` in its [upload example](https://docs.e2b.dev/quickstart/upload-download-files). The qualification profile now records that file root explicitly. This does not repair or qualify overwrite of arbitrary paths, other users or custom template workdirs.

Reusable capture tokens save a signed `snapshot` resource reference once the allocated native ID and build generation are confirmed, before checking the source's final state. If the source expires or is destroyed, capture recovery remains unknown, but the saved reference can be reopened through `client.snapshots.get(reference)` for independent inspection. Snapshot deletion is unsupported because the native API targets a mutable alias without a build-generation precondition; clean up retained snapshots through E2B directly after checking their current identity. Older unsigned capture tokens remain unknown rather than acquiring new deletion authority.


Snapshot restore and create-time mounts are unsupported in this pinned integration. E2B sandbox creation resolves a mutable template tag, and its sandbox observations expose no build generation; therefore a saved captured build cannot be positively bound to restored compute. Volume mounts are submitted and observed by reusable name, even when the native SDK accepts a `Volume` object, so the acknowledged volume ID cannot be enforced atomically. Capability discovery and request checks report these operations as unsupported, and submission rejects before allocation. Older pending restore/mount attempts remain unknown without replay. Capture, snapshot inspection, and private-beta volume artifact CRUD remain independent operations. Existing mounted compute can still be explicitly cleaned up with unconfirmed storage durability.
