# Sandbar 1.0 providers and follow-up roadmap

Historical implementation plan, September 27, 2026. The starting gaps, owner assignments and sequencing below record the plan at that time; they are not current status. Release PR16, external Modal PR17, E2B PR18/21 and Daytona PR20 have since merged. Follow current package READMEs and committed qualification evidence for implemented behavior and remaining live-test limitations.

 The latest user decision sets Daytona and E2B as the only 1.0 built-ins. It supersedes the earlier three-built-in target. This is an implementation and acceptance plan, not a claim of current provider readiness.

## Outcome

A developer can install one SDK, select Daytona or E2B, create a usable sandbox, run commands, exchange files, inspect it and clean it up through the same public resource API. The optional service consumes that same SDK implementation. Core operations must work; advertising a missing core method as unsupported does not satisfy this plan.

The completion target is the existing Sandbar sandbox workflow plus its concrete missing image, file and recovery behavior. It does not silently encompass every provider-specific product feature, such as GPUs, volumes, browser streaming or pause/resume. Any such dependency discovered for the normal workflow must be called out explicitly. No existing website copy or design is changed by this work.

## Launch scope and ordered follow-ups

- **1.0 built-ins:** Daytona (`sandbar-sdk/daytona`) and E2B (`sandbar-sdk/e2b`). Both must meet the applicable acceptance and live-qualification gates below.
- **Modal:** continue the already authorized implementation as a separately installed experimental adapter, using the same public adapter API. Its private version-sensitive transport, image-build recovery limits and qualification status must be explicit. It is not a 1.0 built-in or a blocker for the two-provider launch. Coordinate removal of bundled Modal wiring and dependencies on its own branch after the release tooling parent is stable; preserve the completed implementation.
- **Fast follow, in this exact order:** Vercel → Boxed (boxd) → Islo → Tensorlake. This is roadmap priority, not authorization to start four new tasks, add placeholder exports or publish packages. These providers are not 1.0 launch gates. Their distribution follows the external-adapter convention unless separately changed.

Release-tooling PR16 continues independently; its merge is not the act of publishing 1.0. Provider packaging changes follow it through reviewed integration. Existing marketing copy remains untouched.

## Required acceptance matrix

Each owner records separate implementation, native-fixture, packed-consumer and live results for every row. Use pending, pass, fail or blocked with evidence; never one undifferentiated green provider badge.

| Requirement | Acceptance evidence for each provider |
| --- | --- |
| Installation and connection | Public SDK root and built-in subpath or external adapter package install with strict NodeNext declarations; factory performs no IO; connect authenticates and verifies the native scope. No service or SQL dependency in direct mode. |
| Images and create | Prepared image works. A practical OCI-to-sandbox workflow works, including providers that require a template/build step; differences are represented explicitly. Read-only prepare never builds. Paid image or sandbox creation is admitted as a mutation, with retained identity and honest uncertainty. |
| Commands | Literal argv and explicit shell, cwd and env, empty/binary stdout and stderr, exit code, bounded combined output, large output, deadlines and nonzero exits. Provider-required utilities/runtime prerequisites are explicit and checked where practical. |
| Files | Exact binary read/write, overwrite, atomic create-if-absent, existing-file conflict, missing paths and configured bounds. No exists-then-write race presented as atomic. |
| Resource lifecycle | Inspect and scoped inventory; destroy confirms compute stopped and reports retained resources. Closing a client only releases local resources unless the API explicitly promises more. |
| Uncertain outcomes | A lost response after a native effect retains the original operation identity. Reopening observes that attempt without resubmitting it. Test create, exec, write and destroy individually; list any truly unrecoverable native boundary as blocked or a concrete contract decision. |
| Cancellation | Abort/close settle local waits, late results do not create extra submissions, and native process cancellation is distinguished from stopping the wait. Timeouts are not proof that no effect occurred. |
| Scope and policy | Wrong account/project/app/region references reject before effects. Credentials never enter references or logs. Network policies are verified native guarantees, including account-tier exceptions. No silent fallback to weaker isolation. |
| Service integration | Same adapter and public SDK path; encrypted credentials, HTTP operations, durable restart and observation-only recovery. No provider-specific second execution engine. |
| Distribution | Actual tarballs, only documented top-level dependencies, strict types and Node/Bun execution. npm/pnpm/Bun installer coverage follows the release harness. |
| Live qualification | The same bounded lifecycle is exercised against the real provider only after explicit authorization, with resource/build budget, time limits, cleanup and retained-resource accounting. |

