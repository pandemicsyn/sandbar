---
title: Self-hosted service quickstart
description: Exercise the Sandbar API and remote TypeScript SDK against a local service and fake provider.
---

The remote SDK connects to a Sandbar service that you operate. The service persists operations and project state. This source checkout uses SQLite by default and can be configured for MySQL. The only qualified provider remains the local fake simulation.

## Run the verified flow

From the repository root, with Bun 1.3.14:

```sh
bun install --frozen-lockfile
bun run build:packages
bun run --cwd apps/docs examples:test
```

The [checked-in remote example](https://github.com/pandemicsyn/sandbar/blob/7f87057c3de255b1878597c09dcdaf0c432a5289/apps/docs/examples/remote.test.ts) creates temporary key and setup-token files, starts a fake provider and the service on loopback, creates a project and fake connection, then exercises the remote SDK. The test cleans up its temporary files and processes. This is the reproducible onboarding path until packages are published.

## Connect from server-side TypeScript

```ts
import { Sandbar, Image } from "sandbar-sdk/remote";

const sandbar = Sandbar.connect({
  url: "http://127.0.0.1:3000",
  token: process.env.SANDBAR_TOKEN!,
  projectId: process.env.SANDBAR_PROJECT_ID!,
});
try {
  const box = await sandbar.sandboxes.create({ environment: Image.prepared("fake-starter") });
  await box.destroy();
} finally {
  await sandbar.close();
}
```

The service URL must use HTTPS, except for loopback HTTP. The local example uses the operator session token returned by setup and scopes calls with the project ID. The remote SDK uses the same resource handles as direct mode, with **service-durable operation references**. See [self-hosting](/docs/self-hosting/operations/) for configuration and custody requirements.
