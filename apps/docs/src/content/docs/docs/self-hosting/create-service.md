---
title: Register adapters in a service
summary: Run the optional standalone Bun service with trusted installed adapter packages.
---

The SDK works on its own. Install `@sandbar/service` only when you need shared credential custody, project authentication, durable operation tracking, HTTP access, and the management UI. This package requires Bun and SQLite or MySQL. It consumes the public `sandbar-sdk` adapter lifecycle; adapter packages never depend on the service.

```ts
import { createService } from "@sandbar/service";
import { acme } from "@acme/sandbar-adapter";

const service = await createService({
  storage: { url: process.env.SANDBAR_DB_URL!, keyFile: process.env.SANDBAR_KEY_FILE! },
  auth: { setupTokenFile: process.env.SANDBAR_SETUP_TOKEN_FILE! },
  adapters: [acme],
});
await service.listen({ port: 3000 });
```

The service operator installs trusted code and registers definitions at startup. A project creates a provider connection with structured `configuration` and write-only `credentials`, then verifies it before admitting work. The authenticated `GET /v1/providers` catalog supplies form schemas without contacting providers. `withPolicy` on an adapter definition lets the operator fix host-owned policy; project connection input cannot set it.

Credentials and configuration are validated, encrypted, and bound to a verified native scope. Existing operations are observed after restart without resubmitting native effects. A missing registration stops new provider-dependent admission. The [packed service consumer](https://github.com/pandemicsyn/sandbar/blob/main/packages/sdk-qualification/package-smoke.mjs) installs service, SDK, and an external adapter tarball, then exercises HTTP submission and observation-only restart recovery.

These packages are not yet published. The source checkout builds local tarballs for qualification; it does not deploy or make live provider calls. See [Service operations](/docs/self-hosting/operations/) for key files, database ownership, and recovery behavior.