The ordinary acceptance scenario is: connect; create; run a command with environment and cwd; capture nonzero exit and binary output; roundtrip a binary file; prove no-clobber preserves an existing file; inspect/list; destroy; close. Fault scenarios separately lose responses at the actual native transport boundary, reopen and recover without replay. A successful fake callback alone is insufficient evidence.

## Current starting point and owners

| Provider | Verified starting gaps | Owner and immediate work |
| --- | --- | --- |
| Daytona | Prepared snapshots only; atomic no-clobber disabled; uncertain exec/write/delete lack durable reconciliation; live unqualified. Existing create/exec/read/write/inspect/inventory/destroy paths are fixture tested. | New task “Complete Daytona provider integration”. Investigate OCI build/create, atomic native or sandbox-side writes, native command/session correlation and destruction-state evidence; implement the smallest supported solutions. |
| Modal | Exec and write disabled in merged main because native helpers retry mutations; prepared images only; live unqualified. | Active task “Finish Modal provider integration”. Implement a narrow version-pinned single-submission router, process/result recovery, binary writes and atomic no-clobber. Approved OCI path builds only inside create submission; an uncertain image build remains an effect, including possible retained paid images. |
| E2B | No implementation merged yet. | Active task “Implement E2B provider integration”. Complete native-backed public adapter and factory, service registration, all core operations, verified team/template policy and recovery. Intermediate compile or test reports are not final qualification. |

All owners must supply a source-backed capability matrix early, before treating native restrictions as reasons to omit essential functionality. Use pinned native SDK source plus official APIs; distinguish an upstream limitation from a limitation of our current integration.

## Strategy for conflicting native contracts

### One consumer API; adapter-local mechanisms first

Continue using the existing public adapter definition, scope, guarantees, mutation prepare/submit/observe split and versioned recovery tokens. Providers may use different native implementations without exposing private native types or creating separate SDK/service engines.

1. Prefer a verified native API with retries controlled at the wire boundary.
2. If a convenience SDK cannot preserve the contract, use a small version-pinned transport for the necessary native operations.
3. If the native API lacks an operation but the sandbox can implement it correctly, consider a small sandbox-side command with an explicit runtime/filesystem prerequisite and native correlation. Prove atomicity and binary behavior. Do not silently introduce a permanent guest agent.
4. If the common contract cannot honestly represent two providers, bring the exact conflicting behaviors and a minimal shared contract proposal to the manager. Select one owner to implement that change and qualify it against both providers before propagating it to the third.

No speculative universal transport, job scheduler, image registry or new persistence framework is authorized merely because providers differ.

### Images

Prepared snapshots/templates and OCI references remain distinct inputs. Image construction is an effect, not validation. Prefer the existing create mutation to own a provider's build-then-create sequence when its effects and recovery can be represented honestly. Keep stage identifiers in the existing bounded recovery token when supported; never put credentials or clients there.

E2B may require a template-oriented build boundary rather than direct registry creation. Its owner must demonstrate the actual native requirement before a shared image API is chosen. If a distinct build operation is necessary, define it once as an explicit paid mutation with lifecycle and recovery semantics, rather than disguising it as a read or inventing three incompatible provider-specific SDK methods. That is a concrete proposal gate, not permission to defer the image workflow indefinitely.

