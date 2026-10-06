---
title: Write an adapter
description: Implement create and destroy, then add only the operations your provider can guarantee.
---

An adapter is a trusted installed package. It exports a `defineAdapter` value; importing the package does not register it globally. The host supplies configuration and credentials when connecting. `connect` verifies the native identity with a read-only call and returns its authenticated scope.

This complete fixture is [compiled and executed in the repository](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/acme.test.ts). `AcmeClient` is a deterministic stand-in for a native provider client; replace it with authenticated native calls that enforce the stated account, region, image, and network guarantees.

```ts
import { z } from "zod";
import { defineAdapter } from "sandbar-adapter";
import { AcmeClient } from "./acme-native.js";

export const acme = defineAdapter({
  name: "example.acme",
  config: z.strictObject({ region: z.string().min(1) }),
  credentials: z.strictObject({ token: z.string().min(1) }),
  async connect({ config, credentials, host }) {
    const client = new AcmeClient(credentials.token);
    host.onClose(() => client.close());
    const account = await client.whoami();
    return {
      scope: {
        authority: { kind: "account", id: account.id },
        partition: { region: config.region },
      },
      supports: { images: ["prepared"], network: ["blocked"] },
      async create(input, ctx) {
        const box = await client.spawn({
          account: account.id,
          imageId: input.image.value,
          region: config.region,
          blockAllEgress: true,
          public: false,
          requestId: ctx.submissionId,
        });
        return { id: box.id, state: box.ready ? ("running" as const) : ("unknown" as const) };
      },
      async destroy(box) {
        await client.deleteAndWait(box.id, account.id, config.region);
        return { computeStopped: true, retainedResources: [] };
      },
    };
  },
});
```

The complete [AcmeClient fixture](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/acme-native.ts) and [adapter source](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/acme-adapter.ts) are copyable files. A real provider integration must disable native retries for mutation calls. Sandbar supplies a stable submission ID but cannot infer native idempotency from a request field.

`create` and `destroy` are required for managed compute. Add `inspect`, `exec`, `files`, or `inventory` only when their native semantics satisfy the [capability checklist](/docs/guides/adapter-capabilities/). Unsupported calls fail locally. Add a read-only `observe` operation when the provider can find a prior attempt by stable identity; see [asynchronous recovery](/docs/guides/adapter-recovery/).

For finite input to ordinary `box.exec`, the adapter hook receives optional bounded `Uint8Array` bytes. Set `exec.finiteStdin: "bytes"` only when the adapter preserves those exact bytes and establishes guest EOF before reporting confirmed command success. Omitted input must also start closed. Without the marker, an explicit input request rejects as `UNSUPPORTED` before provider effects. The SDK enforces a 1 MiB limit and does not include the payload in recovery tokens or diagnostics. `processes.start` is a separate operation and does not accept this finite input.

Before distributing an adapter, run `adapterSuite` from `sandbar-adapter/testing` with a deterministic native-boundary fixture. Its report lists the scenarios actually run, including lost response, one native effect, scope separation, late response, and release behavior. Each provider fixture must independently prove that its upstream transport does not retry mutations.

For lifetime renewal, add the optional `renew` mutation and `renewCapabilities` read hook. `RenewInput` contains a verified sandbox reference and optional positive `forSeconds`; its read-only `prepare` resolves the connection default, validates native policy/state, and returns `ResolvedRenewInput` with a positive safe integer window. Round upward when necessary and reject unsupported upper bounds before dispatch. The SDK saves that resolved window in its existing recovery reference, so another connection cannot reinterpret it through different defaults. `renewCapabilities` describes resolved minimum/maximum/granularity and native clock scope; ordinary application calls do not select scopes.

One native dispatch returns `RenewResult` with the original sandbox reference, resolved `requested.forSeconds`, `acknowledged: true`, and a current observation or `null`. Save acknowledgement through the existing recovery token when supported, and retain confirmed success if an optional metadata read or compatibility save fails. Observe with current credentials and identity; a later deadline alone never certifies acceptance. A provider without a mapped hook remains usable and returns typed `UNSUPPORTED` before effects. See [configured renewal](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-renew.ts) and [recovery rules](/docs/guides/adapter-recovery/).
