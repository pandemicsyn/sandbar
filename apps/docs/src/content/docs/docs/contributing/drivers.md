---
title: Contributing an adapter
description: Authoring and conformance for provider integrations.
---

Use `defineAdapter` from `sandbar-adapter` to describe a provider. The same definition connects through `sandbar-sdk` and can be registered with the optional service. Implement only the operations the provider supports; the SDK handles resource references, validation, polling and public errors. Start with the [adapter authoring guide](/docs/guides/write-an-adapter/) and the [copyable Acme example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/acme-adapter.ts).

Use `adapterSuite` from `sandbar-adapter/testing` with a deterministic provider fixture. Include loss after effect, scope changes, binary output and recovery without another submission for every capability you claim. The fake provider is a simulation; it persists native effect evidence for these tests. Real-provider support requires separate native conformance evidence in the [support matrix](/docs/providers/support/).