### Shared image boundary: concrete direction

All three owners independently confirmed a build-before-sandbox sequence. A crash after the image build but before sandbox creation cannot be completed by a read-only observer. This is now a demonstrated common requirement, not a hypothetical abstraction.

The selected design direction is an explicit image-build mutation returning a scoped prepared image, followed by a separately admitted create mutation. The approved consumer shape is `client.images.build({ source: Image.oci(...) })`, with `submitBuild` for an operation handle, then `sandboxes.create` with the scoped prepared result. This is approved for implementation, not an implemented export. Keep ordinary OCI create convenience, but do not promise transparent recovery across an unsubmitted second stage.

The E2B owner is the sole implementation owner for the approved minimal adapter/SDK/service image-build boundary, following the stable release parent. Reuse the existing mutation engine, admission and read-only observation boundary; no registry, image-delete API, scheduler or generic workflow framework. The SDK binds prepared results to the verified provider/scope and validates that binding before a later create. Bounded retained-resource metadata admits unknown ownership and grants no deletion authority. Native allocation/trigger gaps remain unknown unless read-only evidence proves completion; observers cannot advance missing stages. Modal and Daytona continue their core work and normal OCI paths meanwhile. A successfully recovered image allows a new explicit create; observing an image must never secretly submit that create.

### Mutation identity and recovery

Prefer native operation/process IDs and correlated read-only status/output endpoints. Where needed, evaluate a bounded sandbox-side result receipt tied to the original operation and verified resource. Receipts have explicit retention, integrity and cleanup limitations; they do not magically survive sandbox deletion.

Never automatically retry an uncertain mutation. Distinguish confirmation of the requested resource state from proof that one particular HTTP request caused it. For example, an authenticated, scope-bound native termination result may establish that compute stopped without proving which delete request did it. Any adjustment to shared outcome semantics requires a concrete proposal and regression coverage; absence or a generic 404 alone is not universally conclusive.

Arbitrary response loss cannot always be made knowable. An evidence-backed native impossibility needs an explicit product/contract decision and a usable recovery procedure. It is not silently waved through as feature complete or “fixed” by replay.

### Atomic writes

Use a native exclusive-create primitive or an atomic sandbox filesystem operation. A staging-file plus atomic commit approach is acceptable only with verified same-filesystem semantics, precise path/overwrite behavior, cleanup and lost-response handling. A preflight existence check followed by overwrite is not a substitute.

### Policy and cancellation

Capabilities describe actual guarantees for the connected scope and requested operation. A missing core operation remains a completion gap. Network entitlement differences and native resource constraints must fail explicitly before effects; no silent weaker policy. Cancellation of an SDK wait, transport cancellation and remote compute termination remain distinct facts.

## Execution and integration order

1. All three provider tasks proceed independently in managed worktrees. Each produces a finite gap list, native evidence, and its exact proposed changes to shared files.
2. Release PR16 completes independently. Provider work must not hold it or inject unfinished dependencies into its graph.
3. The first provider ready to integrate consumes final merged release main. Manager assigns ownership of any shared adapter/SDK change. The separate “Build provider E2E harness and evidence matrix” task owns the common workflow runner and report generation. Keep native fixtures/provider code separate.
4. Merge providers sequentially after their final qualification; later owners consume each stable merged parent once as needed. Avoid provisional rebases and competing root/lock edits.
5. The shared harness task reuses the existing adapter conformance, packed and opt-in live harness pieces for common scenarios. Add genuinely cross-provider assertions once; native retry/correlation fixtures stay provider-specific. A shared harness may receive typed provider fixture factories/configuration rather than hard-coded provider switches.
6. Run affected checks during iteration, then final integrated direct/service/packed gates and complete independent review. New findings must demonstrate a supported-path failure or violated agreed guarantee; no optional malformed-adapter or unrelated service hardening loops.
7. Audit actual PR feedback and exact-head CI, merge through the manager, archive completed author tasks after handoff. A merged PR establishes implementation status, not live readiness.

