---
title: Images and networking
description: Choose prepared images, build OCI images, and select explicit network policies.
---

## Start from a prepared image

`Image.prepared(value)` selects an existing provider image. It does not build or capture an image.

| Provider | Prepared image                            | Setup                                                                              |
| -------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| E2B      | `base`, or a ready owned template ID/name | `templateId` on the connection defaults to `base`; select your template there too. |
| Daytona  | Active Linux snapshot ID/name             | The snapshot must be available to the verified organization and target region.     |

Use prepared images for the [getting started workflow](/docs/direct-quickstart/). A Daytona snapshot used as a prepared image is not a Sandbar snapshot capture/restore API; that API does not exist yet.

## Build an OCI image

Both built-in adapters implement explicit OCI builds. These are separate provider operations that can incur build and storage charges; check the [live test coverage](/docs/providers/support/) before relying on them.

```ts
const built = await sandbar.images.build({ source: Image.oci("node:24") });
const box = await sandbar.sandboxes.create({
  environment: Image.prepared(built.prepared),
  networkPolicy: "blocked",
});
try {
  console.log((await box.exec(["node", "--version"])).stdoutText());
} finally {
  await box.destroy();
}
console.log(built.retainedResources);
```

This create policy fits an E2B connection. With a Daytona default-policy connection, use `daytona-default` instead. `images.submitBuild()` returns an operation handle when you need to save a reference before waiting.

The prepared result carries its provider and verified scope. A connection in another scope cannot use it. Public OCI references are supported; there is no shared private-registry credential input. Daytona rejects mutable `latest`, `lts`, and `stable` tags; use a fixed version tag or digest.

**Destroying a sandbox does not delete its built template or snapshot.** Inspect `retainedResources` and arrange provider-side cleanup for artifacts you own. A retained-resource record with unknown ownership does not grant deletion authority. Borrowed prepared images should never be deleted as sandbox cleanup.

## Select a network policy

| Provider | Policy              | Meaning                                                                                                               |
| -------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| E2B      | `blocked` (default) | Requests the provider's disabled-internet setting.                                                                    |
| E2B      | `internet`          | Requests internet access.                                                                                             |
| Daytona  | `daytona-default`   | Uses the provider's default restrictions, including essential-service access. Select on connection and create.        |
| Daytona  | `blocked` (default) | Requests strict block-all; creation requires successful organization eligibility verification. No automatic fallback. |

A requested policy and a measured network-isolation result are different facts. Prepared-image baseline tests do not probe egress. Consult the [test evidence](/docs/providers/live-qualification/) for any separately measured network behavior.

Daytona does not expose an unrestricted `internet` policy through this adapter. E2B does not support region selection through the current adapter.
