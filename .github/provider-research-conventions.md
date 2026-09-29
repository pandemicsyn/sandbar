# Provider research issue conventions

Use one research issue per sandbox product, updating it as evidence changes. These conventions apply to the [issue template](ISSUE_TEMPLATE/provider-research.md) and [research skill](../.agents/skills/provider-research/SKILL.md).

## Naming

Title: **`[Provider research] <Official product name>`**, for example `[Provider research] Vercel Sandbox`. Use the provider's official capitalization and exact sandbox product name. Do not append status, capability lists or implementation promises to the title. Preserve an established product name unless the provider renames it. Record a stable lowercase hyphenated provider key in the body, reusing an existing adapter name when available; the issue title is a display name, not a package-name reservation.

## Labels

The [label manifest](provider-research-labels.json) defines exact names, descriptions and colors. Apply:

- `provider-research`.
- Exactly one of `research:researching`, `research:ready`, `research:blocked`.
- Exactly one `native:<capability>:<status>` label for each capability below, including unknowns.

`research:ready` means the proposed slice has enough evidence and decisions to implement. Optional unsupported features do not block readiness. `research:blocked` means a required part of that slice cannot proceed; explain the blocker. These labels do not mean an adapter is implemented, merged or live-qualified. Closing a research issue does not certify an adapter either; link its implementation issue/PR separately.

On updates, replace the old label within each managed family and keep unrelated labels. Do not accumulate contradictory statuses, create synonyms or create one label per provider. The template starts with `research:researching` and all native capabilities unknown. The skill applies researched values when filing the completed brief. GitHub's Markdown template does not enforce these invariants; check them when filing or updating.

## Capability statuses

These describe native behavior in the explicitly researched product/configuration, not Sandbar support:

| Status        | Meaning                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supported`   | Positive evidence establishes the capability's baseline below. Document its bounds and subfeatures; this is not a promise of every advanced feature or a live test pass.               |
| `unsupported` | Authoritative evidence establishes absence. Include a citation and consequence for the adapter. Missing docs, failed credentials or a Sandbar gap do not establish native absence.     |
| `conditional` | Known partial support or a material prerequisite (tier, region, image class, preview access, etc.) limits the baseline. State exactly what works and what does not.                    |
| `unknown`     | Evidence is missing, stale or conflicting. State the question and what would resolve it. A capability omitted from the requested research scope remains unknown with that explanation. |

For example, no native snapshot facility is `native:snapshots:unsupported`; documented capture without a restore API is `conditional`; a restore API that could not be located is `unknown`. A native snapshot feature that Sandbar cannot currently express still gets its native status, with `contract extension needed` recorded separately. Apply this distinction to every capability.

## Capability baselines

| Capability key   | Baseline and details to record                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle`      | Create, readiness, inspect/reconnect, inventory and confirmed compute deletion.                                                                      |
| `exec`           | Run commands with results/exit status; record argv/shell, streaming, detached processes and PTY separately.                                          |
| `files`          | Read and write sandbox files; record binary fidelity, bounds, transfer and atomic no-clobber separately.                                             |
| `snapshots`      | Capture, inspect, restore the captured immutable state and safely delete its artifact; record memory, filesystem and mount scope.                    |
| `volumes`        | Create, inspect, mount, reopen retained storage and delete it independently of compute; record storage guarantees.                                   |
| `egress`         | Enforce caller-selected outbound restrictions; record allowed destinations, protocols, provider exceptions and tiers.                                |
| `ingress`        | Expose sandbox services through documented endpoints; record authentication, ports, tunnels and private access.                                      |
| `suspend-resume` | Suspend and resume the same sandbox execution state; ordinary stop/start alone does not establish support.                                           |
| `recovery`       | Identify and reconcile prior mutations after a lost response or fresh process; record which operations remain unreconcilable.                        |
| `typescript-sdk` | Official typed SDK for the sandbox product; record operation coverage, runtime support and REST fallback.                                            |
| `observability`  | Native operation diagnostics such as request IDs, logs or status; record tracing/propagation/metrics separately, without implying full OTel support. |

Use the detailed evidence map for subfeatures. For example, execution can be supported while PTY is unsupported, files can be supported without atomic no-clobber, and observability can supply request IDs without tracing. Record those explicit negatives rather than letting a broad label imply feature parity. Material limitations to the baseline make its aggregate status conditional; unresolved evidence for the baseline makes it unknown.

## Required issue content

Keep the template's section headings and every capability-summary row. Start with the recommendation and an at-a-glance native capability summary. Each row contains a canonical status, one-line limitation, source IDs and the separate Sandbar mapping (`fits current API`, `contract extension needed`, or `out of scope`). Match its label exactly. Use `unknown` plus a reason instead of blanks or deleting an unsupported section; unsupported sections need the evidence and adapter consequence, not unanswered boilerplate.

The detailed map records exact methods/endpoints and per-operation restrictions. Evidence provenance is a separate field: docs, pinned source, or authorized live observation with version/date. Do not use “documented” or “live” as a capability status. Include the target configuration, research date, native/Sandbar versions, default workflow, real options, implementation checklist, validation plan and unresolved questions. Neither labels nor summary rows replace the underlying citations.

When evidence changes, update the body and labels together, retain material decisions and explain changed conclusions. Keep private IDs, recovery references, credentials and raw logs out of issues.
