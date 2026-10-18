---
name: add-provider
description: Add a sandbox provider to Sandbar as a separately distributed official or third-party adapter package. Covers the public adapter API, native guarantees, packaging and qualification.
---

# Add a Sandbar provider

Official and third-party providers implement the same public `@sandbar-sdk/adapter` API. Official integrations are separately installed `@sandbar-sdk/<provider>` packages maintained in this monorepo. Separate distribution does not imply experimental support. Implement only the requested provider and operations; paid usage requires explicit authorization.

Read [package conventions](../../../specs/package-conventions.md) before choosing names and exports. Custom authors may use their own names/scopes. Provider package names and stable adapter IDs are independent. Do not add SDK provider subpaths or placeholder exports.

## Establish the native boundary

If a provider research issue is supplied, read it and its relevant discussion first. Use its evidence, proposed defaults, implementation checklist and open questions as the brief; recheck version-sensitive claims against current native docs and Sandbar exports. Research does not establish implemented support or authorize paid tests. For missing or incomplete research, use [provider-research](../provider-research/SKILL.md) and the [issue template](../../../.github/ISSUE_TEMPLATE/provider-research.md) to resolve the gaps relevant to this implementation. Do not require a new issue for a small adapter fix or silently expand scope to every native capability.

Inspect the provider's current official API documentation and the exact native SDK version being used. Record evidence for the operations you plan to expose, especially authentication, identity, retry defaults, command execution, network policy and deletion confirmation. Pin a deliberate dependency version consistent with the repository.

Use a small injectable native client or transport so fixtures exercise real request construction and response handling. Verify outbound attempt counts at that boundary: a Sandbar callback invoked once does not prove the native SDK disabled retries. Disable hidden mutation retries, or leave the affected operation unsupported until a safe transport is available.

Read the [capability checklist](../../../apps/docs/src/content/docs/docs/guides/adapter-capabilities.md). Declare only guarantees that the adapter and provider together enforce:

- Verify the account, organization or app with authenticated read-only IO in `connect`. Include all identity-relevant routing partitions in `scope`; a caller-supplied account string alone is not verification. Keep credentials out of scope, tokens, errors and logs.
- Check that images and resources belong to that scope. Advertise blocked egress only if the native policy actually provides it, including any account-tier restrictions or exceptions.
- Preserve argv as arguments, shell scripts as shell scripts, and file/output bytes without text conversion. Bound collected output and file reads. Advertise no-clobber writes only if native creation is atomic.
- Confirm compute termination before reporting `computeStopped: true`; report retained resources honestly. Register owned local-client cleanup with `host.onClose`. Closing a connection or aborting a wait is not destroying compute.

### Bridge native differences inside the adapter

A missing native endpoint is not automatically an unsupported SDK operation. For an in-scope operation, use a small adapter-owned helper, encoding/transport mapping or lifecycle orchestration when it faithfully implements the existing contract. Examples include safely mapping argv to a shell-only transport, capturing stdout/stderr bytes in the guest before a text-only log channel transforms them, and orchestrating stop/capture/start. Prefer a suitable native channel when available; do not prescribe one helper design for every provider.

Keep these mechanics behind the SDK API. The adapter owns helper setup and cleanup; callers should not install helpers or configure wire encodings. Document meaningful image/runtime prerequisites, lifecycle effects and limitations. Guest output and command arguments remain untrusted data: do not confuse user output with helper control records or interpolate arguments unsafely.

Prove the resulting guarantees at the native boundary, including byte/argument fidelity, bounded collection and draining, exit evidence, partial or malformed receipts, cancellation and cleanup. Re-encoding already-decoded text cannot recover original bytes. Preserve confirmed outcomes and available output when later retrieval fails; never replay a command to recover its output.

Test an uncertain mechanism early with a focused fixture or experiment, then continue the implementation when the contract is established. Paid experiments still require explicit authorization. Missing evidence is an actionable investigation, not a claim of support or impossibility. Report unsupported when the operation cannot reliably meet the contract, and escalate a specific contract conflict rather than silently dropping an essential workflow.

This does not authorize a new storage system, archive-based snapshot emulation, cross-provider fallback, provider redesign or broader hardening project. Those require a separately scoped task; ordinary adapter implementation techniques do not.

### Snapshot defaults

