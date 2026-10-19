# @sandbar-sdk/e2b

## 0.7.0

### Minor Changes

- [#122](https://github.com/pandemicsyn/sandbar/pull/122) [`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Accept `resources: { vcpus, memoryMiB }` minimums and report the real size on inspect. boxd, Vercel and Boat pick their smallest native size that meets them and reject at connect, before any provider request, when none does; the old `size`, `vcpus` and `machine` keys stay as deprecated aliases. Daytona and E2B build OCI snapshots and templates at that size and reject a prepared snapshot or template that is smaller or does not report its size, including E2B's `base` template.

### Patch Changes

- [#127](https://github.com/pandemicsyn/sandbar/pull/127) [`6ee114d`](https://github.com/pandemicsyn/sandbar/commit/6ee114d2f46c3ea0d81b430d517996684d9524d7) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `daytona({...})` and `e2b({...})` now accept `resources: { vcpus, memoryMiB }`, matching the adapter configuration. The `daytona()` network setting's documentation now names `daytona-default` as the default.
- Updated dependencies [[`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf)]:
  - @sandbar-sdk/adapter@0.7.0

## 0.6.0

### Minor Changes

- [#118](https://github.com/pandemicsyn/sandbar/pull/118) [`22e06ed`](https://github.com/pandemicsyn/sandbar/commit/22e06ed1fc0275fd68fd959ea4ece091f4bed180) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `sandboxes.create({ env })` sets environment variables for every command, process and terminal in the sandbox, including after reopening; a per-call `env` overrides a name. Daytona, E2B and Vercel map it to their native create-time environment. Adapters opt in with `supports.createEnv`, reported as `capabilities().createEnv`; elsewhere (boxd) `create({ env })` rejects with `UnsupportedFeatureError` before allocating anything. Values are never saved in recovery references or tokens, and never appear in telemetry or error messages.

- [#118](https://github.com/pandemicsyn/sandbar/pull/118) [`7fc61f8`](https://github.com/pandemicsyn/sandbar/commit/7fc61f8a36bd7ec7973546d630d4b567bb0cfdbc) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Inspect, list and delete prepared images: Daytona maps native snapshots and E2B maps templates. Deletion refuses public or shared images, captured sandbox snapshots and images that sandboxes or warm pools still use before sending one unreplayed native delete. Built images now report a `reference` with verified ownership when the build's own request created them.

- [#118](https://github.com/pandemicsyn/sandbar/pull/118) [`3a8c047`](https://github.com/pandemicsyn/sandbar/commit/3a8c04763ad7804f689c00f355683e235bc00206) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add `sandboxes.list({ cursor?, limit? })`: a bounded page of sandboxes with `id`, `state` and a `reference` that `sandboxes.get()` reopens, plus `coverage` (`provider-scope` or `sandbar-managed`), matching `snapshots.list()` and `volumes.list()`. Adapters implement the optional `sandboxList` hook and return `reference: null` when native evidence cannot verify identity; listed references never claim ownership, generation or creation receipts the provider does not show. Daytona and E2B list Sandbar-created sandboxes with `verified-created` references; boxd and Vercel list with `unknown` ownership. `operations.inventory()` is unchanged and is derived from `sandboxList` when an adapter only implements the new hook.

### Patch Changes

- Updated dependencies [[`22e06ed`](https://github.com/pandemicsyn/sandbar/commit/22e06ed1fc0275fd68fd959ea4ece091f4bed180), [`7fc61f8`](https://github.com/pandemicsyn/sandbar/commit/7fc61f8a36bd7ec7973546d630d4b567bb0cfdbc), [`3a8c047`](https://github.com/pandemicsyn/sandbar/commit/3a8c04763ad7804f689c00f355683e235bc00206)]:
  - @sandbar-sdk/adapter@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies []:
  - @sandbar-sdk/adapter@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`3a0e3df`](https://github.com/pandemicsyn/sandbar/commit/3a0e3dff3b5c5ec55955efe0da4497cf7b7efcbb)]:
  - @sandbar-sdk/adapter@0.4.0

## 0.3.0

### Minor Changes

- [#109](https://github.com/pandemicsyn/sandbar/pull/109) [`321ae0c`](https://github.com/pandemicsyn/sandbar/commit/321ae0c97a0d35568d3e109f32d9bc60e01fed3f) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Use the same network names on every adapter. Configure `network: "blocked" | "internet"` in adapter setup and, where needed, `create({ network })` or `restore({ network })`. Vercel accepts `blocked` and `internet` in place of `vercel-deny-all` and `vercel-allow-all`. Daytona adds `internet`, which requires an organization without limited sandbox egress and never falls back to the tier-dependent `daytona-default`. The `networkPolicy` option and Vercel's native names keep working and are deprecated. Adapters can declare `networkPolicyAliases` so the SDK resolves deprecated names before support checks.

- [#110](https://github.com/pandemicsyn/sandbar/pull/110) [`ce1084f`](https://github.com/pandemicsyn/sandbar/commit/ce1084fed499651b9763af4ba9152e11bac10e5c) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Make every adapter's defaults work on first use, and match lifetime limits to each provider.

  - Daytona now defaults to `network: "daytona-default"`, which every account tier can create. Strict `blocked` egress stays available when you select it. Connections that relied on the old implicit `blocked` default must set `network: "blocked"` to reopen sandboxes created that way.
  - E2B and boxd now default to `preview.access: "public"`, matching each provider's native default, so `box.preview(port)` works without extra setup. Select `preview.access: "protected"` to keep sandboxes closed to inbound traffic.
  - Vercel now defaults to the `vercel/sandbox/universal:latest` image, so processes and terminals work without extra setup. Set `image: "vercel/sandbox/node:24"` to keep using sandboxes and snapshots created with the previous default.
  - Every adapter now defaults to a 15-minute sandbox lifetime. Daytona previously defaulted to 60 minutes; E2B and Vercel previously defaulted to 5 minutes.
  - Lifetime and renewal limits now match the providers. E2B and Vercel accept up to 24 hours, their longest plan limit; each provider still enforces lower plan limits. Daytona and boxd no longer impose a maximum, because neither provider documents one.
  - Renewal capabilities omit `maxSeconds` when the provider has no maximum.

### Patch Changes

- [#108](https://github.com/pandemicsyn/sandbar/pull/108) [`a69d232`](https://github.com/pandemicsyn/sandbar/commit/a69d23232cf7afa7b6ae3ba24b8c0f4bc6580648) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - When a provider refuses to create a sandbox (quota, permission, invalid request, rate limit), `create()` now rejects with a matching error code such as `FORBIDDEN` or `CAPACITY` and includes the provider's own reason, instead of reporting an unknown outcome. Server errors, lost responses and refusals after an image was already built still report an unknown outcome.
- Updated dependencies [[`321ae0c`](https://github.com/pandemicsyn/sandbar/commit/321ae0c97a0d35568d3e109f32d9bc60e01fed3f), [`ce1084f`](https://github.com/pandemicsyn/sandbar/commit/ce1084fed499651b9763af4ba9152e11bac10e5c)]:
  - @sandbar-sdk/adapter@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @sandbar-sdk/adapter@0.2.0

## 0.1.0

### Minor Changes

- [#90](https://github.com/pandemicsyn/sandbar/pull/90) [`5445543`](https://github.com/pandemicsyn/sandbar/commit/544554308f470b182fae3251598efd68ea0cd167) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Resolve omitted create and restore network policies from adapter setup, with blocked as the fallback for existing adapters. Daytona uses its configured policy; E2B accepts a blocked/internet setup default. SDK snapshot restore now accepts omitted input while native requests remain fully resolved. New recovery references retain the effective policy.

- [#85](https://github.com/pandemicsyn/sandbar/pull/85) [`18d7c85`](https://github.com/pandemicsyn/sandbar/commit/18d7c85ef91ad1bf4de730f86bcac1d08ccdb211) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Distribute the official Daytona and E2B integrations as separately installed @sandbar-sdk/daytona and @sandbar-sdk/e2b packages. Move the shared binding helper and portable image input types into @sandbar-sdk/adapter. Remove unpublished SDK provider subpaths and native E2B dependencies from core; update imports and install the selected adapter. Preserve provider IDs, defaults, lifecycle and recovery behavior, and coordinate all four packages in the initial lockstep release group.

### Patch Changes

- Updated dependencies [[`3906f76`](https://github.com/pandemicsyn/sandbar/commit/3906f76c6bb7457de304e98080671b45d806f9ca), [`65634f9`](https://github.com/pandemicsyn/sandbar/commit/65634f9c53f37bc2b323fce407e82f19b4b94515), [`790c4c2`](https://github.com/pandemicsyn/sandbar/commit/790c4c27fc17f7c2b61c74d573f53978a3b0a033), [`16fc203`](https://github.com/pandemicsyn/sandbar/commit/16fc203ae5257a863b05047aa3ec9f2e592a06ed), [`5445543`](https://github.com/pandemicsyn/sandbar/commit/544554308f470b182fae3251598efd68ea0cd167), [`b15d608`](https://github.com/pandemicsyn/sandbar/commit/b15d608453f778931c71392eeddc2157ca047899), [`4a12126`](https://github.com/pandemicsyn/sandbar/commit/4a121264418ad392cce92aae23fc6ebec62fa50b), [`2f9c95d`](https://github.com/pandemicsyn/sandbar/commit/2f9c95de558d420e82d42206907e6e4a32c588c3), [`cd89f31`](https://github.com/pandemicsyn/sandbar/commit/cd89f3192a4abe3f67614f362117050603ecac91), [`5756306`](https://github.com/pandemicsyn/sandbar/commit/57563060068f1b24e7b33ed3808cd0182ff02a15), [`cbace3f`](https://github.com/pandemicsyn/sandbar/commit/cbace3f34e46fe4d84a3379e463f7ab4812212e3), [`13a76ba`](https://github.com/pandemicsyn/sandbar/commit/13a76ba98c6f6cb8b5dec9f077df4642859a5b2c), [`c953d6c`](https://github.com/pandemicsyn/sandbar/commit/c953d6c43c331a4fb12901a7735159c3c425b750), [`18d7c85`](https://github.com/pandemicsyn/sandbar/commit/18d7c85ef91ad1bf4de730f86bcac1d08ccdb211), [`e0582ad`](https://github.com/pandemicsyn/sandbar/commit/e0582ad885a379961b7029c62d1054f8ddfd5e04), [`995a9c1`](https://github.com/pandemicsyn/sandbar/commit/995a9c16e5419527b9d88f55bc4ab4240034c7d7), [`7d7e381`](https://github.com/pandemicsyn/sandbar/commit/7d7e381f2f4203e7a3846cf560987275b0158d78), [`e3ea55e`](https://github.com/pandemicsyn/sandbar/commit/e3ea55e6a2696bca8a6baaf24cc5247849e5bdec), [`d186cea`](https://github.com/pandemicsyn/sandbar/commit/d186ceac2ae70665b62de73c2582c3ac05b8f3cb), [`09c4916`](https://github.com/pandemicsyn/sandbar/commit/09c491600294ccfde4a48fc8211221d9c591cf34), [`a9d59b0`](https://github.com/pandemicsyn/sandbar/commit/a9d59b0a4e3d14fa5fbbb6bd5d78dfc7322187b9), [`efb6ed7`](https://github.com/pandemicsyn/sandbar/commit/efb6ed7c479bc0a5f60150188064f1eda6f338fd)]:
  - @sandbar-sdk/adapter@0.1.0
