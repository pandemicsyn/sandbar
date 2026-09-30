# Provider research issue conventions

Use one research issue per sandbox product, updating it as evidence changes. These conventions apply to the [issue template](ISSUE_TEMPLATE/provider-research.md) and [research skill](../.agents/skills/provider-research/SKILL.md).

## Naming

Title: **`[provider-candidate]: <Official product name>`**, for example `[provider-candidate]: Vercel Sandbox`. Use the provider's official capitalization and exact sandbox product name. Do not append status, capability lists or implementation promises to the title. Preserve an established product name unless the provider renames it. Record a stable lowercase hyphenated provider key in the body, reusing an existing adapter name when available; the issue title is a display name, not a package-name reservation.

## Labels

The [label manifest](provider-research-labels.json) defines exact names, descriptions and colors. Apply `provider-candidate` and exactly one of `target:builtin`, `target:external`, or `target:unknown`. These are the only labels managed by this workflow. Keep capability statuses and research readiness in the issue body.

On updates, replace the old target label and preserve unrelated labels. Remove superseded `provider-research`, `research:*` and `native:*` labels from migrated research issues. Do not create provider-specific, capability or research-status labels. The template starts with `provider-candidate` and `target:unknown`. GitHub's Markdown template does not enforce these invariants; check them when filing or updating.

## Choose the distribution target

Record the recommendation, its dependency/runtime evidence, and unresolved tradeoffs in the issue. The target is a packaging recommendation, not a claim that the adapter is implemented, merged, live-qualified or approved for a release.

- **`target:builtin`**: a maintained usable TypeScript SDK and conventional dependencies fit Sandbar's supported Node/Bun runtimes and bundling. Confirm package size/transitive dependencies, platform requirements, licensing, import behavior and native transport stability before recommending that every SDK installation carry them.
- **`target:external`**: unusual or heavy dependencies, Python/another runtime, mandatory CLI/native tools, private/version-sensitive transports, or lack of a usable official TypeScript SDK justify a separately installed adapter. Modal is the project's example of an external adapter; cite its actual dependency/transport facts rather than assuming it lacks TypeScript support. No TypeScript SDK defaults to external even when a REST implementation is feasible.
- **`target:unknown`**: insufficient evidence to choose. Identify what package/runtime/API information would resolve it; do not infer built-in suitability merely from an npm package's existence.

Honor an explicit user choice or existing accepted distribution decision in [package conventions](../specs/package-conventions.md). If research suggests changing it, state the proposed change separately; applying a label does not migrate an existing adapter. A TypeScript SDK alone does not guarantee a built-in recommendation. Missing optional native features, such as snapshots, do not by themselves force external distribution.

Report two independent facts in the body: **research completeness** (`incomplete` / `complete`) and **implementation readiness** (`ready` / `conditional` / `blocked`) for the named slice. A complete brief can identify an unresolved implementation blocker. Ready means no unresolved design/research prerequisite blocks starting that slice; implementation tests still remain. Conditional means a named subset can proceed while other paths await a decision; blocked means the proposed useful slice cannot proceed. Optional unsupported features do not automatically block it. Neither status certifies a released adapter. Link implementation issues/PRs separately.

Separate accepted distribution policy from technical suitability. Evaluate dependencies, runtime requirements and maintenance costs of the chosen transport. SDK dependencies that a proposed REST implementation will not install are costs of an alternative, not that implementation's costs. Record evidence for the actual target recommendation and any proposed policy change.

## Capability statuses

These describe native behavior in the explicitly researched product/configuration, not Sandbar support:

| Status        | Meaning                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supported`   | Positive evidence establishes the capability's baseline below. Document its bounds and subfeatures; this is not a promise of every advanced feature or a live test pass.               |
| `unsupported` | Authoritative evidence establishes absence. Include a citation and consequence for the adapter. Missing docs, failed credentials or a Sandbar gap do not establish native absence.     |
| `conditional` | Known partial support or a material prerequisite (tier, region, image class, preview access, etc.) limits the baseline. State exactly what works and what does not.                    |
| `unknown`     | Evidence is missing, stale or conflicting. State the question and what would resolve it. A capability omitted from the requested research scope remains unknown with that explanation. |

For example, no native snapshot facility is `unsupported`; documented capture without a restore API is `conditional`; a restore API that could not be located is `unknown`. A native snapshot feature that Sandbar cannot currently express still gets its native status, with `contract extension needed` recorded separately. Apply this distinction to every capability.

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

Use the capability matrix for brief subfeature limitations and link selected-scope recipes when detail is needed. For example, execution can be supported while PTY is unsupported, files can be supported without atomic no-clobber, and observability can supply request IDs without tracing. Record those explicit negatives rather than letting a broad label imply feature parity. Material limitations to the baseline make its aggregate status conditional; unresolved evidence for the baseline makes it unknown.

## Required issue content

Use the template's compact structure: opening brief, provider/target facts, one capability matrix, one decision table, initial recipes, delivery/validation and sources. Keep all capability rows; use `unknown` with a reason instead of blanks. The matrix records native status, key API/guarantee/limitation and source, plus Sandbar mapping (`fits current API`, `contract extension needed`, or `out of scope`). Evidence provenance is docs, pinned source or authorized live observation; it is not a capability status.

Give each fact one primary home. The brief summarizes the user outcome and next step; the decision table holds material tradeoffs and contract conflicts with links to the current contract. Recipes hold concrete calls for the selected scope. Delivery/validation references those recipes and decision IDs rather than repeating their explanations or the repository's standard checklists. Keep deferred capabilities to native support, material constraints, sources and future questions; no detailed future designs or run budgets unless requested. An optional collapsed appendix may hold necessary supporting evidence, not duplicate prose.

Classify open work consistently:

| Class                     | Use when                                                                     | Readiness effect                                                               |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Product decision          | Scope, user-visible behavior or an accepted policy needs choosing            | Name the affected path and decision needed before implementing or shipping it  |
| Feasibility investigation | Evidence leaves it unclear whether an essential guarantee can be met         | Name the smallest investigation and what its result would unblock              |
| Implementation task       | Known behavior needs coding, schema mapping, response validation or fixtures | Ordinary work to start, not a research blocker by itself                       |
| Validation gate           | Implemented behavior needs deterministic, packed or authorized live proof    | Gates the relevant support/release claim, not necessarily implementation start |

A specific discovered defect or contract conflict can turn an apparently routine task into a prerequisite; state the evidence. Do not classify every unfinished task as blocked. Highlight omitted essential operations through a product decision rather than quietly reducing the useful workflow. Unknowns can remain if they are explicit and actionable.

Before filing, check that an implementer can quickly find scope, decisions and next steps. Reconcile the summary, target label/rationale, capability matrix, decisions, recipes, readiness and acceptance scope, and remove repeated explanations. When evidence changes, update its primary location and affected conclusions; preserve material decisions and keep private IDs, recovery references, credentials and raw logs out of issues.