## Definition of done and reporting

- Implementation complete: every required matrix row is implemented or an explicit provider constraint has a reviewed common-contract solution. No essential operation is merely disabled; unresolved required rows prevent the label.
- Fixture qualified: actual native request/response paths and attempt counts pass normal and fault scenarios, including restart and no replay.
- Distribution qualified: the applicable built-in entrypoint or external package and service work from real packed artifacts on supported runtimes/installers.
- Live qualified: the bounded real-provider acceptance run passes with explicit authorization and recorded cleanup. This has not happened for any provider at the start of this plan.
- Production readiness is reported separately with the actual remaining limitations. Do not equate merged, compiled, fixture-tested and live-tested.

Before requesting live authorization, owners prepare a concrete reviewable plan: provider/account scope, image/template, maximum sandbox count/lifetime and build duration, possible retained-image charges, cleanup steps and credential injection method. No secrets in chat, no unbounded spending, no live calls before authorization. Observability implementation, Effect adoption, npm publication and existing marketing-copy changes are outside this plan.

## Common provider harness and support matrix

The user separately authorized a dedicated exploration/prototype task, “Build provider E2E harness and evidence matrix”. It owns a small public-SDK runner for common scenarios and sanitized machine-readable reports that generate a reproducible docs support matrix. Initial scenarios are connect, prepared-image create, inspect, argv/shell with cwd/env/exit/output, binary file roundtrip/overwrite/basic no-clobber, inventory, destroy and close. OCI build is separately selectable. Exhaustive fault races and malformed inputs stay in native fixtures.

Track passed, failed, not-run, unsupported and blocked results with execution mode, exact SDK commit/version, native version where relevant, timestamp, runtime/platform, nonsecret image/configuration context and evidence reference. Never render fixture results as live-known-to-work or hide a newer failure behind an older pass. Default runs and ordinary docs/PR CI remain offline; live execution still requires explicit authorization, bounded resources/time and cleanup. Docs generation reads committed sanitized evidence without calling providers. This new support-matrix scope does not authorize rewriting landing/marketing copy.

### Live harness teardown gate

The user will supply API keys through an appropriate secret mechanism and explicitly requires robust teardown before live qualification. A `finally` block alone is insufficient. The harness must record a private durable run ledger and correlation identity before each possible paid mutation, persist returned IDs, use provider-native sandbox expiry, clean up on normal failure/interruption, and offer an idempotent cleanup/reconcile command after process loss. Cleanup verifies the native stopped/deleted state and preserves unresolved residuals as a failed/incomplete run.

Track images, templates and snapshots as well as compute. Delete only positively identified resources created by this run; never delete configured borrowed images or ambiguously shared/deduplicated artifacts. A live build scenario stays disabled if safe ownership/deletion cannot be established. Baseline qualification can use borrowed prepared images with native sandbox expiry.

The harness owner must propose an independent cleanup backstop and ledger survival across host/CI loss, including an always-run cleanup step and separate janitor invocation where appropriate. No recurring native jobs are enabled yet. Provider outages or revoked credentials can prevent deletion, so the system must keep a durable residual inventory and retry path rather than promise impossible absolute cleanup or report false success. Offline teardown/restart/ambiguity/borrowed-resource tests precede any paid run. Supplying keys later does not itself authorize a live run; use environment or CI secrets, never chat messages.

CI-specific durability: uploading the ledger only after the job finishes does not survive runner loss. An off-runner checkpoint of the operation intent/reference/correlation must succeed before paid submission; checkpoint failure permits no native effect. The janitor must discover incomplete ledgers independently of the original runner. A local manual run may use a stable private operator-selected directory with provider-native expiry. Until the CI persistence mechanism is implemented and proven, CI live mode remains blocked. Scenario passes may be retained as evidence after a cleanup failure, but the overall run must remain failed/incomplete.
