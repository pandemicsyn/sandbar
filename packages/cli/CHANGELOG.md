# @sandbar-sdk/cli

## 0.7.0

### Minor Changes

- [#125](https://github.com/pandemicsyn/sandbar/pull/125) [`2cb4539`](https://github.com/pandemicsyn/sandbar/commit/2cb4539ee56c2c66036d91c9e6e551b4d97f82e7) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the experimental `@sandbar-sdk/runloop` adapter for Runloop Devboxes: blocked egress by default through a managed deny-all network policy, argv/shell exec with exact output bytes and finite stdin, binary files, suspend/resume, disk snapshots with restore, authenticated or public previews, and portable `resources` sizing. The CLI recognizes `--provider runloop` with `RUNLOOP_API_KEY` and optional `RUNLOOP_NETWORK=internet`.

### Patch Changes

- Updated dependencies [[`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf)]:
  - sandbar-sdk@0.7.0
  - @sandbar-sdk/adapter@0.7.0

## 0.6.0

### Minor Changes

- [#118](https://github.com/pandemicsyn/sandbar/pull/118) [`22e06ed`](https://github.com/pandemicsyn/sandbar/commit/22e06ed1fc0275fd68fd959ea4ece091f4bed180) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `sandbar create --env K=V` and `--env-file <path>` set environment variables for every command in the sandbox. `exec`, `sh` and `run` accept `--env-file` for one command, and `--env NAME` without a value copies `NAME` from the calling environment. Values are never written to the store, `--json` output or messages.

- [#118](https://github.com/pandemicsyn/sandbar/pull/118) [`7fc61f8`](https://github.com/pandemicsyn/sandbar/commit/7fc61f8a36bd7ec7973546d630d4b567bb0cfdbc) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `sandbar image rm <name>` deletes a built image on the provider and drops its record; an unknown outcome exits 6 and keeps the record so a later `image rm` checks how the delete ended without resending it. `sandbar image ls --remote` lists the provider's images for the profile.

- [#118](https://github.com/pandemicsyn/sandbar/pull/118) [`f9480d3`](https://github.com/pandemicsyn/sandbar/commit/f9480d30705191a63153bf89aecc2667b8327240) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add `sandbar ls --remote`, which lists the selected profile's sandboxes from the provider and matches them to store names, and `sandbar adopt <id> [--name <name>]`, which records a listed sandbox so other commands can reach it. Adopted sandboxes are not treated as created by the CLI: `rm --all` skips them and `rm <name>` needs `--force`.

### Patch Changes

- Updated dependencies [[`22e06ed`](https://github.com/pandemicsyn/sandbar/commit/22e06ed1fc0275fd68fd959ea4ece091f4bed180), [`7fc61f8`](https://github.com/pandemicsyn/sandbar/commit/7fc61f8a36bd7ec7973546d630d4b567bb0cfdbc), [`3a8c047`](https://github.com/pandemicsyn/sandbar/commit/3a8c04763ad7804f689c00f355683e235bc00206)]:
  - sandbar-sdk@0.6.0
  - @sandbar-sdk/adapter@0.6.0

## 0.5.0

### Minor Changes

- [#116](https://github.com/pandemicsyn/sandbar/pull/116) [`67bc9dd`](https://github.com/pandemicsyn/sandbar/commit/67bc9dd739f4f6020dfb92385bdbff4eb12d112e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the experimental `@sandbar-sdk/boat` adapter for Boat full-VM sandboxes: create with an idempotency key, argv/shell exec with exact output bytes and finite stdin, binary files up to 5 MiB, archive/resume, renewal and confirmed permanent delete. The CLI recognizes `--provider boat` with `BOAT_API_KEY` and `BOAT_NETWORK=internet`.

### Patch Changes

- Updated dependencies []:
  - @sandbar-sdk/adapter@0.5.0
  - sandbar-sdk@0.5.0

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
