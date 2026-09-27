---
title: Direct TypeScript quickstart
description: Run the server-side SDK against the independent fake provider from source.
---

The direct SDK uses a provider driver in your Node.js or Bun process. Keep credentials on the server. This exercise uses a **local fake simulation**, not a production sandbox.

## Run the checked-in example

Use Bun 1.3.14 and Node.js 22.23.2 or 26.4.0, the versions measured in [runtime qualification](https://github.com/pandemicsyn/sandbar/blob/af06bb6/docs/sdk-runtime-qualification.md). From the repository root:

```sh
bun install --frozen-lockfile
bun run build:packages
bun run --cwd apps/docs examples:test
```

The example starts the independent fake provider on loopback, seeds one command fixture, imports `@sandbar/sdk/direct` and `@sandbar/provider-fake/client` from this workspace, then creates a sandbox, transfers bytes, executes, inspects and destroys it. See [the runnable source](https://github.com/pandemicsyn/sandbar/blob/b4295bda452b4fc7cd655ee48b09798df47ffba7/apps/docs/examples/direct.test.ts).

For an application outside this repository, use the verified local archive process in [`bun run package:smoke`](https://github.com/pandemicsyn/sandbar/blob/af06bb6/packages/sdk-qualification/package-smoke.mjs). It builds and packs the SDK and its portable dependencies into an external consumer. There are no published registry artifacts yet.

## Create a client

```ts
import { Sandbar, Image } from "@sandbar/sdk/direct";
import { fakeProvider } from "@sandbar/provider-fake/client";

const sandbar = Sandbar.direct({
  provider: await fakeProvider({
    url: process.env.FAKE_PROVIDER_URL!,
    token: process.env.FAKE_PROVIDER_TOKEN!,
  }),
});

try {
  const box = await sandbar.sandboxes.create({ environment: Image.prepared("fake-starter") });
  try {
    await box.writeFile("/input.bin", Uint8Array.of(0, 255));
    const bytes = await box.readFile("/input.bin");
    console.log(bytes.length);
  } finally {
    await box.destroy();
  }
} finally {
  await sandbar.close();
}
```

The fake server must already be running for this snippet. `close()` releases client activity; it does **not** destroy a sandbox. In real applications, retain a sandbox ID or recovery reference before crossing process boundaries, and handle uncertain mutation outcomes as described in [Recovery](/docs/guides/recovery/).
