---
name: add-provider
description: Add a sandbox provider to Sandbar as a built-in SDK subpath or a separately distributed adapter package. Covers the public adapter API, native guarantees, packaging, service registration and qualification.
---

# Add a Sandbar provider

Built-in and external providers implement the same public `sandbar-adapter` API. The difference is distribution and convenience wiring, not access to a privileged execution engine. Implement the requested provider and supported operations; adding one does not authorize other planned integrations or live provider usage.

Paths below are relative to the repository root unless linked. Use current exported types and tested examples as the implementation authority; do not copy historical SPI designs from archived specs.

## Choose the distribution

Read [package conventions](../../../specs/package-conventions.md) before choosing names or exports.

| | Built-in | External |
| --- | --- | --- |
| Consumer install | `sandbar-sdk` | `sandbar-sdk` plus the adapter package |
| Import | `sandbar-sdk/<provider>` | `sandbar-<provider>` for maintained integrations, or the author's own package name/scope |
| Implementation | Usually a private workspace in `packages/providers/<provider>` bundled into the SDK | A separately packed package in the requested repository/workspace |
| SDK change | Typed factory, explicit subpath, build and dependency wiring | None required; connect the exported definition through the public API |

Package names and the adapter's stable `name` are separate. Do not assume ownership of an npm name or scope. A planned provider in the conventions is not an implemented export. Do not add placeholder exports or publish packages as part of implementation.

## Establish the native boundary

If a provider research issue is supplied, read it and its relevant discussion first. Use its evidence, proposed defaults, implementation checklist and open questions as the brief; recheck version-sensitive claims against current native docs and Sandbar exports. Research does not establish implemented support or authorize paid tests. For missing or incomplete research, use [provider-research](../provider-research/SKILL.md) and the [issue template](../../../.github/ISSUE_TEMPLATE/provider-research.md) to resolve the gaps relevant to this implementation. Do not require a new issue for a small adapter fix or silently expand scope to every native capability.

Inspect the provider's current official API documentation and the exact native SDK version being used. Record evidence for the operations you plan to expose, especially authentication, identity, retry defaults, command execution, network policy and deletion confirmation. Pin a deliberate dependency version consistent with the repository.

Use a small injectable native client or transport so fixtures exercise real request construction and response handling. Verify outbound attempt counts at that boundary: a Sandbar callback invoked once does not prove the native SDK disabled retries. Disable hidden mutation retries, or leave the affected operation unsupported until a safe transport is available.

Read the [capability checklist](../../../apps/docs/src/content/docs/docs/guides/adapter-capabilities.md). Declare only guarantees enforced by the provider:

- Verify the account, organization or app with authenticated read-only IO in `connect`. Include all identity-relevant routing partitions in `scope`; a caller-supplied account string alone is not verification. Keep credentials out of scope, tokens, errors and logs.
- Check that images and resources belong to that scope. Advertise blocked egress only if the native policy actually provides it, including any account-tier restrictions or exceptions.
- Preserve argv as arguments, shell scripts as shell scripts, and file/output bytes without text conversion. Bound collected output and file reads. Advertise no-clobber writes only if native creation is atomic.
- Confirm compute termination before reporting `computeStopped: true`; report retained resources honestly. Register owned local-client cleanup with `host.onClose`. Closing a connection or aborting a wait is not destroying compute.

Do not turn an unsupported capability into an emulation layer, provider redesign or broader hardening project without a concrete task requirement.

### Snapshot defaults

