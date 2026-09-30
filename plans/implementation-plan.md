# Implementation sequence

Updated September 29, 2026. [The roadmap](../ROADMAP.md) sets the authoritative order: SDK usability comes before additional adapters. This plan records completion and links follow-ups. The optional service is a distant milestone.

## Delivery rule

New features ship through the direct SDK and public adapter API. New HTTP routes, remote-client parity, durable service orchestration, persistence/migrations, service tracing, and management UI work are not feature acceptance or release requirements.

Preserve existing service behavior and keep existing regression checks passing. Make narrow compatibility fixes when shared contracts change; do not expand the service to mirror each new SDK feature. Document SDK-only support explicitly. This decision does not delete the service or remove existing tests, and does not weaken SDK scope validation, recovery references, unknown-effect handling, or no-replay guarantees.

## Completed: snapshots and retained volumes

[PR #25](https://github.com/pandemicsyn/sandbar/pull/25) merged at `a9d59b0`. Direct SDK connections now implement snapshot capture/inspect/restore/delete, retained volume management and supported create-time mounts under the [state portability contract](../specs/provider-state-portability.md). The merged slice includes scope/identity validation, checkpoint persistence, retained custody, explicit continuation and observation without replay. No review gate from that PR remains open here.

Both providers' snapshot round trips passed live on premerge `5db0558`, including two-way filesystem write isolation and serialized references reopened after source deletion. Daytona mounted persistence and exact cleanup also passed. Main contains later fixes; these historical runs do not certify the final merged head. E2B volume creation returned HTTP 403 and did not pass live validation. An earlier uncertain E2B volume attempt still requires private custody reconciliation; empty inventory did not establish no effect. The [support matrix](../apps/docs/src/content/docs/docs/providers/support.md) and [qualification plan](provider-acceptance.md) own evidence mapping and remaining qualification.

External-mount capture, mounted restore, read-only mounts, volume versions and verified shutdown durability remain unsupported. Writable mounted compute cleanup explicitly accepts unconfirmed durability; retained storage requires separate deletion. Preserve the state portability spec for remaining lifecycle/storage work.

## Active follow-ups

CI cleanup is in progress separately: reduce repeated builds and stabilize existing fixtures while preserving meaningful validation. It is not completion of provider qualification or a new SDK feature.

Follow [the provider acceptance plan](provider-acceptance.md) to consolidate branch/release testing into one maintained runner and generate a small evidence-backed support matrix. This cleanup precedes onboarding more adapters.

Recovery DX is a separate active SDK effort under [the focused spec](../specs/sdk-recovery-dx.md): typed partial outcomes and typed recovery, durable `onReference` on the bound-adapter connection form, and small shared checkpoint/dispatch helpers with recovery conformance tests. Preserve application-owned persistence, native evidence, explicit continuation and no replay. No workflow engine or service persistence is included. These APIs remain pending until that implementation lands.

After recovery DX lands, update the snapshots/volumes failure section and SDK README to use the bound-connection persistence hook and typed partial outcomes instead of opaque-token guidance. Update their persistence/uncertain-operation examples against the landed signatures; the normal snapshot/volume examples currently use implemented APIs only. The recovery peer owns `recovery.md`, `adapter-recovery.md` and `specs/sdk-recovery-dx.md`.

## Next usability milestones

Follow [the roadmap](../ROADMAP.md#next-make-everyday-sandbox-and-storage-lifecycles-usable):

- Cleanup configuration is approved in direction but not implemented. Allow connection-level writable-volume cleanup policy with per-call precedence, keeping `require-durable` as the unconfigured default. It adds no flush guarantee or automatic volume deletion; exact public signatures still need specification.
- Specify reconnect/lifetime first, then native suspend/resume as separate bounded slices. Reconnect must not implicitly allocate or resume compute. Preserve provider-specific state/execution and uncertain-outcome semantics.

Then scope interactive process handles/output and storage composition against concrete application needs. Richer volume visibility, durability, locking and rename guarantees and mounted restore require native enforcement before execution. Capacity/placement, dynamic attachment, volume versions and native forks remain optional extensions. See the [state contract](../specs/provider-state-portability.md) and [interactive draft](../specs/interactive-execution-and-access.md); neither authorizes a broad implementation by itself.

## Implemented: SDK tracing and diagnostics

The direct tracing/diagnostics and OpenTelemetry, Sentry, and Datadog recipes from the [observability spec](../specs/sdk-observability.md) merged in PR #24. Bounded metrics and structured diagnostic events remain later work after tracing is stable. Service propagation, persisted trace context, and runner tracing remain deferred with the service.

## Gate before additional providers

New adapter implementation waits for the [SDK usability milestone](../ROADMAP.md#gate-before-new-adapters): coherent everyday compute/storage/lifecycle APIs, typed recovery, persisted identities, useful process output and reliable examples/qualification. Research remains reference material, not implementation authorization. Reassess remaining material DX gaps with the user before scheduling another adapter; universal native parity is not required.

Vercel and Tensorlake specs will be written when scheduled. Distribution rules remain in [package conventions](../specs/package-conventions.md). SDK gaps in images, resource configuration, files and networking should remain focused contracts with demonstrated use cases.

## Distant milestone: optional service

Revisit service expansion only after the SDK feature set is mature, several provider integrations have useful qualification, and a concrete service use case justifies the work. Existing Daytona/E2B baseline support alone does not trigger this milestone.

Then scope HTTP/remote-client coverage, durable background orchestration and recovery, persistence and authorization, service observability, and any management workflows against actual needs. Feature parity must be selected deliberately at that time; it is not an automatic backlog attached to every SDK change.

Accounting remains separate and deferred. Rust is not on the roadmap. Effect remains parked and is not an implementation or release gate.

## Existing implementation and evidence

The SDK, public adapter API, optional service and management UI already exist. Use [architecture](../specs/design.md), [public documentation](../apps/docs/README.md), and [qualification](../packages/sdk-qualification/README.md) for current behavior and evidence. Completed and superseded plans are available in Git history.

Publication, deployment and paid provider calls require separate authorization. This sequence does not authorize them or introduce additional feature requirements from removed specs.
