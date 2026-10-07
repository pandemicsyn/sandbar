# Sandbar roadmap

SDK usability comes before more adapters. This is the authoritative queue; specs describe contracts and proposals. Work becomes implemented when merged, while live validation retains its actual tested revision and configuration.

## Merged foundation

Snapshot/volume support (#25), tracing/diagnostics (#24), CI cleanup (#29), provider acceptance (#32), and ordinary recovery results/resource identities (#33) are implemented. See [CI validation](CI.md), the [maintained provider integration guidance](packages/sdk-qualification/provider-qualification/README.md) and [recovery direction](specs/sdk-recovery-dx.md).

The latest SDK DX work is also merged:

- [PR #34](https://github.com/pandemicsyn/sandbar/pull/34): connection cleanup policy and per-call overrides.
- [PR #35](https://github.com/pandemicsyn/sandbar/pull/35): direct public types and actionable caller input errors.
- [PR #37](https://github.com/pandemicsyn/sandbar/pull/37): documentation reconciliation, including still-relevant guidance from #30.
- [PR #38](https://github.com/pandemicsyn/sandbar/pull/38): scoped sandbox references, fresh-process reopening, state and deadline inspection. Reopening does not implicitly create, resume or extend lifetime. The separate reopening workflow passed for Daytona and E2B at `3188e33` in #68.
- [PR #39](https://github.com/pandemicsyn/sandbar/pull/39): removal of the optional service and management UI. The project now focuses on the SDK and adapter API.

## Recently completed SDK DX

| Work                         | Merged implementation                                                                                                       | Remaining boundary                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read cancellation            | [PR #51](https://github.com/pandemicsyn/sandbar/pull/51): caller signals, consistent local read deadline and prompt cleanup | Local observation cancellation, not remote workload termination; signal-bearing file scenarios passed at `3188e33` in #68                                      |
| E2B text streaming           | [PR #52](https://github.com/pandemicsyn/sandbar/pull/52): one start, separate text output, confirmed exit and local detach  | Finite bounded text; E2B termination shipped separately in #66; no process reopening, binary or Daytona streaming; finite streaming passed at `3188e33` in #68 |
| Output helpers               | [PR #53](https://github.com/pandemicsyn/sandbar/pull/53): full decoding and structured previews                             | Display shortening remains distinct from capture loss; entirely local helpers need no live qualification                                                       |
| Bounded-exec timeout clarity | [PR #54](https://github.com/pandemicsyn/sandbar/pull/54): provider docs and native-boundary fixtures                        | Existing execution behavior is unchanged; E2B RPC timeout does not prove termination, and deployed descendant termination remains unverified for Daytona/Modal |
| Configured lifetime renewal  | [PR #55](https://github.com/pandemicsyn/sandbar/pull/55): `renew()` / `renew({ forSeconds })` for Daytona and E2B           | Adapter-owned defaults, units and rounding; Daytona/E2B renewal scenarios passed at `3188e33` in #68                                                           |

Everyday workflow and preview slices are now merged:

- [PR #58](https://github.com/pandemicsyn/sandbar/pull/58): adapter-owned creation defaults, including omitted-input creation and explicit override precedence. Maintained configured-creation scenarios have not been run live.
- [PR #61](https://github.com/pandemicsyn/sandbar/pull/61): UTF-8 `readTextFile` / `writeTextFile` wrappers over byte operations; local encoding needs no separate live qualification.
- [PR #59](https://github.com/pandemicsyn/sandbar/pull/59): exported directory APIs with optional adapter hooks. Daytona supports none of the four primitives; E2B supports `fileExists` and requires `recursive: true` for `makeDirectory` / `removeFile`. E2B `listFiles` is unsupported. E2B directory scenarios passed at `3188e33` in #68.
- [PR #60](https://github.com/pandemicsyn/sandbar/pull/60): HTTP preview access for Daytona protected headers and E2B explicitly public setup. E2B default creation/restore is private, but protected preview is unavailable. Daytona protected and E2B public preview passed at `3188e33` in #68; private-default ingress denial remains unqualified.

Contracts and evidence: [execution](specs/interactive-execution-and-access.md), [output and timeouts](specs/output-and-timeouts.md), and [lifecycle](specs/sandbox-lifecycle.md). These slices are merged, not an outstanding coding queue.

Cleanup policy precedence remains per-call choice, `cleanup.storage`, then `require-durable`. `allow-unconfirmed` permits compute destruction without promising flushed writes or deleting retained volumes. See the [state contract](specs/provider-state-portability.md#3-persistent-volumes-and-mount-sessions).

## Current: process research

[Suspend/resume](specs/sandbox-lifecycle.md) merged in [PR #57](https://github.com/pandemicsyn/sandbar/pull/57). Known unmounted Daytona containers retain files and end processes; resume preserves UUID with fresh execution, and hard TTL keeps ticking. E2B memory pause preserves private filesystem/RAM under the same ID; resume reports execution identity unknown. Known mounts are unsupported, missing mount facts remain unknown, and external-storage durability is excluded. Mounted suspension, snapshot emulation and filesystem-only E2B mode remain out of scope.

[E2B local-handle termination](specs/preview-and-process-control.md#process-control-that-means-what-it-says) merged in [PR #66](https://github.com/pandemicsyn/sandbar/pull/66), following the design in #64. An active handle issues one cached native SIGKILL PID request; PID reuse can target a successor, and descendant cleanup is not guaranteed. Exit is observed independently. Daytona termination remains unsupported. SDK lifecycle calls fence process control across same-client aliases before dispatch; they do not fence external controllers or make native PID targeting immutable.

[Default creation and everyday files](specs/sandbox-basics-dx.md), preview, suspension and E2B termination are shipped with their documented provider boundaries. Finite input merged in [PR #71](https://github.com/pandemicsyn/sandbar/pull/71). The [finite stdin contract](specs/process-stdin.md) adds optional UTF-8 text or exact bytes to ordinary `box.exec`, bounded to 1 MiB with EOF, separate output and existing execution recovery. Daytona, E2B and experimental Modal implement the same API through their own mechanics. Deterministic, packed Node/Bun and docs checks passed; live finite-input qualification has not run. The E2B-only incremental-input proposal in #70 is closed as superseded.

The remaining queue is:

1. **Sustained output.** Research bounded native retention and completeness separately before changing output budgets. Today's finite E2B stream is not an indefinite server-log solution. PTYs, tunnels and a generic process platform are not prerequisites.

Incremental input to `processes.start` remains future design work: establish concurrent output, backpressure, delivery acknowledgements, cancellation and EOF across providers before adding a stream or interactive handle. The merged finite-input implementation does not add that surface. Sustained output must establish native retention and completeness before proposing changes to current limits; neither effort requires a broad process framework.

## Completed: selected-volume restore

[PR #69](https://github.com/pandemicsyn/sandbar/pull/69) implements the [storage composition contract](specs/storage-composition.md): a known mount-free Daytona filesystem snapshot can be restored with explicitly selected `MountSpec[]` volumes under `daytona-default`. The complete first-action storage workflow passed at `5911ccc`, with selected A-data/B-empty profiles, captured private state, fresh-client reopening and confirmed cleanup of all run-owned resources. The earlier `824946d` harness failure remains recorded. Mounted capture, memory composition and mounted restore under `blocked` remain unsupported.

For storage, current unsupported combinations remain explicit. Capacity/placement, attach/detach, volume versions, stronger visibility/durability/locking/rename semantics and native forks follow demonstrated need. See [storage follow-ups](specs/sdk-recovery-dx.md#later-volume-guarantees-and-mounted-restore). Expanded persistence hooks, normalized recovery-facts envelopes and generic continuation/workflow machinery remain deferred.

## Qualification gaps

The generated [support table](apps/docs/src/content/docs/docs/providers/support.md) separates implementation from live evidence. [PR #68](https://github.com/pandemicsyn/sandbar/pull/68) records ten passed cases at `3188e33`: Daytona and E2B signal-bearing files, renewal and fresh-process reopening; E2B directories and finite text streaming; Daytona protected and E2B public previews. All five run-owned compute resources were cleaned up. The table now reports streaming independently from captured execution.

Current follow-ups are:

- Qualify the merged finite-input slice with its maintained `execution-stdin` live scenario. Historical execution/streaming passes do not qualify the new input guarantee; paid runs require separate authorization.
- Qualify configured creation with its maintained scenario and E2B private-default ingress denial, including restore where claimed. The #68 selected workflows do not establish those guarantees.
- Investigate and disposition the recorded failed E2B network probe. Fix an integration defect if found, or document the demonstrated provider/configuration limitation; do not promote the result to a pass without evidence.
- Preserve the distinction between E2B volume account access blocked by HTTP 403 and Sandbar E2B mounts being unsupported. Resolve historical volume-creation uncertainty only with sufficient evidence; newer successful cleanup does not erase it.

Earlier scoped passes remain valid evidence for their recorded configurations: Daytona suspension at `6796b30`, E2B suspension at `26f516d`, and E2B local-handle termination at `131a8c6`. They do not establish universal image/platform support, strict network isolation, process-tree termination or external-storage durability.

Use the existing Bun suites and generated docs. Historical passes cover their recorded revision/configuration; offline fixtures do not qualify live behavior. This roadmap does not authorize paid calls or require a new testing framework.

## Gate before new adapters

Vercel, Tensorlake and other adapters remain behind SDK usability. Before scheduling one, review whether applications can create/execute/transfer files, save and reopen supported resources, handle partial or uncertain outcomes, manage supported lifecycles and output, and clean up with clear retained-storage ownership. Tested public examples and the maintained acceptance suites must make those workflows understandable. Resolve or explicitly disposition material qualification failures and missing evidence.

This milestone does not require universal provider parity. Reassess material DX gaps with the user before scheduling new adapters; completing one small streaming slice does not automatically satisfy the gate.

## Later

Beyond the remaining process basics, advanced terminals, tunnels and storage extensions follow demonstrated needs. Additional observability metrics/events and accounting remain deferred. The removed service and management UI are not on the delivery queue. Rust is not planned. [Detailed plans](plans/implementation-plan.md) do not override this queue.
