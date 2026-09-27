---
title: Sandbar documentation
description: Development documentation for Sandbar's direct TypeScript SDK and self-hosted service.
---

Sandbar is a server-side sandbox SDK with first-class custom adapters. The service is an optional standalone package. This documentation describes an **unpublished development build**. Its independent fake provider is qualified for local simulation; it **does not isolate or execute host processes**. The fake, Daytona and Modal adapters have deterministic fixture coverage for direct and service use, but has not passed live provider conformance.

Choose a starting point:

- [Direct TypeScript quickstart](/docs/direct-quickstart/) for a server-side SDK in your Node.js or Bun process.
- [Service quickstart](/docs/service-quickstart/) for the Bun/Hono API, management UI and remote SDK.
- [Support matrix](/docs/providers/support/) before planning a deployment.

No public package install command works yet. Clone this repository and use its local workspace packages. Rust and Python SDKs, additional provider adapters, storage mounts and accounting are planned, not part of this build.
