---
title: Contributing an adapter
description: Authoring and conformance for provider integrations.
---

Use `defineAdapter` from `sandbar-adapter` to describe a provider. The definition connects through `sandbar-sdk` using the public adapter contract. Implement only the operations the provider supports; the SDK handles resource references, validation, polling and public errors. Start with the [adapter authoring guide](/docs/guides/write-an-adapter/) and the [copyable Acme example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/acme-adapter.ts).

Use `adapterSuite` from `sandbar-adapter/testing` with a deterministic provider fixture. Include loss after effect, scope changes, binary output and recovery without another submission for every capability you claim. The fake provider is a simulation; it persists native effect evidence for these tests. Real-provider support requires separate native conformance evidence in the [support matrix](/docs/providers/support/).

## Choose a package shape

| Distribution     | Consumer import           | When to use it                                                                           |
| ---------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| Built-in         | `sandbar-sdk/<provider>`  | A maintained integration explicitly included in the SDK. Daytona and E2B use this shape. |
| Separate package | The author's package name | A provider integration distributed independently. It needs no SDK subpath.               |

Follow the repository's [add-provider workflow](https://github.com/pandemicsyn/sandbar/blob/main/.agents/skills/add-provider/SKILL.md) and [package conventions](https://github.com/pandemicsyn/sandbar/blob/main/specs/package-conventions.md). The [agent prompt](/docs/agents/build-a-provider/) provides a starting brief.

## Validate the integration

Run focused native-boundary tests, the conformance suite, package builds and type checks, and packed consumer tests. Packed checks must install the documented top-level packages and verify external TypeScript declarations and Node/Bun execution without workspace-only dependencies.

Live acceptance is separate. Follow the [qualification workflow](https://github.com/pandemicsyn/sandbar/blob/main/.agents/skills/qualify-provider/SKILL.md) for an explicitly authorized run with finite resource limits, durable ownership records, and confirmed cleanup. Update the reviewed provider JSON and regenerate the evidence page; never turn fixture coverage into a live pass.
