# @sandbar-sdk/cli

## 0.3.0

### Minor Changes

- [#113](https://github.com/pandemicsyn/sandbar/pull/113) [`3d1fd51`](https://github.com/pandemicsyn/sandbar/commit/3d1fd5165350decc4aa094ce7990c81f1b7367e0) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add `@sandbar-sdk/cli`, the agent-first `sandbar` command line. It creates, lists, inspects and removes sandboxes on any installed adapter, runs commands with `exec`, `sh` and `run`, copies files with `cp`, and reports setup problems with `doctor`. Every command has a stable `--json` envelope and documented exit codes. Adapters are installed separately with `sandbar adapter add`, credentials can come from 1Password, Bitwarden Secrets Manager or `pass`, and the CLI ships its own agent skill and shell completion.

### Patch Changes

- Updated dependencies [[`d384d6f`](https://github.com/pandemicsyn/sandbar/commit/d384d6f670bd4eec9bfc5d7cde6a9ea36221decc), [`321ae0c`](https://github.com/pandemicsyn/sandbar/commit/321ae0c97a0d35568d3e109f32d9bc60e01fed3f), [`ce1084f`](https://github.com/pandemicsyn/sandbar/commit/ce1084fed499651b9763af4ba9152e11bac10e5c)]:
  - sandbar-sdk@0.3.0
  - @sandbar-sdk/adapter@0.3.0
