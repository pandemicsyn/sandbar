---
title: Sandbar documentation
description: Development documentation for Sandbar's direct TypeScript SDK and self-hosted service.
---

Sandbar is a provider-neutral sandbox API. This documentation describes the current **unpublished development build at `c4dea72`**. Its independent fake provider is the only qualified driver. It simulates results and **does not isolate or execute host processes**.

Choose a starting point:

- [Direct TypeScript quickstart](/docs/direct-quickstart/) for a server-side SDK in your Node.js or Bun process.
- [Service quickstart](/docs/service-quickstart/) for the Bun/Hono API, management UI and remote SDK.
- [Support matrix](/docs/providers/support/) before planning a deployment.

No public package install command works yet. Clone this repository and use its local workspace packages. Rust and Python SDKs, real provider adapters, snapshots, storage mounts and accounting are planned, not part of this build.
