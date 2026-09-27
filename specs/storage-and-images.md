# Storage, checkpoints, and user-supplied images

Draft 0.3 · Recommendations after multiple rounds of provider research and API critique

These contracts are runtime-neutral and will be implemented on the selected [Hono/SQL architecture](design.md). All SDK snippets are proposed APIs, not implemented packages.

## Resource model

| Resource | Meaning |
|---|---|
| ImageSource | User input: OCI reference, Dockerfile/context, native artifact, or catalog selection |
| PreparedImage | Provider-specific materialization ready for allocation |
| EnvironmentRevision | Optional immutable name for prepared mappings, requirements, and sizing recommendations |
| Volume | Mutable persistent directory with declared filesystem and durability semantics |
| Mount | One sandbox attachment/session, with path, access, state, and optional pinned volume version |
| VolumeVersion | Immutable retained volume state, if that storage provider supports versioning |
| Checkpoint | Captured sandbox root, or root plus memory, with explicit mount exclusions and restore constraints |
| ArtifactRecord | Internal ownership/provenance record, possibly referenced in both image and checkpoint roles |

Volume does not imply block storage, universal POSIX behavior, distributed locking, or immediate remote durability. A root checkpoint is not a volume version. A file archive is not automatically an OCI image, and directory copying is not RAM migration.

## 1. Supplying images

### One source field

Extend create.environment with six real input forms: revision, channel, oci, dockerfile, native, and prepared. These represent distinct inputs, not multiple spellings of the same revision. SDKs accept coding-agent@3 as the immutable catalog shorthand and provide image helpers.

```ts
const box = await client.sandboxes.create({
  environment: Image.oci("python:3.12"),
});
```

Equivalent Python and Rust entry points should remain small:

```python
box = await client.sandboxes.create(environment=Image.oci("python:3.12"))
```

```rust
let box_ = client.sandboxes()
    .create(Image::oci("python:3.12"))
    .await?;
```

Project setup explicitly chooses an ordered connection placement policy and bounded remote preparation policy. The ordinary one-call OCI path may prepare remotely under that policy. It must not select arbitrary accounts, launch speculative builds on all providers, or require a permission flag on every call. Restrictive projects receive PREPARATION_REQUIRED with the plan and setup link.

The operation exposes resolving, uploading, preparing, allocating, and ready phases. Fallback is only after a definitive eligible failure; a previous preparation can still incur cost. An ambiguous import/build cannot be repeated blindly. Preparation limits cover the aggregate attempts and concurrency across the entire fallback sequence; they do not reset for each candidate. A timeout/cancellation request does not prove a native build stopped or its final charges are bounded.

Prewarm explicitly when latency matters:

```ts
const image = await client.images.prepare(
  Image.dockerfile("./Dockerfile", { context: "." }),
  {
    connection: "development",
    resources: { vcpu: 2, memoryMiB: 4096 },
  },
);
const box = await client.sandboxes.create({ environment: image });
```

Preparation resources and limits are separate from sandbox resources. Use explicit vcpu terminology in portable requests and report provider-native allocation/unit conversion. Do not promise equivalent CPU performance across providers. Requests versus burst limits also need separate fields where supported.

### Wire source shape

```ts
type EnvironmentSource =
  | { kind: "revision"; name: string; revision: number }
  | { kind: "channel"; name: string; channel: string }
  | {
      kind: "oci";
      reference: string;
      platform?: string;
      registry?: string;
    }
  | {
      kind: "dockerfile";
      contextId: string;
      dockerfile: string;
      platform?: string;
      registryBindings?: Record<string, string>; // registry host -> scoped credential ref
      buildArgs?: Record<string, string>; // nonsecret values only
      buildSecrets?: Array<{ id: string; secret: string }>; // verified secret mounts only
    }
  | { kind: "native"; connectionId: string; artifact: NativeArtifact }
  | { kind: "prepared"; imageId: string };
```

