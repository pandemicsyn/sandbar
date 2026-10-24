# @sandbar-sdk/boat

## 0.8.0

### Minor Changes

- [#147](https://github.com/pandemicsyn/sandbar/pull/147) [`0aa1ccf`](https://github.com/pandemicsyn/sandbar/commit/0aa1ccffe036e90cc97c412a6da622239f04ce7e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Boat snapshots: `box.snapshot()` saves the disk of a running or archived sandbox as a Boat named snapshot under a unique `sandbar-snapshot-*` name, and `client.snapshots` inspects, lists, restores and deletes them. References pin the captured artifact, so a name saved again outside Sandbar rejects with `CONFLICT` instead of restoring or deleting the new contents. Restores boot a fresh machine of the captured type. Setup accepts `snapshots: { preserve }` and `lifecycle: { suspension: { preserve } }`: Boat keeps the disk only, so `Preserve.FILESYSTEM` is accepted and `Preserve.FILESYSTEM_AND_MEMORY` fails with `UNSUPPORTED` at connect, before any provider call.

- [#144](https://github.com/pandemicsyn/sandbar/pull/144) [`a2556c0`](https://github.com/pandemicsyn/sandbar/commit/a2556c0c34f5062e0f01ea78cc67524adf429f96) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Stream command output on Boat. `box.processes.start({ output: { mode: "stream" } })` starts the command detached, without Boat's 600-second limit, and delivers stdout and stderr as UTF-8 text as Boat sends it, reattaching from byte offsets when Boat ends a connection after 10 minutes. `terminate()` stops the command. Byte output, callback exec, piped stdin, terminals and reopening are not supported.

- [#146](https://github.com/pandemicsyn/sandbar/pull/146) [`e513d9a`](https://github.com/pandemicsyn/sandbar/commit/e513d9a81fdd57f62d85bc027e9a9db3e91b9883) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Set the sandbox lifetime the same way everywhere. Every adapter now takes `lifecycle: { lifetimeSeconds }` in setup, defaulting to 900 seconds; E2B, Vercel and Modal `timeoutSeconds`, Daytona `ttlMinutes` and boxd's top-level `lifetimeSeconds` still work but are deprecated. `create({ lifecycle: { lifetimeSeconds } })` overrides it for one sandbox, and `capabilities().lifetime` reports the accepted range. The CLI adds `create --ttl` and `run --ttl`.

- [#150](https://github.com/pandemicsyn/sandbar/pull/150) [`e566711`](https://github.com/pandemicsyn/sandbar/commit/e56671186220a2c0345bdd8f9540af0de8b7d69e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `snapshot.restore()` takes the create options `env`, `labels` and `lifecycle: { lifetimeSeconds }`. Adapters declare which they apply in `snapshotRestore.options` (shown in `capabilities().snapshots.restore`); anything else rejects before allocation. The CLI now accepts `--env`, `--label` and `--ttl` with `--snapshot`.

### Patch Changes

- Updated dependencies [[`29f6896`](https://github.com/pandemicsyn/sandbar/commit/29f689625b95d054f6c291cf60f34f8c97a53484), [`f9a0bb7`](https://github.com/pandemicsyn/sandbar/commit/f9a0bb737f748b4114672fd070a4bf995e27248d), [`e513d9a`](https://github.com/pandemicsyn/sandbar/commit/e513d9a81fdd57f62d85bc027e9a9db3e91b9883), [`e566711`](https://github.com/pandemicsyn/sandbar/commit/e56671186220a2c0345bdd8f9540af0de8b7d69e), [`4a074ab`](https://github.com/pandemicsyn/sandbar/commit/4a074ab86d513b4b923a387692479f9011f0ba0e)]:
  - @sandbar-sdk/adapter@0.8.0

## 0.7.0

### Minor Changes

- [#122](https://github.com/pandemicsyn/sandbar/pull/122) [`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Accept `resources: { vcpus, memoryMiB }` minimums and report the real size on inspect. boxd, Vercel and Boat pick their smallest native size that meets them and reject at connect, before any provider request, when none does; the old `size`, `vcpus` and `machine` keys stay as deprecated aliases. Daytona and E2B build OCI snapshots and templates at that size and reject a prepared snapshot or template that is smaller or does not report its size, including E2B's `base` template.

### Patch Changes

- Updated dependencies [[`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf)]:
  - @sandbar-sdk/adapter@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [[`22e06ed`](https://github.com/pandemicsyn/sandbar/commit/22e06ed1fc0275fd68fd959ea4ece091f4bed180), [`7fc61f8`](https://github.com/pandemicsyn/sandbar/commit/7fc61f8a36bd7ec7973546d630d4b567bb0cfdbc), [`3a8c047`](https://github.com/pandemicsyn/sandbar/commit/3a8c04763ad7804f689c00f355683e235bc00206)]:
  - @sandbar-sdk/adapter@0.6.0

## 0.5.0

### Minor Changes

- [#116](https://github.com/pandemicsyn/sandbar/pull/116) [`67bc9dd`](https://github.com/pandemicsyn/sandbar/commit/67bc9dd739f4f6020dfb92385bdbff4eb12d112e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the experimental `@sandbar-sdk/boat` adapter for Boat full-VM sandboxes: create with an idempotency key, argv/shell exec with exact output bytes and finite stdin, binary files up to 5 MiB, archive/resume, renewal and confirmed permanent delete. The CLI recognizes `--provider boat` with `BOAT_API_KEY` and `BOAT_NETWORK=internet`.

### Patch Changes

- Updated dependencies []:
  - @sandbar-sdk/adapter@0.5.0
