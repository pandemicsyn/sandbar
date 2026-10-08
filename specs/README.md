# Specifications

This directory holds current contracts and focused future design. [ROADMAP.md](../ROADMAP.md) is the only delivery queue. New work targets the SDK and public adapter API; preserve scope/identity validation, unknown-effect handling and no automatic mutation replay. Public usage belongs in [the docs](../apps/docs/README.md), and qualification rules/results belong [with the maintained suites](../packages/sdk-qualification/README.md).

## Active delivery plans

- [Filesystem DX](filesystem-dx.md) — directory browsing and metadata, large transfers, copy/move, and selected traversal/text/range extensions. F1–F4 traversal and text lines implemented; ranges and other extensions remain separately deferred.
- [Streaming and interactive processes](process-io-dx.md) — sustained output, status, incremental input, process control and complete application workflows. First slice: P0 transport decision, parallel with F1.

These plans describe proposed changes. The contracts below retain current behavior until each documented migration lands. The roadmap owns sequencing; do not create duplicate implementation queues.

## Current contracts

| Contract | Implemented scope | Remaining boundary |
| --- | --- | --- |
| [State portability](provider-state-portability.md) | Snapshots/volumes (#25), cleanup configuration (#34) | Broader state sketches are not exported promises; use focused contracts below |
| [Results and resource identities](sdk-recovery-dx.md) | Ordinary partial outcomes, scoped saved identities (#33) | Expanded persistence callbacks and workflow machinery deferred |
| [Sandbox lifecycle](sandbox-lifecycle.md) | Reopen/inspect (#38), renewal (#55), suspend/resume (#57) | Native defaults and evidence; mounted suspension excluded |
| [Execution and read cancellation](interactive-execution-and-access.md) | Finite E2B text streaming (#52), local read cancellation (#51) | Sustained/binary/reconnectable output is not implemented |
| [Output and timeout semantics](output-and-timeouts.md) | Full decoding/previews (#53), timeout docs/fixtures (#54) | No new native runtime-enforcement guarantee |
| [Creation and everyday files](sandbox-basics-dx.md) | Creation defaults (#58), text helpers (#61), optional directory hooks (#59) | Partial native directory support; configured-creation qualification pending |
| [Preview and process control](preview-and-process-control.md) | HTTP previews (#60), E2B local-handle termination (#66) | Private ingress qualification, sustained output and incremental input remain separate |
| [Finite exec stdin](process-stdin.md) | Text/byte input plus EOF across Daytona, E2B and experimental Modal (#71) | Live qualification pending; no incremental process input |
| [Storage composition](storage-composition.md) | Explicit selected-volume Daytona cold restore (#69), scoped live pass at `5911ccc` | Mounted capture, memory composition and blocked-policy mounted restore unsupported |
| [Observability](sdk-observability.md) | Tracing/diagnostics and Sentry/Datadog recipes (#24) | Metrics/events deferred; vendor UI coverage is separate from local export fixtures |

These contracts are retained to explain behavior and protect guarantees, not to reopen completed implementation plans. Current SDK/adapter exports and tested public examples own exact signatures. Native research is dated evidence, not proof of current deployed behavior. The [generated support table](../apps/docs/src/content/docs/docs/providers/support.md) records live results separately; the roadmap lists remaining qualification work.

## Engineering references

- [Architecture](design.md) — implemented SDK/adapter boundaries.
- [Package conventions](package-conventions.md) — public names, dependencies and distribution.
- [Validation](validation-and-contracts.md) — schema ownership and boundary requirements.

For exact APIs, use [SDK exports](../packages/sdk/src/index.ts), [resource types](../packages/sdk/src/resource.ts) and [adapter exports](../packages/adapter/src/index.ts). Completed plans, PR audit notes and superseded service/API archives were removed; Git history preserves them. Keep new work in a focused contract and the single roadmap rather than another duplicate plan.
