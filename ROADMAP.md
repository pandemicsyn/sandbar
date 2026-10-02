# Sandbar roadmap

SDK usability comes before more adapters. This is the authoritative queue; specs describe contracts and proposals. Work becomes implemented when merged, while live validation retains its actual tested revision and configuration.

## Merged foundation

Snapshot/volume support (#25), tracing/diagnostics (#24), CI cleanup (#29), provider acceptance (#32), and ordinary recovery results/resource identities (#33) are implemented. See [CI validation](CI.md), the [acceptance plan](plans/provider-acceptance.md) and [recovery direction](specs/sdk-recovery-dx.md).

The latest SDK DX work is also merged:

- [PR #34](https://github.com/pandemicsyn/sandbar/pull/34): connection cleanup policy and per-call overrides.
- [PR #35](https://github.com/pandemicsyn/sandbar/pull/35): direct public types and actionable caller input errors.
- [PR #37](https://github.com/pandemicsyn/sandbar/pull/37): documentation reconciliation, including still-relevant guidance from #30.
- [PR #38](https://github.com/pandemicsyn/sandbar/pull/38): scoped sandbox references, fresh-process reopening, state and deadline inspection. Reopening does not implicitly create, resume or extend lifetime. Live reopening validation remains pending.
- [PR #39](https://github.com/pandemicsyn/sandbar/pull/39): removal of the optional service and management UI. The project now focuses on the SDK and adapter API.

## Recently completed SDK DX

| Work                         | Merged implementation                                                                                                       | Remaining boundary                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read cancellation            | [PR #51](https://github.com/pandemicsyn/sandbar/pull/51): caller signals, consistent local read deadline and prompt cleanup | Local observation cancellation, not remote workload termination; updated live file scenario not yet qualified                                                  |
| E2B text streaming           | [PR #52](https://github.com/pandemicsyn/sandbar/pull/52): one start, separate text output, confirmed exit and local detach  | Finite bounded text; no remote kill, process reopening, binary streaming or Daytona streaming; live scenario not run                                           |
| Output helpers               | [PR #53](https://github.com/pandemicsyn/sandbar/pull/53): full decoding and structured previews                             | Display shortening remains distinct from capture loss; entirely local helpers need no live qualification                                                       |
| Bounded-exec timeout clarity | [PR #54](https://github.com/pandemicsyn/sandbar/pull/54): provider docs and native-boundary fixtures                        | Existing execution behavior is unchanged; E2B RPC timeout does not prove termination, and deployed descendant termination remains unverified for Daytona/Modal |
| Configured lifetime renewal  | [PR #55](https://github.com/pandemicsyn/sandbar/pull/55): `renew()` / `renew({ forSeconds })` for Daytona and E2B           | Adapter-owned defaults, units and rounding; live renewal scenarios not run                                                                                     |

Contracts and evidence: [execution](specs/interactive-execution-and-access.md), [output and timeouts](specs/output-and-timeouts.md), and [lifecycle](specs/sandbox-lifecycle.md). These slices are merged, not an outstanding coding queue.

Cleanup policy precedence remains per-call choice, `cleanup.storage`, then `require-durable`. `allow-unconfirmed` permits compute destruction without promising flushed writes or deleting retained volumes. See the [state contract](specs/provider-state-portability.md#3-persistent-volumes-and-mount-sessions).

## Next: lifecycle, everyday workflows, then preview and process control

**Suspend/resume is the next implementation slice.** Reopening and configured renewal are merged. The accepted [lifecycle contract](specs/sandbox-lifecycle.md#accepted-direction-and-implementation-documentation) calls for no-argument `suspend()` / `resume()`, native defaults, and meaningful preservation requirements configured once in the adapter. Filesystem preservation is a minimum; report memory/process behavior and actual execution evidence honestly.

Keep this one bounded slice: Daytona containers and E2B memory pause, same logical resource, explicit unsupported behavior and no hidden replacement. Mounted suspension, snapshot emulation, filesystem-only E2B mode and a generic lifecycle engine remain out of scope. Update adapter options, provider docs, deterministic/packed tests and maintained live scenarios together; implementation does not authorize paid runs.

After this active slice, prioritize the ordinary application workflow:

1. **[Default creation and everyday files](specs/sandbox-basics-dx.md).** Configure an environment once and call `sandboxes.create()`; add UTF-8 text helpers, then focused directory primitives. Preserve explicit overrides, byte APIs, blocked networking defaults and clear unsupported behavior. Deliver in small PRs.
2. **[Preview access and useful process control](specs/preview-and-process-control.md).** Obtain access to a sandbox port, deliberately terminate a started command, then scope stdin and sustained output. First settle native access protection and execution identity; the brief's signatures are proposals. Preview and termination can ship independently. PTYs, tunnels and a generic process platform are not prerequisites.
3. **Storage composition.** Continue the current design research, then schedule coding against concrete mounted snapshot/restore requirements after these everyday DX gaps. Research completion alone does not move storage ahead of the queue.

For storage, current unsupported combinations remain explicit. Capacity/placement, attach/detach, volume versions, stronger visibility/durability/locking/rename semantics and native forks follow demonstrated need. See [storage follow-ups](specs/sdk-recovery-dx.md#later-volume-guarantees-and-mounted-restore). Expanded persistence hooks, normalized recovery-facts envelopes and generic continuation/workflow machinery remain deferred.

## Qualification gaps

The generated [support table](apps/docs/src/content/docs/docs/providers/support.md) separates implementation from live evidence. Current follow-ups are:

- Run the maintained scoped-reopening and lifetime-renewal scenarios for Daytona and E2B after explicit paid-run authorization; both workflows are currently marked not-run.
- Qualify the new E2B streaming scenario and signal-bearing file-read cases. Earlier execution/file passes do not establish these new behaviors. Streaming is implemented even though the generated feature table does not yet have a separate streaming row; include that reporting follow-up when recording evidence.
- Investigate and disposition the recorded failed E2B network probe. Fix an integration defect if found, or document the demonstrated provider/configuration limitation; do not promote the result to a pass without evidence.
- Preserve the distinction between E2B volume account access blocked by HTTP 403 and Sandbar E2B mounts being unsupported. Resolve the historical volume-creation uncertainty only with sufficient evidence; newer successful cleanup does not erase it.

Use the existing Bun suites and generated docs. Historical passes cover their recorded revision/configuration; offline fixtures do not qualify live behavior. This roadmap does not authorize paid calls or require a new testing framework.

## Gate before new adapters

Vercel, Tensorlake and other adapters remain behind SDK usability. Before scheduling one, review whether applications can create/execute/transfer files, save and reopen supported resources, handle partial or uncertain outcomes, manage supported lifecycles and output, and clean up with clear retained-storage ownership. Tested public examples and the maintained acceptance suites must make those workflows understandable. Resolve or explicitly disposition material qualification failures and missing evidence.

This milestone does not require universal provider parity. Reassess material DX gaps with the user before scheduling new adapters; completing one small streaming slice does not automatically satisfy the gate.

## Later

Beyond the scheduled preview/process basics, advanced terminals, tunnels and storage extensions follow demonstrated needs. Additional observability metrics/events and accounting remain deferred. The removed service and management UI are not on the delivery queue. Rust is not planned. [Detailed plans](plans/implementation-plan.md) do not override this queue.
