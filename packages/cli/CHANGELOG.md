# @sandbar-sdk/cli

## 0.4.0

### Minor Changes

- [#114](https://github.com/pandemicsyn/sandbar/pull/114) [`3a0e3df`](https://github.com/pandemicsyn/sandbar/commit/3a0e3dff3b5c5ec55955efe0da4497cf7b7efcbb) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add `sandbar image build`, `image ls`, `image inspect` and `image forget`. On providers that build images first (E2B, Daytona), `--image` uses the build recorded for that reference and profile and fails before creating anything when there is none; `--build` or `images.autoBuild` builds it on demand.

### Patch Changes

- [#114](https://github.com/pandemicsyn/sandbar/pull/114) [`bee2b53`](https://github.com/pandemicsyn/sandbar/commit/bee2b5337aa87acc387db7ba542a58af63ca9bd5) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Report an installed adapter that fails to load as `ADAPTER_LOAD_FAILED` (exit 4) with the adapter's own error, instead of calling it not installed, and resolve adapter packages whose `exports` use nested conditions.
- Updated dependencies [[`3a0e3df`](https://github.com/pandemicsyn/sandbar/commit/3a0e3dff3b5c5ec55955efe0da4497cf7b7efcbb)]:
  - sandbar-sdk@0.4.0
  - @sandbar-sdk/adapter@0.4.0

## 0.3.0

### Minor Changes

- [#113](https://github.com/pandemicsyn/sandbar/pull/113) [`3d1fd51`](https://github.com/pandemicsyn/sandbar/commit/3d1fd5165350decc4aa094ce7990c81f1b7367e0) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add `@sandbar-sdk/cli`, the agent-first `sandbar` command line. It creates, lists, inspects and removes sandboxes on any installed adapter, runs commands with `exec`, `sh` and `run`, copies files with `cp`, and reports setup problems with `doctor`. Every command has a stable `--json` envelope and documented exit codes. Adapters are installed separately with `sandbar adapter add`, credentials can come from 1Password, Bitwarden Secrets Manager or `pass`, and the CLI ships its own agent skill and shell completion.

### Patch Changes

- Updated dependencies [[`d384d6f`](https://github.com/pandemicsyn/sandbar/commit/d384d6f670bd4eec9bfc5d7cde6a9ea36221decc), [`321ae0c`](https://github.com/pandemicsyn/sandbar/commit/321ae0c97a0d35568d3e109f32d9bc60e01fed3f), [`ce1084f`](https://github.com/pandemicsyn/sandbar/commit/ce1084fed499651b9763af4ba9152e11bac10e5c)]:
  - sandbar-sdk@0.3.0
  - @sandbar-sdk/adapter@0.3.0
