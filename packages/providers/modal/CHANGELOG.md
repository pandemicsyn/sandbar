# @sandbar-sdk/modal

## 0.8.0

### Minor Changes

- [#152](https://github.com/pandemicsyn/sandbar/pull/152) [`f9a0bb7`](https://github.com/pandemicsyn/sandbar/commit/f9a0bb737f748b4114672fd070a4bf995e27248d) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `sandboxes.list()` items now carry `labels` (the labels set at create, without adapter markers; `null` where the provider keeps none) and `createdAt` (the provider's creation time, or `null`). Daytona, E2B, Vercel and Modal report labels; Daytona, E2B (start time), Vercel, boxd and Runloop report creation time. Adapters add them with the new `listedLabels` and `listedTime` helpers. The CLI's `ls --remote` shows both, and the new `sandbar gc --label k=v [--older-than 2h] [--dry-run]` destroys provider-listed sandboxes whose labels match, such as those a killed CI job left behind, and drops their store records. Durations also accept days, like `1d`.

- [#143](https://github.com/pandemicsyn/sandbar/pull/143) [`f1d5c3f`](https://github.com/pandemicsyn/sandbar/commit/f1d5c3f69cbbac81fb5c473db3a221a2f0a860a5) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Accept the `snapshots: { preserve }` setup option on the Modal adapter. `Preserve.FILESYSTEM` matches Modal's filesystem snapshots; `Preserve.FILESYSTEM_AND_MEMORY` rejects at connect with `UNSUPPORTED` before any Modal call.

- [#132](https://github.com/pandemicsyn/sandbar/pull/132) [`2349b4d`](https://github.com/pandemicsyn/sandbar/commit/2349b4db3f84321c55664569564aaa63e7b9b5ed) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add filesystem snapshots to the experimental Modal adapter. `box.snapshot()` captures the sandbox root filesystem as a Modal image with Modal's default 30-day retention, `snapshot.restore()` creates a new blocked-network sandbox from it, and `snapshots.get()`, `inspect()` and `delete()` work on saved references. Memory snapshots, directory snapshots and `snapshots.list()` are not supported: Modal has no snapshot listing API, so keep the returned references.

- [#141](https://github.com/pandemicsyn/sandbar/pull/141) [`82b2eaf`](https://github.com/pandemicsyn/sandbar/commit/82b2eaf8f04ce69ba15a172da39b386f3c1687aa) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Stream command output on Modal. `box.processes.start({ output: { mode: "stream" } })` delivers stdout and stderr as the command writes them, as text or exact bytes, accepts piped stdin, and supports `signal("SIGTERM" | "SIGKILL")` and `terminate()`. `box.exec(input, { onOutput })` now works on Modal too. Signals reach the launched process through a PID recorded in `/tmp`, so the image needs `/bin/sh`, `cat` and `kill`. Terminals, status checks and process reopening are not supported.

- [#146](https://github.com/pandemicsyn/sandbar/pull/146) [`e513d9a`](https://github.com/pandemicsyn/sandbar/commit/e513d9a81fdd57f62d85bc027e9a9db3e91b9883) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Set the sandbox lifetime the same way everywhere. Every adapter now takes `lifecycle: { lifetimeSeconds }` in setup, defaulting to 900 seconds; E2B, Vercel and Modal `timeoutSeconds`, Daytona `ttlMinutes` and boxd's top-level `lifetimeSeconds` still work but are deprecated. `create({ lifecycle: { lifetimeSeconds } })` overrides it for one sandbox, and `capabilities().lifetime` reports the accepted range. The CLI adds `create --ttl` and `run --ttl`.

- [#150](https://github.com/pandemicsyn/sandbar/pull/150) [`e566711`](https://github.com/pandemicsyn/sandbar/commit/e56671186220a2c0345bdd8f9540af0de8b7d69e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `snapshot.restore()` takes the create options `env`, `labels` and `lifecycle: { lifetimeSeconds }`. Adapters declare which they apply in `snapshotRestore.options` (shown in `capabilities().snapshots.restore`); anything else rejects before allocation. The CLI now accepts `--env`, `--label` and `--ttl` with `--snapshot`.

- [#148](https://github.com/pandemicsyn/sandbar/pull/148) [`29f6896`](https://github.com/pandemicsyn/sandbar/commit/29f689625b95d054f6c291cf60f34f8c97a53484) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add `snapshots: { retentionSeconds }` to the Vercel and Modal adapters to set how long snapshots are kept (`0` keeps them until deleted). Vercel sends native `expiration`, counted from last use, and accepts it in disposable mode only. Modal sends `ttlMs`, counted from capture. `snapshot({ retention: { minimumSeconds } })` is checked against the configured value.

### Patch Changes

- Updated dependencies [[`29f6896`](https://github.com/pandemicsyn/sandbar/commit/29f689625b95d054f6c291cf60f34f8c97a53484), [`f9a0bb7`](https://github.com/pandemicsyn/sandbar/commit/f9a0bb737f748b4114672fd070a4bf995e27248d), [`e513d9a`](https://github.com/pandemicsyn/sandbar/commit/e513d9a81fdd57f62d85bc027e9a9db3e91b9883), [`e566711`](https://github.com/pandemicsyn/sandbar/commit/e56671186220a2c0345bdd8f9540af0de8b7d69e), [`4a074ab`](https://github.com/pandemicsyn/sandbar/commit/4a074ab86d513b4b923a387692479f9011f0ba0e)]:
  - @sandbar-sdk/adapter@0.8.0

## 0.7.0

### Minor Changes

- [#126](https://github.com/pandemicsyn/sandbar/pull/126) [`4edf15c`](https://github.com/pandemicsyn/sandbar/commit/4edf15cfee9ea1b438c405044d9f90d50ff11f00) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Publish the experimental `@sandbar-sdk/modal` adapter to npm with the rest of the lockstep release group.

### Patch Changes

- Updated dependencies [[`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf)]:
  - @sandbar-sdk/adapter@0.7.0
