---
title: Build a provider integration
description: A copyable prompt to get your coding agent implementing a Sandbar provider adapter.
---

An adapter connects a provider's native API to Sandbar. Replace the bracketed fields and copy this prompt into an agent with access to the integration repository.

```text wrap title="Provider integration prompt"
Implement a Sandbar adapter for [provider] in [repository or package].
The requested operations are [create, destroy, inspect, exec, files, etc.].
Distribution: [a separate adapter package or a built-in SDK subpath].

Read the current Sandbar authoring docs and tested examples:
- https://sandbarsdk.dev/docs/guides/write-an-adapter/
- https://sandbarsdk.dev/docs/guides/adapter-capabilities/
- https://sandbarsdk.dev/docs/guides/adapter-recovery/
- https://sandbarsdk.dev/docs/contributing/drivers/
- https://github.com/pandemicsyn/sandbar/tree/main/apps/docs/examples

If working in the Sandbar repository, follow AGENTS.md and the
.agents/skills/add-provider/SKILL.md workflow. Use current exported types
and tests as the implementation authority, not archived proposals.

Inspect the provider's official API documentation and the exact native
SDK version. Implement defineAdapter from "sandbar-adapter". Keep the
adapter independent of Sandbar internals. Separate configuration from
credentials, verify native identity with authenticated read-only IO,
and include identity-relevant routing partitions in the returned scope.

Implement create and destroy, then add only capabilities backed by native
guarantees. Disable hidden mutation retries. Preserve argv, binary bytes,
output bounds, and atomic no-clobber semantics where advertised. Confirm
compute termination before reporting success. Release owned clients on
close without implying that close destroys compute.

For asynchronous work, use read-only prepare, one submit, and read-only
observe with versioned recovery tokens. A lost response is not proof of
failure. Recovery must never replay a mutation. Keep secrets and native
logs out of public errors, tokens, and committed evidence.

Build an injectable native boundary and deterministic tests. Run
adapterSuite from "sandbar-adapter/testing" and verify actual outbound
attempt counts, scope separation, binary fidelity, uncertain outcomes,
cleanup, and supported recovery. Qualify packed artifacts with an external
TypeScript consumer and the supported runtimes.

Document configuration, credentials, image/network requirements,
capabilities, and limitations. Distinguish fixture tests, package tests,
and live evidence in the provider support matrix. Get explicit approval
for a bounded live test and owned-resource cleanup before using paid
resources. Do not publish the package without authorization.

Finish with the implementation, usage example, validation results,
and a precise list of unsupported or untested behavior.
```

For a separately distributed adapter, consumers install its package alongside `sandbar-sdk` and pass the exported definition to `Sandbar.connect({ adapter, config, credentials })`. Built-in adapters use the same public contract with an SDK convenience import.
