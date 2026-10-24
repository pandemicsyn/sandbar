---
title: Write an adapter
description: Build a provider adapter that verifies identity, maps the shared setup options, implements create and destroy, and adds only the operations the provider can guarantee.
---

An adapter connects one provider's native API to Sandbar. Applications switch providers by changing only the adapter they connect with, so the adapter owns every provider mechanic: native clients, request encodings, helper commands, lifecycle orchestration and cleanup. Application code keeps the same small vocabulary whatever the provider.

Official adapters and third-party adapters use the same public API from `@sandbar-sdk/adapter`. An adapter is a trusted installed package. Importing it registers nothing and performs no provider IO; the host supplies configuration and credentials when it connects.

## Let your coding agent build it

The `add-provider` agent skill walks a coding agent through this whole guide: researching the native API, the shared setup options, create and destroy, uncertain outcomes, conformance tests, packaging and docs. Install it with the [`skills`](https://github.com/vercel-labs/skills) installer, which supports Claude Code, Codex, Cursor and other agents:

```sh
npx skills add pandemicsyn/sandbar --skill add-provider
```

Run it in the repository where the adapter will live, then ask your agent to add the provider. Add `-g` to install it for every project instead. For an agent without a skill system, paste the [provider integration prompt](/docs/agents/build-a-provider/).

## What you build

An adapter package provides:

- an adapter definition made with `defineAdapter`: a stable provider name, configuration and credential schemas, and a `connect` callback;
- a factory that binds settings for `Sandbar.connect`;
- deterministic tests at the native boundary, including the `adapterSuite` conformance scenarios;
- documentation of its defaults, guarantees and limitations.

## Start from the Acme example

This adapter is [compiled and tested in the repository](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/acme.test.ts). `AcmeClient` is a deterministic stand-in for a native client; replace it with authenticated native calls that enforce the account, region, image, size and network guarantees the adapter declares.

```ts
import { z } from "zod";
import {
  bindAdapter,
  defineAdapter,
  ResourceMinimums,
  smallestSize,
  type SandboxResources,
} from "@sandbar-sdk/adapter";
import { AcmeClient } from "./acme-native";

/** Acme sizes, smallest first. */
const SIZES = [
  { type: "small", vcpus: 1, memoryMiB: 2048 },
  { type: "medium", vcpus: 2, memoryMiB: 4096 },
  { type: "large", vcpus: 4, memoryMiB: 8192 },
] as const;

const Config = z.strictObject({
  region: z.string().min(1),
  /** Default image for creates that name none. */
  image: z.string().min(1).default("image-123"),
  /** Minimum size; the smallest Acme size that meets it is used. */
  resources: ResourceMinimums.optional(),
});

const Credentials = z.strictObject({ token: z.string().min(1) });

export const acmeAdapter = defineAdapter({
  name: "example.acme",
  displayName: "Acme fixture",
  config: Config,
  credentials: Credentials,
  async connect({ config, credentials, host }) {
    // Unmet minimums reject before any provider IO.
    const size = smallestSize("Acme", SIZES, config.resources ?? {});
    const client = new AcmeClient(credentials.token);
    host.onClose(() => client.close());
    const account = await client.whoami();

    const resources = (type: string): SandboxResources | undefined => {
      const match = SIZES.find((value) => value.type === type);

      return match && { vcpus: match.vcpus, memoryMiB: match.memoryMiB };
    };

    return {
      scope: {
        authority: { kind: "account", id: account.id },
        partition: { region: config.region },
      },
      defaultImage: { kind: "prepared", value: config.image },
      defaultNetworkPolicy: "blocked",
      supports: { images: ["prepared"], network: ["blocked"] },
      async create(input, ctx) {
        const box = await client.spawn({
          account: account.id,
          imageId: input.image.value,
          region: config.region,
          size: size.type,
          blockAllEgress: true,
          public: false,
          requestId: ctx.submissionId,
        });

        return { id: box.id, state: box.ready ? ("running" as const) : ("unknown" as const) };
      },
      async inspect(box) {
        const native = await client.get(box.id, account.id, config.region);

        if (!native) return null;
        const value = resources(native.size);

        return {
          id: native.id,
          state: native.running ? ("running" as const) : ("destroyed" as const),
          resources: value
            ? { status: "known" as const, value }
            : { status: "unknown" as const, reason: "Acme reported an unlisted size" },
        };
      },
      async destroy(box) {
        await client.deleteAndWait(box.id, account.id, config.region);

        return { computeStopped: true, retainedResources: [] };
      },
    };
  },
});

export type AcmeOptions = z.input<typeof Config> & z.input<typeof Credentials>;

/** Packages settings for `Sandbar.connect`; performs no provider IO. */
export function acme({ token, ...config }: AcmeOptions) {
  return bindAdapter(acmeAdapter, config, { token });
}
```

Applications then connect with the factory and use the ordinary SDK:

```ts
import { Sandbar } from "sandbar-sdk";
import { acme } from "@acme/sandbar-adapter";

const sandbar = await Sandbar.connect(
  acme({ token: process.env.ACME_TOKEN!, region: "us", resources: { memoryMiB: 4096 } }),
);
```

The [adapter source](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/acme-adapter.ts) and [AcmeClient fixture](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/acme-native.ts) are copyable files. The [Boat adapter](https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/boat/src/adapter.ts) is a complete recent example around a real native SDK.

## Connect and verify the account

`connect` turns validated configuration and credentials into a session:

- Keep secrets in the credentials schema and ordinary choices in the configuration schema. Credentials never appear in the scope, recovery tokens, errors or logs; redact them from native error text you surface.
- Reject invalid setup before provider IO. For example, `smallestSize` throws `UNSUPPORTED` when no native size meets the requested minimums.
- Create the native client and register its cleanup with `host.onClose` before any call that can fail. Closing a connection releases local clients; it never destroys remote compute.
- Verify the account, organization or project with an authenticated read-only call. A caller-supplied account string alone is not verification.
- Return a `scope` with that verified `authority` and every routing `partition` that changes resource identity, such as a region or endpoint. Check it on every later read and mutation.

## Use the shared setup options

Applications choose provider behavior in adapter setup, not in each call. Use these names wherever the provider has the matching choice, so that switching providers keeps the same setup vocabulary:

| Setup key                   | Meaning                                     | How the adapter applies it                                                                                                      |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `image`                     | Default image for creates that name none    | Return it as `defaultImage`. Check that it exists in the verified scope.                                                        |
| `network`                   | `"blocked"` or `"internet"` outbound access | Return it as `defaultNetworkPolicy`; list every policy you enforce in `supports.network`. Default to `"blocked"` when possible. |
| `resources`                 | Minimum `{ vcpus, memoryMiB }`              | Pick the smallest native size that meets every minimum with `smallestSize`; never round down. Report the size on `inspect`.     |
| `lifecycle.lifetimeSeconds` | How long a sandbox may live before it stops | Default to 900 seconds, clamped to the provider's range. `renew` extends it where supported.                                    |
| `lifecycle.idleSeconds`     | Stop after this long without activity       | Map it only when the provider has a native idle stop.                                                                           |
| `preview`                   | `{ access, ports }` for preview URLs        | `access` is `"protected"` or `"public"`; return `headers` for protected URLs. Reject an access mode the provider cannot give.   |

Some older adapters still accept earlier native names for these settings as deprecated aliases; new adapters start with the shared names. A few rules keep these options honest:

- Advertise `"blocked"` only when the native policy actually blocks egress, including account-tier exceptions. When a provider cannot block egress at all, require `network: "internet"` in setup instead of defaulting to it silently, as the boxd and Boat adapters do. Do not label peer or metadata isolation as blocked egress.
- Use one size vocabulary. Do not add native size keys or small/medium/large presets; numbers express sizes for every provider. If an existing adapter had a native size key, keep it as a deprecated alias for one minor release and reject setups that supply both.
- Keep deprecated native network names working through `networkPolicyAliases`, which maps them to a portable name before the SDK checks support.
- A caller's `create()` override always wins over the setup default. Reject an unsupported override before allocating anything; never fall back to another image or policy.
- Add provider-specific keys only for real choices that the shared options cannot express, such as Daytona's `target` or Boat's `environment`.

## Implement create and destroy

`create` and `destroy` are required for managed compute.

`create` makes exactly one native submission. Pass `ctx.submissionId` to the provider for correlation, but do not assume a request ID makes the call idempotent unless the provider documents that. Disable the native client's hidden retries for mutations, and prove it at the transport boundary. Reject inputs the provider cannot honor before dispatch: an image kind, network policy, region, labels, mounts or snapshot requirements it does not support. Return `state: "running"` only after the provider confirms readiness, otherwise `"unknown"`.

Set `supports.createEnv: true` only when `CreateInput.env` becomes native sandbox state that every command, process and terminal sees, including after `reopen` in another process, with a per-call `env` overriding a name. Without the marker the SDK rejects `env` with `UNSUPPORTED` before any effect. Values may be secrets: keep them out of recovery tokens, outcomes and messages.

`destroy` reports `computeStopped: true` only after the provider confirms termination, and lists anything that remains in `retainedResources`.

Plain async methods, as in the Acme example, suit calls that either complete or fail definitively. When a call can be lost after it reaches the provider, or the provider works asynchronously, use the `{ prepare, submit, observe }` form instead. `prepare` is read-only validation, `submit` dispatches once, and `observe` reads evidence without ever submitting again. A timeout after dispatch is an unknown outcome, not a failure. See [asynchronous recovery](/docs/guides/adapter-recovery/) and the [tested async example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/async-adapter.ts).

To let applications reopen a sandbox from another process, return a `reference` built with `sandboxReference(provider, scope, nativeId, { operation, submission })` from create, and implement `reopen`, which verifies the reference against the current scope with `assertResourceScope` before reading native state.

## Add operations the provider supports

Add an operation only when the native semantics satisfy the [capability checklist](/docs/guides/adapter-capabilities/). Anything you leave out fails locally with `UNSUPPORTED` before provider effects, which is better than an operation that weakens a guarantee.

| Hook                                           | Backs                                    | Add it when                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect`                                      | `box.inspect()`                          | The provider reports sandbox state. Report expiry, idle stop and size facts you know; start from `unknownSandboxFacts()` for the rest.                                                                                                                                                      |
| `reopen`                                       | `sandboxes.get(reference)`               | Create returns a reference and the provider can look the sandbox up again with current credentials.                                                                                                                                                                                         |
| `exec`                                         | `box.exec()`                             | Commands run with `argv` and/or `shell` preserved exactly, with binary output bounded by `supports.exec.maxOutputBytes`.                                                                                                                                                                    |
| `processes`                                    | `box.processes`                          | The provider can run long-lived or interactive processes. Declare each behavior in `processes.supports`.                                                                                                                                                                                    |
| `files`                                        | `box.files`                              | Reads and writes preserve bytes within `files.maxBytes`. Declare `fileWrite.noClobber` only with native atomic creation.                                                                                                                                                                    |
| `preview`                                      | `box.preview(port)`                      | The provider exposes HTTPS URLs for guest ports. Return `headers` for protected access.                                                                                                                                                                                                     |
| `inventory`, `sandboxList`                     | `sandboxes.list()`                       | The provider lists sandboxes with verifiable ownership. Return references that `reopen` accepts, or `reference: null`, plus the page's `coverage`. Add `labels` (create labels without your markers, via `listedLabels`) and `createdAt` (via `listedTime`) when the provider returns them. |
| `renew`, `suspend`, `resume`                   | `box.renew()`, `box.suspend()`, `resume` | The provider can extend, pause or resume a sandbox's lifetime. Add the matching capability read hooks.                                                                                                                                                                                      |
| `imageBuild`, `image*`, `snapshot*`, `volume*` | `images`, `snapshots`, `volumes`         | The provider can build images, capture state or manage volumes. See [snapshots and volumes](/docs/guides/snapshots-and-volumes/).                                                                                                                                                           |

A missing native endpoint does not automatically make an operation unsupported. Bridge the gap inside the adapter when you can faithfully meet the contract, for example by mapping argv to a shell-only transport or capturing output bytes in the guest before a text-only channel transforms them. The adapter owns any such helper; callers never install helpers or choose wire encodings.

### Command input and processes

For finite input to `box.exec`, the hook receives optional bounded `Uint8Array` bytes. Set `exec.finiteStdin: "bytes"` only when the adapter delivers those exact bytes and closes the guest's input before reporting success. Omitted input must also start closed. The SDK enforces a 1 MiB limit and keeps the payload out of recovery tokens and diagnostics.

For processes, implement the `NativeProcess` hooks and opt in to each behavior:

- `sustainedOutput: true` requires bounded output that outlives the start call, a separate `outputDone` promise, and detaching output without losing status, wait, input or control.
- `stdin: "bytes"` requires exact-byte writes and an explicit end of input. Do not decode arbitrary bytes for a text-only native endpoint.
- `status: true` supplies timestamped running, exited or unknown observations.
- `execCapture: "bytes"` adds bounded original-byte capture from the same process dispatch for `exec` callbacks.

### Lifetime renewal

`renew` is a mutation over `RenewInput`: a verified sandbox reference and an optional positive `forSeconds`. Its read-only `prepare` resolves the setup default, validates native policy and state, and returns a positive whole-second window, rounded up where needed. Reject windows above the provider maximum before dispatch. One native call returns `RenewResult` with the reference, the resolved `requested.forSeconds`, `acknowledged: true`, and a current observation or `null`. `renewCapabilities` reports the minimum, maximum and step, and whether the clock covers the sandbox or only the running session. A later deadline alone never proves the renewal was accepted. See the [renewal example](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-renew.ts).

## Test the adapter

Test against a deterministic native boundary: an injectable native client or transport that counts outbound requests, so tests exercise real request construction and response handling without a provider account.

Run `adapterSuite` from `@sandbar-sdk/adapter/testing` against that fixture. The fixture supplies two genuinely different verified scopes, effect and release counters, a way to lose or hold a create response after the native effect, and proof that the native transport makes one outbound attempt per mutation. The suite's report lists the scenarios it ran, such as lost response, single native effect, scope separation, late response and release behavior. It is not live certification.

Add focused tests for every operation you declare: unsupported inputs rejected before mutation, scope mismatches, a lost response after one native effect, observation without replay, argument and byte fidelity, declared bounds, and cleanup. Repository adapters keep these beside the source in `packages/providers/<provider>/src/*.test.ts`.

Live tests against a real account are separate and use paid resources, so run them only with the account owner's approval.

## Package and distribute it

Publish the adapter as its own package. Official integrations are named `@sandbar-sdk/<provider>`; third-party authors use their own names, such as `@acme/sandbar-adapter`. Never add an SDK subpath for a provider.

- Export the definition, a factory, and, where tests need it, a constructor that accepts an injected transport. The official adapters export `<provider>Adapter`, `create<Provider>Adapter(options)` and a `<provider>(options)` factory built with `bindAdapter`.
- Ship ESM with TypeScript declarations. Depend on `@sandbar-sdk/adapter`, your schema library and the native SDK at a pinned version. The adapter does not depend on `sandbar-sdk` at run time, and its declarations must not reference private workspace packages.
- Qualify the packed artifact in a clean consumer: strict NodeNext declarations, Node and Bun execution, and npm, pnpm and Bun installs. The repository's `bun run package:smoke` does this for official packages.

The [command line](/docs/cli/configuration/) loads any adapter through a profile's `module` and `export`, so a third-party package works there without changes. For an official adapter maintained in this repository, also:

- add the package to the `build:packages` and `check:built` chains in the root `package.json`, and to the fixed release group with a changeset;
- add a CLI descriptor to `packages/cli/src/providers.ts` naming the environment variables for its credentials and required configuration;
- add a provider profile for [live qualification](https://github.com/pandemicsyn/sandbar/blob/main/packages/sdk-qualification/provider-qualification/README.md) and a row to `providerStatus` in `packages/sdk-qualification/provider-qualification/support.ts`, which feeds [Provider support](/docs/providers/support/);
- have a maintainer publish a `0.0.0` placeholder and configure npm trusted publishing for the new package name before the first release, or the release cannot publish it.

## Document it

Every adapter gets a provider page that states its setup options and defaults, what it guarantees, what it does not support, and its image and network prerequisites. Mark an adapter experimental until it has passed live qualification, and keep fixture-tested, packed-tested and live-tested behavior distinct in the [provider support matrix](/docs/providers/support/). Contributors working in this repository can follow the [add-provider workflow](https://github.com/pandemicsyn/sandbar/blob/main/.agents/skills/add-provider/SKILL.md), and coding agents can start from the [provider integration prompt](/docs/agents/build-a-provider/).
