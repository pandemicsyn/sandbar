---
title: Contributing a provider driver
description: Driver boundaries and conformance expectations.
---

Provider drivers implement the `@sandbar/provider-spi` interface. Direct mode passes a verified native scope and driver in the caller process. Service mode holds provider credentials and translates persisted operations through the service runtime. Keep credential custody and SQL dependencies outside `@sandbar/core`.

Start with the [fake client and server](https://github.com/pandemicsyn/sandbar/tree/af06bb6/packages/providers/fake). It runs independently of the Sandbar service, persists a native effect ledger and exposes test-only scenarios for lost responses, delayed observation, definitive rejection and ambiguous submission. Do not treat it as a real isolation boundary.

A real adapter needs explicit evidence for image preparation, native idempotency, submission discovery, stable scope identity, command output, file transfer, termination and event ordering. If the provider cannot prove whether a submitted mutation took effect, return an unknown result; never replay it silently. Add conformance and recovery tests before claiming support in the [matrix](/docs/providers/support/). The [provider research](https://github.com/pandemicsyn/sandbar/blob/af06bb6/docs/provider-drivers.md) is design context, not qualification.