When snapshot capture is in scope, follow the accepted direction in [provider state portability](../../../specs/provider-state-portability.md#2-snapshot-and-restore). The normal SDK call is `box.snapshot()` without required preservation or interruption options. The adapter supplies the simplest supported native capture workflow and owns its lifecycle orchestration. Current exports still determine what is implemented; this direction does not independently authorize adding snapshot support to an unrelated adapter task.

- Expose typed adapter configuration only for real choices. Daytona containers default to stop/capture/start for a previously running source, leave an already-stopped source stopped, and offer `restartAfterCapture: false`. E2B reusable capture includes memory and handles pause/resume natively; do not invent memory-exclusion or pause-permission settings.
- Advertise the configured default and actual capture/restore guarantees. Optional exact requirements validate that default before effects; they do not silently select different semantics. No snapshot capability means effect-free unsupported, before stopping compute. Do not add archive/export emulation or cross-provider fallback.
- Keep the configured source-restoration attempt after definitive capture failure. Preserve confirmed capture results and the retained snapshot identity if source restart fails; distinguish failed restart from uncertain restart. Identify the provider on the snapshot handle and its saved reference. Follow the [ordinary results and resource identity contract](../../../specs/sdk-recovery-dx.md); uncertain effects must not be replayed, and observation stays read-only. Preserve existing legacy continuation guards where supported, without requiring a new durable workflow for each adapter.
- Every provider page must document capture scope/exclusions, memory inclusion, source lifecycle and process/connection effects, restored execution, actual options/defaults, prerequisites, and partial-failure recovery/cleanup. Clearly distinguish planned, implemented, fixture-tested, and live-qualified behavior.
- Test no-argument defaults, actual option alternatives, strict rejection before effects, source restoration and failures, and uncertain dispatch without replay at the native boundary. Include saved exact identities, fresh connections/current credentials, partial restart failure and reopening after source deletion where supported. Preserve existing legacy recovery regressions; new callback/crash-checkpoint machinery is not a prerequisite. A provider-specific end-to-end requirement is not satisfied by implementing only capture or by skipping the live roundtrip as unsupported; see the spec's E2B build-selector and containing-template cleanup mapping. For new snapshot/volume guarantees, extend the existing live E2E harness and attestation reports using the [qualification workflow](../qualify-provider/SKILL.md); updating the harness is required, while paid runs still need explicit authorization.

## Implement the public definition

Start from the [adapter guide](../../../apps/docs/src/content/docs/docs/guides/write-an-adapter.md) and its compiled [minimal example](../../../apps/docs/examples/acme-adapter.ts). The public types live in `packages/adapter/src/index.ts`.

1. Export a `defineAdapter` definition with a stable provider `name`, configuration and credential schemas, and a `connect` callback. Separate secrets from ordinary configuration; host-controlled endpoint allowlists or policy must not become project-controlled inputs.
2. In `connect`, create the native client, register owned cleanup before fallible verification, verify scope, and return `scope`, `supports`, `create` and `destroy`. Add `inspect`, `exec`, `files` and `inventory` only as supported. Importing a definition or constructing a convenience factory must perform no provider IO.
3. Prefer plain async methods returning the documented plain result values. Use `{ prepare, submit, observe }` only when preflight or asynchronous recovery needs that split. `prepare` is read-only; resource creation and image-building effects belong in an explicitly supported mutation path.
4. Narrow discriminated command/image inputs before using provider-specific fields. Do not weaken public inference with broad casts or export private workspace types in declarations.

The existing `packages/providers/modal/src/adapter.ts` and `packages/providers/daytona/src/adapter.ts` demonstrate public definitions around native transports. Some existing internals use private driver types; a new adapter does not need to recreate those wrappers or depend on the private SPI.

### Uncertain outcomes and recovery

Read the [recovery guide](../../../apps/docs/src/content/docs/docs/guides/adapter-recovery.md) and [tested async example](../../../apps/docs/examples/async-adapter.ts) when the provider supports pending work or correlated discovery.

- Use supplied operation/submission identities for native correlation. Do not assume a request ID provides native idempotency without evidence.
- Return a normal value only for confirmed completion. Use `ctx.reject` only for a definitive rejection with no effect; a timeout or lost response after dispatch is unknown, not proof of failure.
- Return `ctx.pending(token, { pollAfterMs })` with a versioned recovery schema when there is a usable continuation token. Tokens must be bounded JSON without secrets, client objects or functions; use the current runtime's token limits.
- `observe` only reads evidence for the same verified scope and attempt. Validate native resource and operation correlation. It must never call `submit` or retry the mutation. No evidence means pending/unknown/null as appropriate, not fabricated success or certified rejection. Expose reconciliation only where native operation handles or reliable correlation actually support it. A saved request ID alone does not recover a missing resource ID; document supported discovery/inspection and unresolved uncertainty. Retain safety and serialization requirements on any existing continuation API.
- Resource references are minimal, versioned locators containing provider and exact native identity plus scope/routing needed for safe reopening with current credentials. Do not require provider-API-key HMACs, the original credential, process-local state or a hidden database. Keep result observations separate from identities; validate scope without treating a reference as authorization. Preserve necessary shipped formats and deletion checks when simplifying existing providers.
- Applications own persistence and recovery policy. New/expanded `onReference` hooks, dispatch-barrier storage, generic facts envelopes and continuation advice are deferred under the [September 30 DX direction](../../../specs/sdk-recovery-dx.md). Preserve confirmed results and known identities through errors; no summary-size budget may erase success. Existing compatibility paths must keep their safety guards. Explicit caller-requested deletion and incidental cleanup remain distinct; incidental cleanup requires correlated creation evidence.
- Honor callback signals and deadlines. The SDK bounds local preparation waiting, but observation/read deadlines require adapter cooperation. Do not claim transport or remote-compute cancellation just because the SDK stopped waiting.

Document operations whose uncertain outcomes cannot be reconciled. A new recovery-state framework or compatibility migration is not a prerequisite for every provider.

## Wire the chosen package

### Built-in SDK subpath

- Add the private provider workspace's source, tests, manifest and build/typecheck configuration. Use the public adapter API; keep provider-specific dependencies out of `sandbar-adapter`.
- Add `packages/sdk/src/<provider>.ts` with the typed, IO-free binding factory. Follow `packages/sdk/src/daytona.ts` and the existing SDK-local `bindAdapter` helper. The result must work with `await Sandbar.connect(provider(options))` through the common connection path.
- Update `packages/sdk/package.json` exports, build entrypoints and production dependency treatment. Add build ordering and lockfile changes actually needed. A native package left external by the bundler must be an installed production dependency, not merely a workspace/dev dependency.
- Keep the SDK root free of eager provider imports. Inspect emitted JS and declarations for private `@sandbar/*` leaks. Subpath isolation avoids loading unrelated providers; it does not promise their dependencies are absent from installation.
- If the task includes built-in service availability, add the definition to the existing registration in `apps/server/src/runtime.ts` and its required workspace/build dependencies. Preserve custom registration and avoid duplicate provider names. No second service execution engine or fixed HTTP provider enum is needed.

### External adapter package

- Export the adapter definition with ESM JS and corresponding TypeScript declarations. Declare `sandbar-adapter`, schema libraries and native libraries used by the installed artifact; use compatible public versions and avoid private workspace imports. The adapter implementation must not depend on the service or SQL. It normally needs the SDK only for consumer examples/tests.
- Do not add an SDK subpath or SDK-root import. Consumers use the existing public form:

  ```ts
  import { Sandbar } from "sandbar-sdk";
  import { acme } from "@acme/sandbar-adapter";

  const client = await Sandbar.connect({
    adapter: acme,
    config: { region: "us" },
    credentials: { token: process.env.ACME_TOKEN! },
  });
  ```

  This connection shape is exercised in [the Acme consumer test](../../../apps/docs/examples/acme.test.ts); replace its names and inputs with the real package schemas.
- Keep distribution metadata, dependency ranges, exports and packed files complete. If maintained in this monorepo, include the new package in the applicable release/version configuration; private built-in workspaces should not become separately published packages. Do not add a release system to an external repository unless requested.

### Optional service registration

External adapters are trusted installed code, registered explicitly via `createService({ storage, auth, adapters: [definition] })` from `sandbar-service`. Installation alone never registers one. See the [service guide](../../../apps/docs/internal/self-hosting/create-service.md).

The existing service catalog derives forms from the definition's schemas. Connection requests supply JSON configuration and credentials, then verify the connection. Use this path without adding provider-specific auth, SQL, UI forms or a parallel runner. For supported service usage, test the definition through the public SDK consumer boundary, including persisted reconnection and recovery.

## Qualify and document

Run `adapterSuite` from `sandbar-adapter/testing` against a deterministic native-boundary fixture. Follow `packages/adapter/src/testing.ts` for the fixture interface and `packages/providers/*/src/adapter.test.ts` for implementations. Supply genuinely different verified scopes, effect/release counters, lost-response and delayed-response faults, and evidence that native mutation retries are disabled. Report scenarios actually exercised; the suite is not live certification.

Add focused tests for supported operations: unsupported inputs before mutation, scope mismatch, loss after one native effect, observation without replay, binary/command fidelity, declared bounds and cleanup. If pending tokens are supported, reopen a connection and recover the saved reference. Include direct/service parity for integration paths in scope; avoid unrelated service hardening.

For distribution, extend or follow `packages/sdk-qualification/package-smoke.mjs`. Pack real artifacts into a clean consumer, install only documented top-level packages, compile strict NodeNext declarations, and run Node/Bun consumers. Include the new built-in subpath or external definition and check dependency isolation. Local archive overrides may resolve transitive packages but must not mask missing dependencies by installing extra roots. Exercise npm, pnpm and Bun installs when qualifying release/install support, and report unrun environments explicitly.

Use root build/typecheck, lint/format, package smoke and documentation scripts appropriate to the changed surfaces. Run shared builds sequentially. Update the provider support matrix, capability/credential/image instructions, examples and package docs; regenerate references through existing scripts when affected. Distinguish fixture-tested, packed-tested and live-tested behavior, unsupported operations and recovery limitations. Never run paid/live tests, publish or deploy without explicit authorization.
