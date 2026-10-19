# @sandbar-sdk/runloop

## 0.7.0

### Minor Changes

- [#125](https://github.com/pandemicsyn/sandbar/pull/125) [`2cb4539`](https://github.com/pandemicsyn/sandbar/commit/2cb4539ee56c2c66036d91c9e6e551b4d97f82e7) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the experimental `@sandbar-sdk/runloop` adapter for Runloop Devboxes: blocked egress by default through a managed deny-all network policy, argv/shell exec with exact output bytes and finite stdin, binary files, suspend/resume, disk snapshots with restore, authenticated or public previews, and portable `resources` sizing. The CLI recognizes `--provider runloop` with `RUNLOOP_API_KEY` and optional `RUNLOOP_NETWORK=internet`.

### Patch Changes

- Updated dependencies [[`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf)]:
  - @sandbar-sdk/adapter@0.7.0
