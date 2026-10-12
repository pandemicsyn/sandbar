# @sandbar-sdk/e2b

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
