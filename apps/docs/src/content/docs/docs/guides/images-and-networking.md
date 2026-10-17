---
title: Images and networking
description: Choose a sandbox environment, build reusable images, and configure networking.
---

Set the default environment and network policy in adapter setup. Your application can then use `sandbar.sandboxes.create()` without repeating those choices. See [Getting started](/docs/direct-quickstart/) for connection examples.

## Start from a prepared image

`Image.prepared(value)` selects an existing provider image. It does not build an image or capture a running sandbox.

| Provider       | Prepared image                            | Connection setup                                                                                          |
| -------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| E2B            | `base`, or a ready owned template ID/name | `templateId` defaults to `base`. Set it to use your own template.                                         |
| Daytona        | Active Linux snapshot ID/name             | Set `environment: Image.prepared("your-snapshot")`. It must be available in your organization and region. |
| Vercel Sandbox | `vercel/sandbox/node:24`                  | Used automatically. Other images and runtimes are unsupported.                                            |

Daytona calls its prepared images snapshots. Selecting one as an image is different from capturing a sandbox's current state. For capture and restore, use the [snapshot APIs](/docs/guides/snapshots-and-volumes/).

boxd starts directly from an OCI image instead of a prepared image. Set `image` in its adapter configuration, or omit it to use the authenticated cluster's default image. Starting from OCI does not create a separate Sandbar image-build artifact. See [boxd defaults](/docs/providers/boxd/#defaults-and-networking).

An explicit `environment` on `create()` overrides the connection default if the adapter supports it. An invalid override fails; Sandbar does not silently fall back to another image. Vercel accepts only its managed Node 24 environment.

## Build an OCI image

E2B and Daytona implement `images.build()` to turn an OCI image into a reusable prepared image. Builds are separate provider operations and may incur build and storage charges. boxd boots OCI images directly and does not implement this build API; Vercel supports neither custom OCI images nor builds. Check [tested provider support](/docs/providers/support/) for live coverage.

Start with an E2B or Daytona connection named `sandbar`:

```ts
import { Image } from "sandbar-sdk";

const built = await sandbar.images.build({ source: Image.oci("node:24") });
console.log(built.retainedResources);
const box = await sandbar.sandboxes.create({
  environment: Image.prepared(built.prepared),
});
try {
  console.log((await box.exec(["node", "--version"])).stdoutText());
} finally {
  await box.destroy();
}
```

Creation uses the connection's network policy. Close the connection in an outer `finally` after handling resources, as in [Getting started](/docs/direct-quickstart/). `images.submitBuild()` returns an operation handle if you need to save an operation reference and recover its result later.

Pass the full `built.prepared` value to `Image.prepared()`: it includes the provider and verified scope, so another account or scope cannot accidentally use it. Public OCI references are supported; the SDK has no shared private-registry credential option. Daytona requires a version tag or SHA-256 digest and rejects `latest`, `lts` and `stable`. Use a digest when you need an exact immutable image.

**Destroying a sandbox does not delete its built template or snapshot.** Keep `built.retainedResources` available and arrange separate provider-side cleanup for artifacts you own, including when sandbox creation fails. A record with unknown ownership does not prove that deletion is safe. Borrowed prepared images are never sandbox cleanup targets.

## Select a network policy

Configure `network` once in adapter setup. Every adapter uses the same names, so switching providers does not change application code:

| Provider       | `network`             | Meaning                                                                                                     |
| -------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| E2B            | `blocked` (default)   | Requests E2B's disabled-internet setting; measured strict outbound isolation has not passed.                |
| E2B            | `internet`            | Requests internet access.                                                                                   |
| Daytona        | `blocked` (default)   | Requests strict block-all. Creation requires verified organization eligibility, with no automatic fallback. |
| Daytona        | `internet`            | Unrestricted egress. Creation requires an organization without limited sandbox egress (Tier 3 and above).   |
| Daytona        | `daytona-default`     | Daytona-only setup value: keeps organization-managed restrictions, including essential-service access.      |
| boxd           | `internet` (required) | Allows internet access with native peer/metadata isolation. Strict blocked egress is unsupported.           |
| Vercel Sandbox | `blocked` (default)   | Requests native `deny-all`; network isolation has no recorded live acceptance.                              |
| Vercel Sandbox | `internet`            | Requests native `allow-all`.                                                                                |

```ts
// Only the adapter setup differs between providers.
const client = await Sandbar.connect(e2b({ apiKey, network: "internet" }));
const box = await client.sandboxes.create();
```

A requested policy is not proof of isolation. E2B's maintained test still connected by direct IPv4 TCP when `blocked` was requested, even though hostname resolution failed. Prepared-image baseline tests do not test outbound isolation. See [network test evidence](/docs/providers/live-qualification/) before relying on a policy to isolate untrusted code.

Daytona's `internet` never falls back to `daytona-default`: on a Tier 1 or Tier 2 organization it rejects before allocation, because Daytona's default firewall there only reaches essential services. Choose `daytona-default` in setup when that restricted egress is acceptable. boxd's peer/metadata isolation does not block outbound internet.

Omitted create and restore policies use the connection default, so most applications never pass `network` per call. An explicit `create({ network })` or `restore({ network })` must be supported by that connection: E2B accepts `blocked` or `internet`, while Daytona and Vercel require a match with the configured policy. boxd accepts only `internet`. Empty or null policies reject rather than selecting a fallback. `client.capabilities().network` lists what the connection accepts.

The option was previously named `networkPolicy`, and Vercel used `vercel-deny-all` and `vercel-allow-all`. Those spellings still work and are deprecated; passing both `network` and `networkPolicy` with different values rejects.

`snapshot.restore()` uses the current connection's policy, not the captured sandbox's networking. Saved operations keep the policy resolved at submission when you recover them. Outbound policies do not open a public preview URL; see [Preview access](/docs/guides/preview-access/).
