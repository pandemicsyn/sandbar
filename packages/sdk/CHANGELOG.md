# sandbar-sdk

## 0.8.0

### Minor Changes

- [#152](https://github.com/pandemicsyn/sandbar/pull/152) [`f9a0bb7`](https://github.com/pandemicsyn/sandbar/commit/f9a0bb737f748b4114672fd070a4bf995e27248d) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `sandboxes.list()` items now carry `labels` (the labels set at create, without adapter markers; `null` where the provider keeps none) and `createdAt` (the provider's creation time, or `null`). Daytona, E2B, Vercel and Modal report labels; Daytona, E2B (start time), Vercel, boxd and Runloop report creation time. Adapters add them with the new `listedLabels` and `listedTime` helpers. The CLI's `ls --remote` shows both, and the new `sandbar gc --label k=v [--older-than 2h] [--dry-run]` destroys provider-listed sandboxes whose labels match, such as those a killed CI job left behind, and drops their store records. Durations also accept days, like `1d`.

- [#146](https://github.com/pandemicsyn/sandbar/pull/146) [`e513d9a`](https://github.com/pandemicsyn/sandbar/commit/e513d9a81fdd57f62d85bc027e9a9db3e91b9883) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Set the sandbox lifetime the same way everywhere. Every adapter now takes `lifecycle: { lifetimeSeconds }` in setup, defaulting to 900 seconds; E2B, Vercel and Modal `timeoutSeconds`, Daytona `ttlMinutes` and boxd's top-level `lifetimeSeconds` still work but are deprecated. `create({ lifecycle: { lifetimeSeconds } })` overrides it for one sandbox, and `capabilities().lifetime` reports the accepted range. The CLI adds `create --ttl` and `run --ttl`.

- [#150](https://github.com/pandemicsyn/sandbar/pull/150) [`e566711`](https://github.com/pandemicsyn/sandbar/commit/e56671186220a2c0345bdd8f9540af0de8b7d69e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `snapshot.restore()` takes the create options `env`, `labels` and `lifecycle: { lifetimeSeconds }`. Adapters declare which they apply in `snapshotRestore.options` (shown in `capabilities().snapshots.restore`); anything else rejects before allocation. The CLI now accepts `--env`, `--label` and `--ttl` with `--snapshot`.

- [#136](https://github.com/pandemicsyn/sandbar/pull/136) [`4a074ab`](https://github.com/pandemicsyn/sandbar/commit/4a074ab86d513b4b923a387692479f9011f0ba0e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add `Preserve` constants (`Preserve.FILESYSTEM`, `Preserve.FILESYSTEM_AND_MEMORY`) for choosing what snapshots and suspension keep. E2B accepts `snapshots: { preserve }` for filesystem-only captures, and `lifecycle.suspension.preserve` is now an exact choice: `Preserve.FILESYSTEM` pauses without memory, and resumes from disk only, so `resume()` reports fresh execution. Previously a filesystem setting on E2B still kept memory. E2B snapshots listed without Sandbar history now report unknown preservation instead of assuming memory. `snapshots.list()`, `volumes.list()` and `images.list()` now default to a page of 50 when called without a `limit`.

### Patch Changes

- Updated dependencies [[`29f6896`](https://github.com/pandemicsyn/sandbar/commit/29f689625b95d054f6c291cf60f34f8c97a53484), [`f9a0bb7`](https://github.com/pandemicsyn/sandbar/commit/f9a0bb737f748b4114672fd070a4bf995e27248d), [`e513d9a`](https://github.com/pandemicsyn/sandbar/commit/e513d9a81fdd57f62d85bc027e9a9db3e91b9883), [`e566711`](https://github.com/pandemicsyn/sandbar/commit/e56671186220a2c0345bdd8f9540af0de8b7d69e), [`4a074ab`](https://github.com/pandemicsyn/sandbar/commit/4a074ab86d513b4b923a387692479f9011f0ba0e)]:
  - @sandbar-sdk/adapter@0.8.0

## 0.7.0

### Minor Changes

- [#122](https://github.com/pandemicsyn/sandbar/pull/122) [`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the portable `resources: { vcpus, memoryMiB }` adapter setting, given as minimums, and `inspect().resources`, which reports the size a sandbox actually has or `unknown`. Adapter authors get `ResourceMinimums`, `SandboxResources` and `smallestSize()`, which picks the smallest native size that meets the minimums and otherwise throws `UNSUPPORTED` naming the largest size. `SandboxInfo.resources` is optional for adapters; the SDK always fills it in.

### Patch Changes

- Updated dependencies [[`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf)]:
  - @sandbar-sdk/adapter@0.7.0

## 0.6.0

### Minor Changes

- [#118](https://github.com/pandemicsyn/sandbar/pull/118) [`22e06ed`](https://github.com/pandemicsyn/sandbar/commit/22e06ed1fc0275fd68fd959ea4ece091f4bed180) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `sandboxes.create({ env })` sets environment variables for every command, process and terminal in the sandbox, including after reopening; a per-call `env` overrides a name. Daytona, E2B and Vercel map it to their native create-time environment. Adapters opt in with `supports.createEnv`, reported as `capabilities().createEnv`; elsewhere (boxd) `create({ env })` rejects with `UnsupportedFeatureError` before allocating anything. Values are never saved in recovery references or tokens, and never appear in telemetry or error messages.

- [#118](https://github.com/pandemicsyn/sandbar/pull/118) [`7fc61f8`](https://github.com/pandemicsyn/sandbar/commit/7fc61f8a36bd7ec7973546d630d4b567bb0cfdbc) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add `client.images.get()`, `client.images.list()` and image handles with `inspect()`, `delete()` and `submitDelete()`. `images.build()` results now include `reference`, an image resource reference whose ownership is `verified-created` only when the adapter proved the build created it. Adapters opt in with the `imageInspect`, `imageList`/`imageListCoverage` and `imageDelete` hooks, and `capabilities().imageManagement` reports what a connection supports; a missing hook rejects with `UNSUPPORTED`. Image deletion follows the snapshot deletion rules: scope checks, no deletion of borrowed images as a side effect, `OUTCOME_UNKNOWN` on an unconfirmed result and no replay.

- [#118](https://github.com/pandemicsyn/sandbar/pull/118) [`3a8c047`](https://github.com/pandemicsyn/sandbar/commit/3a8c04763ad7804f689c00f355683e235bc00206) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add `sandboxes.list({ cursor?, limit? })`: a bounded page of sandboxes with `id`, `state` and a `reference` that `sandboxes.get()` reopens, plus `coverage` (`provider-scope` or `sandbar-managed`), matching `snapshots.list()` and `volumes.list()`. Adapters implement the optional `sandboxList` hook and return `reference: null` when native evidence cannot verify identity; listed references never claim ownership, generation or creation receipts the provider does not show. Daytona and E2B list Sandbar-created sandboxes with `verified-created` references; boxd and Vercel list with `unknown` ownership. `operations.inventory()` is unchanged and is derived from `sandboxList` when an adapter only implements the new hook.

### Patch Changes

- Updated dependencies [[`22e06ed`](https://github.com/pandemicsyn/sandbar/commit/22e06ed1fc0275fd68fd959ea4ece091f4bed180), [`7fc61f8`](https://github.com/pandemicsyn/sandbar/commit/7fc61f8a36bd7ec7973546d630d4b567bb0cfdbc), [`3a8c047`](https://github.com/pandemicsyn/sandbar/commit/3a8c04763ad7804f689c00f355683e235bc00206)]:
  - @sandbar-sdk/adapter@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies []:
  - @sandbar-sdk/adapter@0.5.0

## 0.4.0

### Minor Changes

- [#114](https://github.com/pandemicsyn/sandbar/pull/114) [`3a0e3df`](https://github.com/pandemicsyn/sandbar/commit/3a0e3dff3b5c5ec55955efe0da4497cf7b7efcbb) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `capabilities()` reports `imageBuild`: whether `images.build()` can turn an OCI image into a prepared image on this connection.

### Patch Changes

- Updated dependencies [[`3a0e3df`](https://github.com/pandemicsyn/sandbar/commit/3a0e3dff3b5c5ec55955efe0da4497cf7b7efcbb)]:
  - @sandbar-sdk/adapter@0.4.0

## 0.3.0

### Minor Changes

- [#109](https://github.com/pandemicsyn/sandbar/pull/109) [`321ae0c`](https://github.com/pandemicsyn/sandbar/commit/321ae0c97a0d35568d3e109f32d9bc60e01fed3f) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Use the same network names on every adapter. Configure `network: "blocked" | "internet"` in adapter setup and, where needed, `create({ network })` or `restore({ network })`. Vercel accepts `blocked` and `internet` in place of `vercel-deny-all` and `vercel-allow-all`. Daytona adds `internet`, which requires an organization without limited sandbox egress and never falls back to the tier-dependent `daytona-default`. The `networkPolicy` option and Vercel's native names keep working and are deprecated. Adapters can declare `networkPolicyAliases` so the SDK resolves deprecated names before support checks.

### Patch Changes

- [#109](https://github.com/pandemicsyn/sandbar/pull/109) [`d384d6f`](https://github.com/pandemicsyn/sandbar/commit/d384d6f670bd4eec9bfc5d7cde6a9ea36221decc) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Streamed process text counts UTF-8 bytes without allocating per character, so large outputs no longer stall on CPU and garbage collection.
- Updated dependencies [[`321ae0c`](https://github.com/pandemicsyn/sandbar/commit/321ae0c97a0d35568d3e109f32d9bc60e01fed3f), [`ce1084f`](https://github.com/pandemicsyn/sandbar/commit/ce1084fed499651b9763af4ba9152e11bac10e5c)]:
  - @sandbar-sdk/adapter@0.3.0

## 0.2.0

### Patch Changes

- [#102](https://github.com/pandemicsyn/sandbar/pull/102) [`fb9cdd0`](https://github.com/pandemicsyn/sandbar/commit/fb9cdd04da58ce036812aa00239e9964a4161e9d) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add byte-exact finite stdin, Python-backed filesystem metadata and safe mutations, no-clobber writes and bounded-memory file streams. Add explicit public previews over pinned routes and native size selection. Preserve the existing live baseline separately from new offline coverage.

  Preserve staging paths and confirmed byte counts when file stream producers fail, without changing SDK error codes.

- Updated dependencies []:
  - @sandbar-sdk/adapter@0.2.0

## 0.1.0

### Minor Changes

- [#89](https://github.com/pandemicsyn/sandbar/pull/89) [`3906f76`](https://github.com/pandemicsyn/sandbar/commit/3906f76c6bb7457de304e98080671b45d806f9ca) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add canonical ConnectOptions and CloseOptions with setup cancellation and bounded local waits. Compatibility change: connect defaults to 30 seconds and each close wait defaults to 5 seconds. An abandoned setup releases local resources, including late registrations, without deleting remote resources. Close starts cleanup once; later calls can wait on the same attempt after a timeout or abort. Adapter host cleanup diagnostics cannot replace initiating failures.

- [#82](https://github.com/pandemicsyn/sandbar/pull/82) [`65634f9`](https://github.com/pandemicsyn/sandbar/commit/65634f9c53f37bc2b323fce407e82f19b4b94515) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Allow explicitly configured adapter default network policies, truthful block-backed volume metadata and preserved-connection suspend/resume results. Preserve acknowledged create identities as normal sandbox references with separate expiry/readiness facts through partial setup and reference-save failures. Add the experimental external boxd implementation and offline/packed qualification without changing built-in defaults or claiming live support.

- [#58](https://github.com/pandemicsyn/sandbar/pull/58) [`790c4c2`](https://github.com/pandemicsyn/sandbar/commit/790c4c27fc17f7c2b61c74d573f53978a3b0a033) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Allow omitted and labels-only creation inputs using adapter defaults. E2B reuses its configured template (including base); Daytona accepts an explicit setup environment. Per-call environments retain precedence, validation and scope checks before required native create dispatch.

- [#91](https://github.com/pandemicsyn/sandbar/pull/91) [`4b16710`](https://github.com/pandemicsyn/sandbar/commit/4b167102b9f83381685608574bd9f371fe381f5c) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Present canonical consumer names in connection and resource return declarations, add SnapshotHandle and VolumeHandle, and preserve existing structural annotations, runtime classes and advanced recovery APIs through staged type aliases.

- [#86](https://github.com/pandemicsyn/sandbar/pull/86) [`0ef5e0f`](https://github.com/pandemicsyn/sandbar/commit/0ef5e0ff3e7be5baac5932e87258157a19f6d3c7) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Decode all captured bytes by default in `stdoutText()` and `stderrText()`, and all supplied bytes in `outputText(bytes)`. Previously these no-argument helpers silently shortened at 16 KiB. Explicit numeric limits and `{ full: true }` remain supported; structured previews retain their 16 KiB default. Capture limits and `truncated` evidence are unchanged, so full decoding cannot recover missing output.

  This deliberately changes an unpublished default: read-only npm registry verification on October 11, 2026 returned HTTP 404 for `sandbar-sdk` (local version `0.0.0`). Code relying on implicit display shortening should use `stdoutPreview()` / `stderrPreview()` or an explicit numeric limit.

- [#55](https://github.com/pandemicsyn/sandbar/pull/55) [`16fc203`](https://github.com/pandemicsyn/sandbar/commit/16fc203ae5257a863b05047aa3ec9f2e592a06ed) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add configured lifetime renewal with `renew()` and `submitRenew()`. Daytona and E2B share seconds-based setup and call shapes, resolve native units upward, preserve acknowledgements when metadata reads fail, and never replay uncertain resets during recovery.

- [#90](https://github.com/pandemicsyn/sandbar/pull/90) [`5445543`](https://github.com/pandemicsyn/sandbar/commit/544554308f470b182fae3251598efd68ea0cd167) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Resolve omitted create and restore network policies from adapter setup, with blocked as the fallback for existing adapters. Daytona uses its configured policy; E2B accepts a blocked/internet setup default. SDK snapshot restore now accepts omitted input while native requests remain fully resolved. New recovery references retain the effective policy.

- [#34](https://github.com/pandemicsyn/sandbar/pull/34) [`6d9bee4`](https://github.com/pandemicsyn/sandbar/commit/6d9bee4884d06dad65fdcc3b7ed61eb2c365aefb) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Configure writable-volume cleanup once with `Sandbar.connect(adapter, { cleanup: { storage: "allow-unconfirmed" } })`. Explicit destroy/submitDestroy options override the connection policy; unconfigured connections retain the require-durable default. Compute cleanup retains volumes and reports actual durability without claiming flushed writes.

- [#59](https://github.com/pandemicsyn/sandbar/pull/59) [`b15d608`](https://github.com/pandemicsyn/sandbar/commit/b15d608453f778931c71392eeddc2157ca047899) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add optional immediate listing, directory creation, entry existence and removal APIs. Listings are bounded and sorted; mkdir/remove use ordinary no-replay mutation recovery. Enable E2B native entry existence and explicitly recursive mkdir/remove; document unsupported built-in mappings without shell emulation. Live acceptance remains unrun.

- [#66](https://github.com/pandemicsyn/sandbar/pull/66) [`4a12126`](https://github.com/pandemicsyn/sandbar/commit/4a121264418ad392cce92aae23fc6ebec62fa50b) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add E2B process-handle termination with one bounded native SIGKILL request, independently cancellable shared waits and cached outcomes without redispatch. Document PID reuse and descendant limits, preserve native terminal integers, and keep output/wait/detach behavior separate from remote termination. Unsupported or inactive handles reject before a new request.

- [#52](https://github.com/pandemicsyn/sandbar/pull/52) [`2f9c95d`](https://github.com/pandemicsyn/sandbar/commit/2f9c95de558d420e82d42206907e6e4a32c588c3) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add finite E2B text streaming through sandbox.processes.start with bounded separate stdout/stderr, ordinary confirmed exit results and prompt local wait/output cancellation and detach. Other adapters and requested runtime deadlines reject before dispatch. Preserve bounded exec binary capture; no process reopening, stdin or remote kill is added.

- [#74](https://github.com/pandemicsyn/sandbar/pull/74) [`cd89f31`](https://github.com/pandemicsyn/sandbar/commit/cd89f3192a4abe3f67614f362117050603ecac91) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add portable directory browsing and metadata, incremental byte transfers, regular-file copy and same-filesystem move. Daytona and E2B implement the artifact workflow with bounded transfers and race-safe publication on compatible private Linux filesystems. Buffered file IO keeps its 1 MiB default and accepts explicit bounds up to 16 MiB. Transfer cancellation and failures retain known effects and staging paths. Add bounded directory traversal with explicit exclusions and incremental UTF-8 text lines with a maximum line length.

- [#71](https://github.com/pandemicsyn/sandbar/pull/71) [`cbace3f`](https://github.com/pandemicsyn/sandbar/commit/cbace3f34e46fe4d84a3379e463f7ab4812212e3) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add bounded UTF-8 and byte stdin to ordinary `box.exec`, with explicit adapter opt-in for finite input followed by guest EOF.

- [#53](https://github.com/pandemicsyn/sandbar/pull/53) [`8d1da6a`](https://github.com/pandemicsyn/sandbar/commit/8d1da6a316d0d01e63dffd8526d3ac30426eae0d) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add full captured-output decoding and structured stdout/stderr previews while preserving existing text helper defaults and numeric limits.

- [#16](https://github.com/pandemicsyn/sandbar/pull/16) [`52e279e`](https://github.com/pandemicsyn/sandbar/commit/52e279ee4b5a88d7284ffa6e6b3eececf8d062ca) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Prepare the first public SDK and adapter authoring API packages.

- [#76](https://github.com/pandemicsyn/sandbar/pull/76) [`13a76ba`](https://github.com/pandemicsyn/sandbar/commit/13a76ba98c6f6cb8b5dec9f077df4642859a5b2c) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add explicit sustained text process output, bounded incremental byte stdin and EOF, status, independent exit observation and process termination for E2B and Daytona. Add awaited live exec callbacks with bounded original-byte capture from a single dispatch. Preserve finite streaming and older adapter behavior, and provide portable build, worker and owned-server examples.

- [#60](https://github.com/pandemicsyn/sandbar/pull/60) [`c953d6c`](https://github.com/pandemicsyn/sandbar/commit/c953d6c43c331a4fb12901a7735159c3c425b750) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add `box.preview(port, { signal? })` with ephemeral public or protected HTTP access information. Daytona supports private header authentication; E2B supports explicit public setup and now disables inbound public traffic by default during creation/restore. Unsupported protected E2B token lookup and sandbox-wide Daytona public publication remain explicit, without hidden resume, server start or outbound policy changes.

- [#85](https://github.com/pandemicsyn/sandbar/pull/85) [`18d7c85`](https://github.com/pandemicsyn/sandbar/commit/18d7c85ef91ad1bf4de730f86bcac1d08ccdb211) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Distribute the official Daytona and E2B integrations as separately installed @sandbar-sdk/daytona and @sandbar-sdk/e2b packages. Move the shared binding helper and portable image input types into @sandbar-sdk/adapter. Remove unpublished SDK provider subpaths and native E2B dependencies from core; update imports and install the selected adapter. Preserve provider IDs, defaults, lifecycle and recovery behavior, and coordinate all four packages in the initial lockstep release group.

- [#79](https://github.com/pandemicsyn/sandbar/pull/79) [`e0582ad`](https://github.com/pandemicsyn/sandbar/commit/e0582ad885a379961b7029c62d1054f8ddfd5e04) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add an explicit sustained byte-output profile with typed, bounded original-byte chunks on E2B and Daytona. Preserve text defaults and reject unsupported byte profiles before starting a process.

- [#79](https://github.com/pandemicsyn/sandbar/pull/79) [`995a9c1`](https://github.com/pandemicsyn/sandbar/commit/995a9c16e5419527b9d88f55bc4ab4240034c7d7) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add scoped process references and live-only reopening, stdin-preserving disconnection, explicit byte-stream terminals with resize, and named SIGTERM/SIGKILL requests on E2B and Daytona. Add bounded diagnostic line and tail helpers while preserving pipe defaults and independent confirmed exit evidence.

- [#39](https://github.com/pandemicsyn/sandbar/pull/39) [`7d7e381`](https://github.com/pandemicsyn/sandbar/commit/7d7e381f2f4203e7a3846cf560987275b0158d78) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Remove the optional management service and HTTP client. Remove the SDK service-support export, remote recovery envelope and service bindings on resource references. SandbarClient and SandboxHandle now expose the complete SDK connection and sandbox surfaces.

- [#88](https://github.com/pandemicsyn/sandbar/pull/88) [`83108f8`](https://github.com/pandemicsyn/sandbar/commit/83108f8e0c20bc54c2194b350bbe2793ee11da6d) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add opt-in `client.sandboxes.with(input, callback, options)` for one owned sandbox with bounded cleanup independent of work cancellation. Export `SandboxCleanupError` with callback outcome, cleanup failure and owned-resource/operation recovery evidence. Manual lifecycle APIs and retained storage remain unchanged.

- [#38](https://github.com/pandemicsyn/sandbar/pull/38) [`e3ea55e`](https://github.com/pandemicsyn/sandbar/commit/e3ea55e6a2696bca8a6baaf24cc5247849e5bdec) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add scoped sandbox references, fresh-connection reopening and current lifecycle inspection for Daytona and E2B. E2B guest operations attach read-only through the pinned client without implicit resume or timeout extension. References carry no credentials or workflow history; lifecycle mutations remain deferred.

- [#24](https://github.com/pandemicsyn/sandbar/pull/24) [`6d7c1b1`](https://github.com/pandemicsyn/sandbar/commit/6d7c1b1b02127c8095066c1940c493e7a596ce2c) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add application-owned OpenTelemetry tracing for SDK calls and phases, explicit disablement/provider injection, and bounded safe diagnosticContext. Preserve uncertain effects, cancellation, cleanup and observation-only recovery. Report recovery availability for immutable SDK-validated references without traversing application objects. Include complete, compiled Node/Bun OpenTelemetry and Sentry quickstarts, a Node Datadog tracer bridge, and Node/Bun Datadog OTLP recipes. Preserve existing application error reporting with event-scoped SDK sanitization. Metrics, structured logs and vendor UI qualification remain deferred.

- [#35](https://github.com/pandemicsyn/sandbar/pull/35) [`d38da52`](https://github.com/pandemicsyn/sandbar/commit/d38da5237d1d1f2460ca3a41528ca96e9a2c613f) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add explicit direct client and sandbox handle types with snapshot and volume APIs, retaining the compatible common types. Normalize resource caller input errors and report each unmet restore requirement before mutation. Document currently unsupported restore mount choices without removing compatibility fields.

- [#33](https://github.com/pandemicsyn/sandbar/pull/33) [`d186cea`](https://github.com/pandemicsyn/sandbar/commit/d186ceac2ae70665b62de73c2582c3ac05b8f3cb) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Expose provider and native ID on snapshot/volume handles, preserve immutable saved resource identities, and expose confirmed partial captures and retained volume references directly on existing errors. Narrow recovered native operation result types without changing saved operation formats. Applications persist ordinary returned resource references themselves; no expanded journal, persistence hook or continuation-advice framework is required.

- [#23](https://github.com/pandemicsyn/sandbar/pull/23) [`09c4916`](https://github.com/pandemicsyn/sandbar/commit/09c491600294ccfde4a48fc8211221d9c591cf34) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add scoped, versioned resource reference descriptors and read-only state capability/profile checks on SDK clients. Create requests can require exact future snapshot guarantees and reject unsupported or unknown evidence before native effects. Recovery remains observation-only. Public snapshot, volume, mount, and lifecycle mutations are deferred.

  The direct capability getter is now asynchronous; await `client.capabilities()` and `box.capabilities()`.

- [#25](https://github.com/pandemicsyn/sandbar/pull/25) [`a9d59b0`](https://github.com/pandemicsyn/sandbar/commit/a9d59b0a4e3d14fa5fbbb6bd5d78dfc7322187b9) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add scoped direct SDK snapshot capture, inspect, restore, inventory and explicit deletion, plus retained volumes and verified create-time mounts. Use no-argument provider-native defaults: Daytona stop/capture/restart with fresh execution and E2B filesystem/RAM capture with native resumed-process semantics. E2B restore uses the immutable captured template/build UUID selector and verifies its containing template for snapshot deletion; create-time mounts remain unsupported. Explicit snapshot and volume deletion accept caller-selected artifacts after native identity, scope and dependency checks, while automatic cleanup requires correlated creation evidence. E2B snapshot deletion refuses multi-build containing templates regardless of retained history. Containing-template deletion has no native transactional generation precondition, so concurrent external mutation remains a native limitation. Optional requirements validate the configured default; results and inspected artifacts report preservation and restored execution. Map distinct native profiles with no-replay recovery and explicit unconfirmed writable-mount durability.

- [#69](https://github.com/pandemicsyn/sandbar/pull/69) [`efb6ed7`](https://github.com/pandemicsyn/sandbar/commit/efb6ed7c479bc0a5f60150188064f1eda6f338fd) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Use MountSpec arrays on restore, matching create and volume.at descriptors. Support explicit Daytona daytona-default cold filesystem restore with exact selected volume IDs. Preserve selected mounts and acknowledged compute in uncertain restore outcomes. Older hooks reject nonempty arrays unless they declare mountInput: specs. SDK runtime keeps the deprecated empty-object alias in this coordinated release R and R+1; record R when versioning runs and remove the alias at the subsequent API release. Nonempty legacy maps reject with migration guidance.

- [#61](https://github.com/pandemicsyn/sandbar/pull/61) [`8f7512d`](https://github.com/pandemicsyn/sandbar/commit/8f7512db89f2ace144c6f58f442bee5ef1173190) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add UTF-8 readTextFile and writeTextFile helpers using the existing byte file limits, cancellation, overwrite defaults and recovery.

### Patch Changes

- [#65](https://github.com/pandemicsyn/sandbar/pull/65) [`9a74e70`](https://github.com/pandemicsyn/sandbar/commit/9a74e70f94b11471bc995bfc66747d60cb5f61a1) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Honor E2B's fixed trusted guest-routing default when native sandbox details omit the domain or return null. Preserve running-state, token, version and auto-resume checks; reject foreign routing without calling mutating connect.

- [#32](https://github.com/pandemicsyn/sandbar/pull/32) [`c8894ca`](https://github.com/pandemicsyn/sandbar/commit/c8894cac9c27e35c6cb85ce75b51b64f88ef922e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Report E2B volume create eligibility as unknown after successful inventory, and unavailable after native account authorization denial. Implemented volume CRUD remains distinct from account eligibility and unsupported immutable-ID mounts.

- [#87](https://github.com/pandemicsyn/sandbar/pull/87) [`016cec5`](https://github.com/pandemicsyn/sandbar/commit/016cec5384c9793eaa8d621ebebc689f229abb70) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Validate callback exec deadlines and advertised capture limits before dispatch, preserve original observation failures as causes, and clarify the explicit sustained-output profile. E2B bounded execution now retains validated exit status and available bytes when output retrieval fails, reporting incomplete capture rather than an unknown execution outcome. Callback deadlines remain unsupported on the current native process paths; local cancellation does not guarantee remote termination.

- [#75](https://github.com/pandemicsyn/sandbar/pull/75) [`5756306`](https://github.com/pandemicsyn/sandbar/commit/57563060068f1b24e7b33ed3808cd0182ff02a15) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Preserve possible effects and staging custody after interrupted Daytona filesystem helpers. Retain confirmed stream publication before cleanup so timeout or cancellation cannot erase an applied write; report unfinished cleanup through correlated temporary paths.

- [#80](https://github.com/pandemicsyn/sandbar/pull/80) [`0e3e250`](https://github.com/pandemicsyn/sandbar/commit/0e3e2501be6c811f01c0166ca698ca888ab9ab1e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Stop buffered process lines and final partial lines promptly when their observation signal is aborted. Report pre-aborted process signals with no possible remote effect, without dispatching or consuming the shared signal request.

- [#77](https://github.com/pandemicsyn/sandbar/pull/77) [`7be1177`](https://github.com/pandemicsyn/sandbar/commit/7be117754c84d32fa7015ad1aa285e62821aaf93) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Reject process input after E2B observation is lost and promptly report exec output callback failures while input is still being delivered.

- [#51](https://github.com/pandemicsyn/sandbar/pull/51) [`79dd215`](https://github.com/pandemicsyn/sandbar/commit/79dd215fde00a079cb1c76c2147126f6c4f89ce1) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add caller signals to file reads, align sandbox read/inspection options, and enforce the fixed local read deadline with prompt reader cleanup.
- Updated dependencies [[`3906f76`](https://github.com/pandemicsyn/sandbar/commit/3906f76c6bb7457de304e98080671b45d806f9ca), [`65634f9`](https://github.com/pandemicsyn/sandbar/commit/65634f9c53f37bc2b323fce407e82f19b4b94515), [`790c4c2`](https://github.com/pandemicsyn/sandbar/commit/790c4c27fc17f7c2b61c74d573f53978a3b0a033), [`16fc203`](https://github.com/pandemicsyn/sandbar/commit/16fc203ae5257a863b05047aa3ec9f2e592a06ed), [`5445543`](https://github.com/pandemicsyn/sandbar/commit/544554308f470b182fae3251598efd68ea0cd167), [`b15d608`](https://github.com/pandemicsyn/sandbar/commit/b15d608453f778931c71392eeddc2157ca047899), [`4a12126`](https://github.com/pandemicsyn/sandbar/commit/4a121264418ad392cce92aae23fc6ebec62fa50b), [`2f9c95d`](https://github.com/pandemicsyn/sandbar/commit/2f9c95de558d420e82d42206907e6e4a32c588c3), [`cd89f31`](https://github.com/pandemicsyn/sandbar/commit/cd89f3192a4abe3f67614f362117050603ecac91), [`5756306`](https://github.com/pandemicsyn/sandbar/commit/57563060068f1b24e7b33ed3808cd0182ff02a15), [`cbace3f`](https://github.com/pandemicsyn/sandbar/commit/cbace3f34e46fe4d84a3379e463f7ab4812212e3), [`13a76ba`](https://github.com/pandemicsyn/sandbar/commit/13a76ba98c6f6cb8b5dec9f077df4642859a5b2c), [`c953d6c`](https://github.com/pandemicsyn/sandbar/commit/c953d6c43c331a4fb12901a7735159c3c425b750), [`18d7c85`](https://github.com/pandemicsyn/sandbar/commit/18d7c85ef91ad1bf4de730f86bcac1d08ccdb211), [`e0582ad`](https://github.com/pandemicsyn/sandbar/commit/e0582ad885a379961b7029c62d1054f8ddfd5e04), [`995a9c1`](https://github.com/pandemicsyn/sandbar/commit/995a9c16e5419527b9d88f55bc4ab4240034c7d7), [`7d7e381`](https://github.com/pandemicsyn/sandbar/commit/7d7e381f2f4203e7a3846cf560987275b0158d78), [`e3ea55e`](https://github.com/pandemicsyn/sandbar/commit/e3ea55e6a2696bca8a6baaf24cc5247849e5bdec), [`d186cea`](https://github.com/pandemicsyn/sandbar/commit/d186ceac2ae70665b62de73c2582c3ac05b8f3cb), [`09c4916`](https://github.com/pandemicsyn/sandbar/commit/09c491600294ccfde4a48fc8211221d9c591cf34), [`a9d59b0`](https://github.com/pandemicsyn/sandbar/commit/a9d59b0a4e3d14fa5fbbb6bd5d78dfc7322187b9), [`efb6ed7`](https://github.com/pandemicsyn/sandbar/commit/efb6ed7c479bc0a5f60150188064f1eda6f338fd)]:
  - @sandbar-sdk/adapter@0.1.0
