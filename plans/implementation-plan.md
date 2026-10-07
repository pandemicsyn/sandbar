# Implementation sequence

Updated October 5, 2026. SDK completeness and qualified provider integrations come first.

## Delivery rule

New features ship through the SDK and public adapter API.

SDK scope validation, recovery references, unknown-effect handling, and no-replay guarantees remain mandatory.

## Merged SDK foundation and current queue

The foundation and latest DX implementations are merged: snapshots/volumes (#25), provider acceptance (#32), ordinary partial results/resource identities (#33), cleanup configuration (#34), public types/errors (#35), docs reconciliation (#37), reopen/inspect (#38), read cancellation (#51), E2B text streaming (#52), output helpers (#53), bounded-exec timeout docs/fixtures (#54), configured renewal (#55), creation defaults (#58), directory APIs (#59), UTF-8 helpers (#61), preview access (#60), native suspend/resume (#57), and E2B local-handle termination (#66). The optional service and management UI were removed in #39. Use the [roadmap](../ROADMAP.md) for the authoritative queue and current package code/tests for shipped behavior.

The [acceptance tooling](../packages/sdk-qualification/provider-qualification/README.md) uses ordinary Bun suites and an offline generated support table. #68 records scoped live passes at `3188e33` for reopening, renewal, signal-bearing files, E2B streaming/directories and supported previews. Historical passes do not qualify new code; blocked access and failed probes remain visible.

Native suspend/resume merged in #57 for eligible Daytona containers and E2B private-state memory pause; mounted suspension remains unsupported. Reopen/inspect and renewal prerequisites are merged. [Default creation and everyday files](../specs/sandbox-basics-dx.md) and the preview slice of [preview access and useful process control](../specs/preview-and-process-control.md) are merged. Daytona directory primitives and E2B listing remain unsupported; E2B mkdir/remove require `recursive: true`. Preview supports Daytona protected headers and E2B explicit public access; E2B default creation/restore is private but protected preview is unavailable.

E2B local-handle termination merged in #66: one cached native SIGKILL PID request with explicit reuse races, no descendant guarantee and independently observed exit. Daytona termination remains unsupported. [Finite stdin for ordinary exec](../specs/process-stdin.md) merged in PR #71: one optional text/byte input across Daytona, E2B and experimental Modal, with deterministic and packed coverage but no live qualification. Incremental process input and sustained output remain separate future work. The [storage composition contract](../specs/storage-composition.md) was implemented in #69: selected-volume Daytona cold restore under daytona-default, with the complete first-action workflow passing at `5911ccc`.

Generated evidence records Daytona suspension at `6796b30`, E2B suspension at `26f516d`, and bounded E2B termination at `131a8c6`. Each pass retains its configuration and prior failures, not a current-head or universal claim. The E2B lifecycle case's fresh-process inactive reopening and RAM continuity do not qualify the separate full reopen, renew, streaming or signal-bearing read workflows. #68 separately qualified reopening, renewal, signal-bearing reads, E2B streaming/directories and supported previews. Configured creation and private-default ingress denial retain their qualification gaps.

[Recovery direction](../specs/sdk-recovery-dx.md) keeps ordinary calls and application-owned persistence central. Expanded persistence callbacks, normalized recovery-facts envelopes, application-backed dispatch barriers and generic continuation/workflow machinery are deferred. Shipped compatibility paths and no-replay/deletion safeguards remain supported.

## Later state extensions with concrete provider requirements

- Evolve volume metadata to separate backing from filesystem semantics and durability boundaries. Add capacity/placement only when needed by an actual provider/use case.
- Mounted capture and memory composition require separate designs and native evidence; the shipped cold-restore API uses explicit `MountSpec[]`, not share/replace/omit maps.
- Optional volume versions and native forks follow demonstrated need under the [state contract](../specs/provider-state-portability.md).

Keep these scoped separately from the merged recovery work. Current limitations remain explicit until implementations and appropriate qualification exist.

## Implemented: SDK tracing and diagnostics

The direct tracing/diagnostics and OpenTelemetry, Sentry, and Datadog recipes from the [observability spec](../specs/sdk-observability.md) merged in PR #24. Bounded metrics and structured diagnostic events remain later work after tracing is stable.

## Broaden the SDK and provider coverage

- The remaining process work in the [preview/process brief](../specs/preview-and-process-control.md) extends the shipped [finite streaming contract](../specs/interactive-execution-and-access.md) through small independently reviewed slices. Other provider streams, terminals and tunnels remain separate later work.
- Close remaining SDK gaps in images, resource configuration, files, and networking as focused contracts with demonstrated use cases.
- Establish several usable, qualified provider integrations. Vercel and Tensorlake specs will be written when scheduled; provider distribution and ordering remain in [package conventions](../specs/package-conventions.md).

New providers remain behind the roadmap’s SDK usability gate. Universal native parity is not required; support claims still require evidence.

## Existing implementation and evidence

The SDK and public adapter API already exist. Use [architecture](../specs/design.md), [public documentation](../apps/docs/README.md), and [qualification](../packages/sdk-qualification/README.md) for current behavior and evidence. Completed and superseded plans are available in Git history.

Publication, deployment and paid provider calls require separate authorization. This sequence does not authorize them or introduce additional feature requirements from removed specs.
