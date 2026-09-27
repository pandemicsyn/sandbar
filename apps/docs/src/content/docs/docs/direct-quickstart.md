---
title: SDK quickstart
description: Create a sandbox with a custom adapter in one Node.js or Bun process.
---

Sandbar's primary API is `sandbar-sdk/direct`. Install the SDK and a provider adapter in your server-side application, supply provider credentials, and create a sandbox. This path needs no Sandbar service or SQL database. Packages are currently **unpublished**; the repository's [packed consumer check](https://github.com/pandemicsyn/sandbar/blob/main/packages/sdk-qualification/package-smoke.mjs) verifies the install shape with local tarballs.

```ts
import { Sandbar, Image } from "sandbar-sdk/direct";
import { acme } from "@acme/sandbar-adapter";

const sandbar = await Sandbar.connect({
  adapter: acme,
  config: { region: "us" },
  credentials: { token: process.env.ACME_TOKEN! },
});
try {
  const box = await sandbar.sandboxes.create({
    environment: Image.prepared("image-123"),
    networkPolicy: "blocked",
  });
  try {
    console.log(box.id);
  } finally {
    await box.destroy();
  }
} finally {
  await sandbar.close();
}
```

The adapter must verify the native account and enforce blocked network access. The checked-in [Acme adapter fixture](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/acme-adapter.ts) and [runnable test](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/acme.test.ts) show the full shape without making live provider calls. See [Write an adapter](/docs/guides/write-an-adapter/) to implement one.

`close()` releases local client resources and does not destroy sandboxes. Save a recovery reference before crossing a mutation boundary. If a response is lost, [observe the prior attempt](/docs/guides/recovery/) instead of submitting it again.
