---
name: add-provider
description: Write a Sandbar adapter that connects a sandbox provider to the Sandbar TypeScript SDK with defineAdapter from @sandbar-sdk/adapter, as an official @sandbar-sdk/<provider> package or a third-party one. Covers native guarantees, shared setup options, testing, packaging and docs.
---

# Add a Sandbar provider

An adapter connects one provider's native API to Sandbar. Applications switch providers by changing only adapter setup, so the adapter owns every provider mechanic (native clients, encodings, helper commands, lifecycle orchestration, cleanup) and application code never sees them. Prefer this experience over exact parity with the native API.

Official and third-party adapters implement the same public `@sandbar-sdk/adapter` API. Official integrations are separately installed `@sandbar-sdk/<provider>` packages maintained in the Sandbar monorepo; separate distribution does not imply experimental support. Third-party authors use their own package names, such as `@acme/sandbar-adapter`. Never add an SDK subpath for a provider.

Implement only the requested provider and operations. Live provider calls, paid resources, publishing and deployment need explicit authorization from the account owner.

References (links work wherever this skill is installed):

- Guide: https://sandbarsdk.dev/docs/guides/write-an-adapter/
- Capability checklist: https://sandbarsdk.dev/docs/guides/adapter-capabilities/
- Recovery rules: https://sandbarsdk.dev/docs/guides/adapter-recovery/
- Tested minimal adapter: https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/acme-adapter.ts and its test `acme.test.ts`
- Tested async adapter: https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/async-adapter.ts
- A complete recent adapter: https://github.com/pandemicsyn/sandbar/blob/main/packages/providers/boat/src/adapter.ts
- Public types: https://github.com/pandemicsyn/sandbar/blob/main/packages/adapter/src/index.ts

