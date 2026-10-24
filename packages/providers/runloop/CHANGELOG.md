# @sandbar-sdk/runloop

## 0.8.0

### Minor Changes

- [#152](https://github.com/pandemicsyn/sandbar/pull/152) [`f9a0bb7`](https://github.com/pandemicsyn/sandbar/commit/f9a0bb737f748b4114672fd070a4bf995e27248d) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `sandboxes.list()` items now carry `labels` (the labels set at create, without adapter markers; `null` where the provider keeps none) and `createdAt` (the provider's creation time, or `null`). Daytona, E2B, Vercel and Modal report labels; Daytona, E2B (start time), Vercel, boxd and Runloop report creation time. Adapters add them with the new `listedLabels` and `listedTime` helpers. The CLI's `ls --remote` shows both, and the new `sandbar gc --label k=v [--older-than 2h] [--dry-run]` destroys provider-listed sandboxes whose labels match, such as those a killed CI job left behind, and drops their store records. Durations also accept days, like `1d`.

- [#146](https://github.com/pandemicsyn/sandbar/pull/146) [`e513d9a`](https://github.com/pandemicsyn/sandbar/commit/e513d9a81fdd57f62d85bc027e9a9db3e91b9883) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Set the sandbox lifetime the same way everywhere. Every adapter now takes `lifecycle: { lifetimeSeconds }` in setup, defaulting to 900 seconds; E2B, Vercel and Modal `timeoutSeconds`, Daytona `ttlMinutes` and boxd's top-level `lifetimeSeconds` still work but are deprecated. `create({ lifecycle: { lifetimeSeconds } })` overrides it for one sandbox, and `capabilities().lifetime` reports the accepted range. The CLI adds `create --ttl` and `run --ttl`.

- [#150](https://github.com/pandemicsyn/sandbar/pull/150) [`e566711`](https://github.com/pandemicsyn/sandbar/commit/e56671186220a2c0345bdd8f9540af0de8b7d69e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `snapshot.restore()` takes the create options `env`, `labels` and `lifecycle: { lifetimeSeconds }`. Adapters declare which they apply in `snapshotRestore.options` (shown in `capabilities().snapshots.restore`); anything else rejects before allocation. The CLI now accepts `--env`, `--label` and `--ttl` with `--snapshot`.

- [#145](https://github.com/pandemicsyn/sandbar/pull/145) [`6e83f0b`](https://github.com/pandemicsyn/sandbar/commit/6e83f0bc04757101695536625566ff4e4198f3ee) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Stream command output on Runloop. `box.processes.start({ output: { mode: "stream" } })` delivers stdout and stderr as UTF-8 text from Runloop's server-sent log streams, reopening them from byte offsets, and `terminate()` kills the execution. Byte output, callback exec, piped stdin, terminals and reopening are not supported. Not yet tested against the live service.

- [#148](https://github.com/pandemicsyn/sandbar/pull/148) [`29f6896`](https://github.com/pandemicsyn/sandbar/commit/29f689625b95d054f6c291cf60f34f8c97a53484) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Accept the `snapshots: { preserve }` setup option on the Vercel and Runloop adapters, so the same setting works on every adapter with snapshots. `Preserve.FILESYSTEM` matches their filesystem-only snapshots; `Preserve.FILESYSTEM_AND_MEMORY` rejects at connect with `UNSUPPORTED` before any provider call.

### Patch Changes

- Updated dependencies [[`29f6896`](https://github.com/pandemicsyn/sandbar/commit/29f689625b95d054f6c291cf60f34f8c97a53484), [`f9a0bb7`](https://github.com/pandemicsyn/sandbar/commit/f9a0bb737f748b4114672fd070a4bf995e27248d), [`e513d9a`](https://github.com/pandemicsyn/sandbar/commit/e513d9a81fdd57f62d85bc027e9a9db3e91b9883), [`e566711`](https://github.com/pandemicsyn/sandbar/commit/e56671186220a2c0345bdd8f9540af0de8b7d69e), [`4a074ab`](https://github.com/pandemicsyn/sandbar/commit/4a074ab86d513b4b923a387692479f9011f0ba0e)]:
  - @sandbar-sdk/adapter@0.8.0

## 0.7.0

### Minor Changes

- [#125](https://github.com/pandemicsyn/sandbar/pull/125) [`2cb4539`](https://github.com/pandemicsyn/sandbar/commit/2cb4539ee56c2c66036d91c9e6e551b4d97f82e7) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the experimental `@sandbar-sdk/runloop` adapter for Runloop Devboxes: blocked egress by default through a managed deny-all network policy, argv/shell exec with exact output bytes and finite stdin, binary files, suspend/resume, disk snapshots with restore, authenticated or public previews, and portable `resources` sizing. The CLI recognizes `--provider runloop` with `RUNLOOP_API_KEY` and optional `RUNLOOP_NETWORK=internet`.

### Patch Changes

- Updated dependencies [[`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf)]:
  - @sandbar-sdk/adapter@0.7.0