When snapshot capture is in scope, follow the accepted direction in [provider state portability](../../../specs/provider-state-portability.md#2-snapshot-and-restore). The normal SDK call is `box.snapshot()` without required preservation or interruption options. The adapter supplies the simplest supported native capture workflow and owns its lifecycle orchestration. Current exports still determine what is implemented; this direction does not independently authorize adding snapshot support to an unrelated adapter task.

- Expose typed adapter configuration only for real choices. Daytona containers default to stop/capture/start for a previously running source, leave an already-stopped source stopped, and offer `restartAfterCapture: false`. E2B reusable capture includes memory and handles pause/resume natively; do not invent memory-exclusion or pause-permission settings.
- Advertise the configured default and actual capture/restore guarantees. Optional exact requirements validate that default before effects; they do not silently select different semantics. No snapshot capability means effect-free unsupported, before stopping compute. Do not add archive/export emulation or cross-provider fallback.
- Keep the configured source-restoration attempt after definitive capture failure. Preserve confirmed capture results and the retained snapshot identity if source restart fails; distinguish failed restart from uncertain restart. Identify the provider on the snapshot handle and its saved reference. Follow the [ordinary results and resource identity contract](../../../specs/sdk-recovery-dx.md); uncertain effects must not be replayed, and observation stays read-only. Preserve existing legacy continuation guards where supported, without requiring a new durable workflow for each adapter.
- Every provider page must document capture scope/exclusions, memory inclusion, source lifecycle and process/connection effects, restored execution, actual options/defaults, prerequisites, and partial-failure recovery/cleanup. Clearly distinguish planned, implemented, fixture-tested, and live-qualified behavior.
- Test no-argument defaults, actual option alternatives, strict rejection before effects, source restoration and failures, and uncertain dispatch without replay at the native boundary. Include saved exact identities, fresh connections/current credentials, partial restart failure and reopening after source deletion where supported. Preserve existing legacy recovery regressions; new callback/crash-checkpoint machinery is not a prerequisite. A provider-specific end-to-end requirement is not satisfied by implementing only capture or by skipping the live roundtrip as unsupported; see the spec's E2B build-selector and containing-template cleanup mapping. For new snapshot/volume guarantees, extend the ordinary Bun SDK integration tests and standard runner evidence using the [qualification workflow](../qualify-provider/SKILL.md); updating the relevant integration tests is required, while paid runs still need explicit authorization.

## Implement the public definition

Start from the [adapter guide](../../../apps/docs/src/content/docs/docs/guides/write-an-adapter.md) and its compiled [minimal example](../../../apps/docs/examples/acme-adapter.ts). The public types live in `packages/adapter/src/index.ts`.

1. Export a `defineAdapter` definition with a stable provider `name`, configuration and credential schemas, and a `connect` callback. Separate secrets from ordinary configuration; host-controlled endpoint allowlists or policy must not become project-controlled inputs.
2. In `connect`, create the native client, register owned cleanup before fallible verification, verify scope, and return `scope`, `supports`, `create` and `destroy`. Add `inspect`, `exec`, `files`, `inventory` and `sandboxList` only as supported; listed references must be ones `reopen` accepts, built only from native evidence. Importing a definition or constructing a convenience factory must perform no provider IO.
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

### Separately installed adapter package

- Export the adapter definition with ESM JS and corresponding TypeScript declarations. Declare `@sandbar-sdk/adapter`, schema libraries and native libraries used by the installed artifact; use compatible public versions and avoid private workspace imports. The adapter implementation must not depend on SQL. It normally needs the SDK only for consumer examples/tests.
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
- Keep distribution metadata, dependency ranges, exports and packed files complete. If maintained in this monorepo, include the new package in the applicable release/version configuration; official integrations belong in the coordinated fixed release group; preserve experimental packages’ existing status. Do not add a release system to an external repository unless requested.

## Qualify and document

Supply a small provider profile (`packages/sdk-qualification/provider-qualification/profile.ts`): public connection factory, pinned dependencies, nonsecret persisted routing, credential requirements, finite native/exercise/cleanup bounds, declared feature support and concise caveats. Reuse the normal `bun:test` suites in `packages/sdk-qualification/live`; add genuinely new SDK workflows as ordinary assertions rather than a provider-specific script or custom runner. Read the operator README and [qualification skill](../qualify-provider/SKILL.md). Bun owns selection, timeout/failure reporting and JUnit; shared helpers own setup, durable test-resource custody and bounded cleanup. Branch and merged sources use the same preload/build and invocation. Keep volume CRUD separate from mounts, account eligibility separate from implementation support, and extensive faults offline. Generate support pages from declared metadata and a thin mapping of reviewed JUnit/provenance/cleanup context. Never invent current-head live evidence or request paid reruns merely for an unchanged merge.


Run `adapterSuite` from `@sandbar-sdk/adapter/testing` against a deterministic native-boundary fixture. Follow `packages/adapter/src/testing.ts` for the fixture interface and `packages/providers/*/src/adapter.test.ts` for implementations. Supply genuinely different verified scopes, effect/release counters, lost-response and delayed-response faults, and evidence that native mutation retries are disabled. Report scenarios actually exercised; the suite is not live certification.

Add focused tests for supported operations: unsupported inputs before mutation, scope mismatch, loss after one native effect, observation without replay, binary/command fidelity, declared bounds and cleanup. If pending tokens are supported, reopen a connection and recover the saved reference.

For distribution, extend or follow `packages/sdk-qualification/package-smoke.mjs`. Pack real artifacts into a clean consumer, install only documented top-level packages, compile strict NodeNext declarations, and run Node/Bun consumers. Include the new public factory or definition and check dependency isolation. Local archive overrides may resolve transitive packages but must not mask missing dependencies by installing extra roots. Exercise npm, pnpm and Bun installs when qualifying release/install support, and report unrun environments explicitly.

Use root build/typecheck, lint/format, package smoke and documentation scripts appropriate to the changed surfaces. Run shared builds sequentially. Update the provider support matrix, capability/credential/image instructions, examples and package docs; regenerate references through existing scripts when affected. Distinguish fixture-tested, packed-tested and live-tested behavior, unsupported operations and recovery limitations. Never run paid/live tests, publish or deploy without explicit authorization.