NativeArtifact is a versioned adapter-validated descriptor. Registry and prepared IDs/references are authorized project resources. SDK handles serialize to these forms; no live object is a wire type. A prepared/native source constrains its provider scope; conflicting placement is rejected.

### Preparation is a real operation

Providers do not universally accept an arbitrary registry string at sandbox creation. Tensorlake imports/registers images, E2B builds templates, and Daytona/Modal have their own preparation machinery. Sandbar should perform that work instead of requiring manual provider setup, while exposing progress and cost.

Provider Dockerfile builders are not all Docker/BuildKit-equivalent. Validate required architecture, user, working directory, entrypoint, and instruction support. Fail incompatible strict requirements rather than silently ignore them. Reject deterministic incompatibilities before a paid build when they can be determined. Record adaptation/provenance separately from the input digest; that digest identifies supplied input, not the resulting adapted runtime filesystem. Remote provider builders or a separately configured external builder perform builds; the API service never executes an untrusted Dockerfile locally.

Sources: [Daytona snapshots](https://www.daytona.io/docs/en/snapshots/), [Daytona builder](https://www.daytona.io/docs/en/declarative-builder/), [E2B Build System 2.0](https://e2b.dev/resources/introducing-build-system-2-0), [Modal existing images](https://modal.com/docs/guide/existing-images), [Tensorlake images](https://docs.tensorlake.ai/sandboxes/images).

### Registry authentication and contexts

The UI supports registry credentials scoped to exact registries, permitted repositories, and provider connections. Image.oci(ref, {registry:"github"}) sends a reference, not a secret. Explain that the importer/builder may receive these credentials. Registry auth never becomes a sandbox environment variable by default.

Dockerfile registryBindings support private and multistage inputs only where the adapter can pass each scoped credential safely; reject unsupported bindings rather than relying on ambient server authentication. Build secrets require verified secret-mount support; never place a secret into ordinary buildArgs as a convenience. Builds using workload secrets disable automatic cross-invocation reuse in v1. Explicit reuse of a prepared image still requires authorization and preserves sensitivity lineage.

SDKs package a bounded local context, honor .dockerignore, hash and stream it, and obtain contextId before effectful build submission. Server requests use context-relative Dockerfile paths only. Validate archive traversal, symlink escape, file count, expanded size, and extraction boundaries. Provide an upload manifest/preview and documented exclusions for common credential files; explicit inclusion must be intentional. A local filesystem path in an SDK never authorizes reading that path on the server.

Resolve tags to platform-specific immutable digests where supported. Record index digest, platform digest, provider output ID, builder version, and transformations independently. If native tag resolution cannot be pinned, report mutable/unverified and reject requireImmutableArtifact. Do not claim a captured name freezes bytes. Disable automatic source-equivalence cache reuse for unpinned mutable sources; a user can still explicitly reuse an authorized prepared-image ID.

### Cache, ownership, and cost

Cache within project authorization boundaries using source digest/platform, context and recipe hashes, nonsecret build options, builder/provider version, native scope, and relevant build resources. Reauthorize private source access before reuse. Credential rotation does not automatically change image bytes; access revocation still matters.

Proposed cleanup defaults: owned automatic materializations after seven idle days; upload contexts 24 hours after build termination; build logs up to seven days with an 8 MiB captured prefix; terminal preparation history 30 days. Expire abandoned/unreferenced uploads after 24 hours even if no build was submitted. Retain live artifact provenance, ownership, sensitivity, and dependency records for the resource lifetime and applicable tombstone policy; the 30-day history window does not remove them. Expose earlier log eviction under quotas. Separate quotas cover context uploads, stored artifacts, build output, and build concurrency.

Catalog/pool references, dependent resources, and accepted/unknown operations pin artifacts against idle GC, but cannot extend native expiration. A successful preparation survives a later failed sandbox launch. Borrowed native registrations are never automatic deletion candidates.

Preparation records its own usage/cost lineage: native build ID, cache outcome, native allocation, elapsed phases, transferred/stored bytes, and evidence quality. A cache hit is not necessarily free. See [accounting](observability-and-accounting.md).

## 2. Volumes and mounted sessions

```ts
const volume = await client.volumes.create({
  connection: "tensorlake-main",
  name: "agent-work",
});
const box = await client.sandboxes.create({
  environment: "coding-agent@3",
  mounts: [volume.at("/work")],
});
await box.exec(["python", "agent.py"]);
const mount = await box.mounts.get("/work");
const version = await mount.checkpoint();
const branch = await version.fork({ name: "experiment" });
```

Versioning is optional. A volume adapter need not implement it to provide persistent storage. MountBridge validates the exact storage/compute pair, client/runtime privileges, network and credential scope, attachment timing, and readiness before workload execution. Do not assume that installing FUSE through a shell makes every provider compatible.

Mount operations have distinct meanings:

- flush establishes a documented durability barrier for that session.
- refresh updates its view of changes published elsewhere.
- checkpoint flushes the supported session scope and retains an identified immutable version.

Return session identity, barrier scope, version/commit identity, and completion time. One session's barrier does not flush every writer. Reading latest after a concurrent writer advances the timeline cannot prove which state was captured.

Default unmount requests a flush. If it fails, preserve attachment/recovery evidence and report DATA_NOT_DURABLE. Discard-and-detach is explicit. Compute destruction remains possible, but reports unconfirmed flushes, retained volumes, and possible loss of unreplicated data.

Tensorlake volumes autosave asynchronously and pinned versions are read-only. Modal publication and refresh are distinct and refresh has open-file restrictions. Daytona volumes have object-storage/FUSE characteristics. These are capability facts, not generic POSIX assumptions. [Tensorlake volumes](https://docs.tensorlake.ai/filesystems/introduction), [Tensorlake mounts](https://docs.tensorlake.ai/sandboxes/mount-filesystems), [Modal volumes](https://modal.com/docs/guide/volumes), [Daytona volumes](https://www.daytona.io/docs/en/volumes/).

## 3. Checkpoints, suspension, and forks

### Capture

```ts
const checkpoint = await box.checkpoint({
  preserve: "filesystem",
  maxDisruption: "pause",
  retention: { minimumRetentionSeconds: 86400 },
});
```

Preservation is exactly filesystem or filesystem+memory. Capturing extra RAM is not an acceptable substitute for filesystem-only because it captures extra sensitive data and changes restore behavior.

Defaults: filesystem-only, at most a transient pause, verified crash-consistent capture, and a seven-day cleanup preference. There is no guaranteed minimum retention unless requested. A source already stopped does not suffer an additional stop merely because capture requires that state.

Requests can explicitly permit stop/terminate and caller-quiesced consistency. Caller quiescence is an assertion, not Sandbar certification of application consistency. Report actual source state, connection interruption, included paths, excluded mounts, requested cleanup, native/effective expiry, restore restrictions, dependencies, and sensitivity lineage.

Reject a minimum-retention requirement that native expiry cannot satisfy. Cleanup preference and minimum availability are different fields. Never schedule cleanup before the requested minimum; extend an omitted default cleanup preference to meet it. Reject explicitly conflicting cleanup/minimum values. Unknown native retention cannot satisfy a guaranteed minimum. Promotion or restoring from a snapshot must not imply an extension of inherited native expiry.

### Restore and mounts

Restore creates a new logical sandbox; resume continues the suspended one. Native suspend/resume is sufficient initially. Do not synthesize checkpoint/delete/recreate suspension while claiming stable runtime identity.

A root checkpoint excludes external mounts. With writable mounts, restore/fork requires a per-mount choice: share, omit, replace, or forkVersion where supported. Without writable-mount ambiguity, checkpoint.restore() can be sufficient, but read-only does not imply immutable. Record whether each mount follows current volume state or a pinned version. The resolved restore manifest makes reuse of current state explicit; a reproducible-external-input requirement requires pinned versions or fails.

```ts
const restored = await checkpoint.restore({
  mounts: { "/work": { action: "share" } },
});
```

Memory restore can only apply choices and security policies that the provider can enforce before captured processes resume. Unsupported rebinding/detaching fails; do not claim fresh network/credential isolation after code has already resumed. Captured mount clients can contain credentials, dirty buffers, caches, and session IDs. Reject memory capture/restore/fork with mounts until the adapter verifies session reuse/rebinding and concurrent-writer behavior; a fresh attachment is not automatically a safe replacement. There is no v1 atomic VM-plus-volumes snapshot or distributed writer freeze.

### Fork independence and dependencies

Fork promises independent private captured state, with shared external resources explicitly declared. Lifecycle independence is separately reported and optionally required via requireIndependentLifecycle. Some native forks prevent deletion of their parent while children exist; hiding that dependency makes fleet cleanup incorrect.

Deletion defaults to restrict, never implicit cascade. Image/checkpoint roles can reference one native object; the internal ownership graph prevents duplicate deletion and preserves provenance. Registered existing artifacts remain borrowed unless explicitly adopted. Unknown capture/restore pins its dependencies until reconciled.

### Provider facts that change behavior

- Daytona cold captures require a stopped source; VM hot captures include memory, and fork lineage can block parent deletion. [Persistence](https://www.daytona.io/docs/en/persistence/)
- E2B reusable snapshots include memory and interrupt connections. Filesystem-only pause/resume is a separate capability; automatic pause can fall back to filesystem-only under backlog. Do not infer unconditional memory preservation or reusable filesystem-only snapshot support. [Snapshots](https://docs.e2b.dev/sandbox/snapshots), [filesystem-only pause](https://docs.e2b.dev/sandbox/filesystem-only-snapshots), [persistence](https://docs.e2b.dev/sandbox/persistence)
- Tensorlake filesystem restoration is cold; memory restoration constrains image/resources/entrypoint. [Snapshots](https://docs.tensorlake.ai/sandboxes/snapshots)
- Modal root capture excludes mounted volumes; memory capture terminates the source and has active-process/expiry restrictions. [Snapshots](https://modal.com/docs/guide/sandbox-snapshots)

All require live adapter conformance; documentation alone is not a portability guarantee.

## 4. Transfers, deletion, and accounting

Defer universal import/export. A future Transfer declares immutable source where available, destination, bytes/checksums, preservation profile, partial-state and cancellation effects. Bytes/layout/selected permissions/symlinks are distinct from ownership, xattrs, ACLs, hardlinks, sparse files, devices, sockets, and open handles. Prefer staging a new volume; copying into an existing tree is not atomic unless verified.

Keep deletion requested, native deletion observed, and billing ended separate. Compute destruction can leave paid snapshots/volumes. Logical file size, allocated capacity, and provider-billed bytes are different quantities; unknown sizes are not zero. Shared images, pool capacity, and retained checkpoints need explicit cost attribution or an unallocated bucket. Provider billing can lag deletion; Modal documents delayed volume-storage charging. [Modal volumes](https://modal.com/docs/guide/volumes)

## Implementation and acceptance

Ship OCI supply and remote preparation, native mounts, managed/borrowed volume registration, native checkpoint/restore/suspend/fork, dependency-aware deletion, and one tested volume-version adapter. Add Dockerfile support only with an honest builder contract. Defer universal local builds, cross-provider mount installation, export/import, and atomic composite snapshots.

Test image policy before implicit preparation, context traversal/exclusion, private-cache authorization, provider Dockerfile adaptation, exact filesystem-only capture, disruption limits, simultaneous volume writers, actual retained version identity, parent/child deletion, unknown operation GC pins, expiry inheritance, and security enforcement before memory resume. The same contract fixtures apply to the SQLite and MySQL store implementations.