Inside the Sandbar repository, also follow `AGENTS.md` and [package conventions](https://github.com/pandemicsyn/sandbar/blob/main/specs/package-conventions.md).

## Establish the native boundary

If a provider research issue is supplied, read it and its discussion first, and use its evidence, proposed defaults, checklist and open questions as the brief. Research issues can be stale: recheck version-sensitive claims against the provider's current docs and SDK, and against current Sandbar exports. Research does not establish implemented support or authorize paid tests. For missing research, use the [provider-research skill](https://github.com/pandemicsyn/sandbar/blob/main/.agents/skills/provider-research/SKILL.md) for the gaps relevant to this implementation; a small adapter fix needs no new issue.

Inspect the provider's current API docs and the exact native SDK version. Record evidence for the operations you expose, especially authentication, identity, retry defaults, command execution, network policy and deletion confirmation. Pin a deliberate dependency version.

Use a small injectable native client or transport so fixtures exercise real request construction and response handling. Count outbound attempts at that boundary: a Sandbar callback invoked once does not prove the native SDK disabled retries. Disable hidden mutation retries, or leave the operation unsupported until a safe transport exists.

Declare only guarantees the adapter and provider together enforce:

- Verify the account, organization or project with authenticated read-only IO in `connect`. Put every identity-relevant routing partition (region, endpoint) in `scope`; a caller-supplied account string alone is not verification. Keep credentials out of scope, tokens, errors and logs.
- Check that images and resources belong to that scope. Advertise blocked egress only if the native policy actually provides it, including account-tier exceptions.
- Preserve argv as arguments, shell scripts as shell scripts, and file/output bytes without text conversion. Bound collected output and file reads. Advertise no-clobber writes only with atomic native creation.
- Confirm compute termination before reporting `computeStopped: true`; report retained resources honestly. Register owned client cleanup with `host.onClose`. Closing a connection or aborting a wait is not destroying compute.

### Bridge native differences inside the adapter

A missing native endpoint is not automatically an unsupported SDK operation. For an in-scope operation, use a small adapter-owned helper, encoding or lifecycle orchestration when it faithfully implements the contract: for example mapping argv to a shell-only transport, capturing stdout/stderr bytes in the guest before a text-only log channel transforms them, or orchestrating stop/capture/start. Prefer a suitable native channel when one exists.

Keep these mechanics behind the SDK API: callers never install helpers or configure wire encodings. Document image/runtime prerequisites, lifecycle effects and limitations. Guest output and command arguments stay untrusted data: never confuse user output with helper control records or interpolate arguments unsafely. Prove byte/argument fidelity, bounded collection, exit evidence, malformed receipts, cancellation and cleanup at the native boundary. Preserve confirmed outcomes and available output when later retrieval fails; never replay a command to recover its output.

Test an uncertain mechanism early with a focused fixture (paid experiments still need authorization). Missing evidence is something to investigate, not a claim of support or impossibility. Report unsupported when the operation cannot reliably meet the contract, and escalate a specific contract conflict rather than silently dropping an essential workflow. This does not authorize a new storage system, archive-based snapshot emulation, cross-provider fallback or provider redesign.

## Use the shared setup options

Provider choices live in adapter configuration, not in application calls. Use these names wherever the provider has the matching choice so switching providers keeps the same setup vocabulary:

- `image`: default image for creates that name none; return it as `defaultImage` and check it exists in the verified scope.
- `network`: `"blocked"` or `"internet"`; return it as `defaultNetworkPolicy` and list every enforced policy in `supports.network`. Default to `"blocked"` only when the provider really blocks egress. When it cannot, require `network: "internet"` in setup with a clear validation message instead of defaulting to it (boxd and Boat do this). Peer or metadata isolation is not blocked egress.
- `resources`: minimum `{ vcpus, memoryMiB }` via the exported `ResourceMinimums` schema. Choose the native size with `smallestSize(provider, sizesSmallestFirst, minimums)`, which throws `UNSUPPORTED` rather than rounding down, and reject unmet minimums before provider IO. Report the actual size from `inspect` as a `resources` fact. Do not add native size keys or small/medium/large presets.
- `lifecycle.lifetimeSeconds`: default 900 seconds, clamped to the provider's range; `renew` extends it where supported. `lifecycle.idleSeconds` only where the provider has a native idle stop.
- `preview: { access, ports }`: `access` is `"protected"` or `"public"`; protected previews return `headers`. Reject an access mode the provider cannot give.

Add provider-specific keys only for real choices the shared names cannot express (Daytona `target`, Boat `environment`). When renaming an existing key, keep the old name as a deprecated alias for one minor release and reject setups that supply both; map deprecated native network names with `networkPolicyAliases`. A caller's `create()` override always wins over a setup default, and an unsupported override fails before allocation with no fallback.

### Snapshot defaults

When snapshot capture is in scope, follow [provider state portability](https://github.com/pandemicsyn/sandbar/blob/main/specs/provider-state-portability.md#2-snapshot-and-restore). The normal call is `box.snapshot()` with no required options; the adapter supplies the simplest supported native workflow and owns its lifecycle orchestration.

- Expose typed configuration only for real choices. Daytona defaults to stop/capture/start for a running source, leaves a stopped source stopped, and offers `restartAfterCapture: false`. E2B capture includes memory and handles pause/resume natively; do not invent memory-exclusion or pause-permission settings.
- Advertise the configured default and actual guarantees. Optional exact requirements validate that default before effects; they never select different semantics. No snapshot capability means effect-free `UNSUPPORTED` before stopping compute.
- Keep the configured source-restoration attempt after definitive capture failure. Preserve the confirmed capture and retained snapshot identity if source restart fails; distinguish failed from uncertain restart. Follow the [ordinary results and resource identity contract](https://github.com/pandemicsyn/sandbar/blob/main/specs/sdk-recovery-dx.md); never replay uncertain effects.
- Document capture scope and exclusions, memory inclusion, source lifecycle and process/connection effects, restored execution, options and defaults, prerequisites, and partial-failure cleanup. Distinguish planned, implemented, fixture-tested and live-qualified behavior.
- Test no-argument defaults, option alternatives, strict rejection before effects, source restoration and failures, and uncertain dispatch without replay, including fresh connections and reopening after source deletion where supported.

## Implement the public definition

1. Export a `defineAdapter` definition with a stable lowercase provider `name`, `displayName`, `z.strictObject` configuration and credential schemas, and a `connect` callback. Separate secrets from ordinary configuration; host-controlled endpoint allowlists or policy must not become project-controlled inputs. Importing the module or constructing the definition performs no provider IO.
2. In `connect`, validate setup (for example `smallestSize`), create the native client, register `host.onClose` before fallible verification, verify scope, and return `scope`, `supports`, `create` and `destroy`, plus `defaultImage` and `defaultNetworkPolicy` from setup.
3. `create` makes exactly one native submission, passes `ctx.submissionId` for correlation (not assumed idempotent without evidence), and rejects unsupported image kinds, network policies, regions, labels, mounts, requirements or `env` in `prepare` before dispatch. Return `state: "running"` only after confirmed readiness. Set `supports.createEnv: true` only when create-time `env` reaches every command, process and terminal, including after `reopen`; never put its values in tokens or messages.
4. For reopening, return `reference: sandboxReference(provider, scope, nativeId, { operation, submission })` from create and implement `reopen`, checking with `assertResourceScope`. `sandboxList` references must be ones `reopen` accepts, built only from native evidence, or `null`. Return each item's create `labels` (strip your own markers with `listedLabels`; `null` when the provider keeps none) and native `createdAt` (`listedTime`; `null` when unreported), so `sandbar gc` can find a killed job's sandboxes.
5. Add `inspect` (start facts from `unknownSandboxFacts()` and fill in known expiry, idle stop and `resources`), `exec`, `processes`, `files`, `preview`, `inventory`/`sandboxList`, `renew`, `suspend`/`resume`, images, snapshots or volumes only as the capability checklist allows. Declare process and stdin behaviors with their explicit markers (`processes.supports`, `exec.finiteStdin: "bytes"`).
6. Prefer plain async methods returning documented plain values. Use `{ prepare, submit, observe }` when preflight or asynchronous recovery needs the split; `prepare` is read-only, and resource or image-building effects belong in an explicitly supported mutation.
7. Narrow discriminated command/image inputs before using provider fields. Do not weaken public inference with broad casts, and do not export private workspace types in declarations.
8. Export a factory built with `bindAdapter(definition, config, credentials)` so applications write `Sandbar.connect(provider({ ...options }))`. Official adapters export `<provider>Adapter`, `create<Provider>Adapter(options)` (injectable transport and timing for tests) and `<provider>(options)`.

### Uncertain outcomes and recovery

- Return a normal value only for confirmed completion. Use `ctx.reject` only for a definitive rejection with no effect; a timeout or lost response after dispatch is `ctx.unknown`, not proof of failure.
- Return `ctx.pending(token, { pollAfterMs })` with a versioned recovery schema when there is a usable continuation. Tokens are bounded JSON with no secrets, clients or functions.
- `observe` only reads evidence for the same verified scope and attempt, validates native resource/operation correlation, and never calls `submit` or retries. No evidence means pending/unknown/null, never fabricated success. A saved request ID alone does not recover a missing resource ID; document what cannot be reconciled.
- Resource references are minimal versioned locators (provider, exact native identity, scope/routing) that reopen with current credentials. Do not require the original credential, process-local state or a hidden database.
- Applications own persistence and recovery policy. Preserve confirmed results and known identities through errors. Incidental cleanup requires correlated creation evidence.
- Honor callback signals and deadlines. Do not claim remote cancellation just because the SDK stopped waiting.

## Test

- Run `adapterSuite` from `@sandbar-sdk/adapter/testing` against a deterministic native-boundary fixture with two genuinely different verified scopes, effect/release counters, lost-response and held-response faults, and proof that native mutation retries are disabled. Report the scenarios it actually ran; it is not live certification. In the repository, follow `packages/adapter/src/testing.ts` and `packages/providers/*/src/adapter.test.ts`.
- Add focused tests for each declared operation: unsupported inputs before mutation, scope mismatch, loss after one native effect, observation without replay, binary and argument fidelity, declared bounds, setup defaults, `resources` selection and rejection, and cleanup. If pending tokens are supported, reopen a connection and recover the saved reference.
- Connect through `sandbar-sdk` in at least one test.
- Pack real artifacts into a clean consumer: strict NodeNext declarations, Node and Bun execution, npm/pnpm/Bun installs, no undeclared or private dependencies. In the repository, extend `packages/sdk-qualification/package-smoke.mjs` and run `bun run package:smoke`. Report unrun environments explicitly.

## Package and release

- Ship ESM with TypeScript declarations. Depend on `@sandbar-sdk/adapter`, the schema library and the pinned native SDK; `sandbar-sdk` only for tests and examples. No SQL dependency, no private workspace imports in the installed artifact.
- The `sandbar` CLI loads any adapter through a profile's `module` and `export` in `sandbar.json`, so third-party packages need nothing extra.

For an official adapter in the Sandbar repository, also:

- add the package to the `build:packages` and `check:built` chains in the root `package.json` and to `apps/docs` dev dependencies when docs examples import it;
- add it to the fixed release group with a changeset (experimental packages keep their existing release status);
- add a CLI descriptor in `packages/cli/src/providers.ts` mapping its credentials and required config to environment variables;
- add a provider profile in `packages/sdk-qualification/provider-qualification/profile.ts` and reuse the ordinary `bun:test` suites in `packages/sdk-qualification/live`; follow the [qualification skill](https://github.com/pandemicsyn/sandbar/blob/main/.agents/skills/qualify-provider/SKILL.md) for an authorized live run;
- before the first release, a maintainer publishes a `0.0.0` placeholder and configures npm trusted publishing for the new name (`bun run release:bootstrap publish`, then `bun run release:bootstrap trust <package>`), or the release cannot publish it.

Run root build/typecheck (`bun run check`), focused tests, `bun run lint`, `bun run format:check`, `bun run package:smoke` and `bun run docs:check` as the changed surfaces require; run shared builds sequentially.

## Document

Write a provider page (and package README) covering setup options and defaults, credentials, image and network prerequisites, capabilities and limitations, and recovery limits. Mark the adapter experimental until it passes a live run (official adapters also show it as experimental on the docs landing page). Update the provider support matrix and keep fixture-tested, packed-tested and live-tested behavior distinct. Never present fixture coverage as a live pass.
