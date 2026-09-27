---
title: SDK quickstart
description: Create a sandbox with a built-in or custom adapter in one Node.js or Bun process.
---

Sandbar's primary API is `sandbar-sdk`. Daytona and Modal adapter imports are included in that package. Once published, one `npm install sandbar-sdk` supplies the SDK and both built-in subpaths. The SDK works in a server-side Node.js or Bun process without a Sandbar service or SQL database. Packages are currently **unpublished**; the repository's [packed consumer check](https://github.com/pandemicsyn/sandbar/blob/main/packages/sdk-qualification/package-smoke.mjs) verifies the install shape with local tarballs.

```ts
import { Sandbar, Image } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

const sandbar = await Sandbar.connect(
  daytona({ apiKey: process.env.DAYTONA_API_KEY!, target: "us" }),
);
try {
  const box = await sandbar.sandboxes.create({ environment: Image.prepared("snapshot-id") });
  await box.destroy();
} finally {
  await sandbar.close();
}
```

The factory packages typed settings and credentials, then `Sandbar.connect` validates and verifies the native connection. Constructing the factory makes no provider request. This is the SDK API shape; live Daytona qualification is still pending. Import `modal` from `sandbar-sdk/modal` for a Modal App, subject to its documented capabilities.

## Custom adapters

Install `sandbar-sdk` and the chosen adapter package, then pass the definition with its config and credentials:

```ts
import { Sandbar, Image } from "sandbar-sdk";
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
