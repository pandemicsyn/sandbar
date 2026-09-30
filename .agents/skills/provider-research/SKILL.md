---
name: provider-research
description: Research a sandbox provider and draft or update a GitHub issue that maps native APIs and guarantees to a Sandbar adapter implementation brief. Use before implementing a provider or investigating gaps in an existing adapter.
---

# Research a Sandbar provider

Use the [issue template](../../../.github/ISSUE_TEMPLATE/provider-research.md) to produce a concise, source-backed implementation brief. Keep the issue as the research record; do not create a duplicate provider dossier in specs. The goal is to let an implementer identify the useful scope, decisions and next tasks quickly.

## Start with a provider link

Look for a provider homepage or official docs URL in the request, earlier conversation, or an issue the user supplied. If none is available, ask: “Can you share a link to the provider's website or sandbox documentation?” Wait for the link instead of guessing the product from its name. Do not ask again when a usable link is already supplied.

Open that page to identify the exact sandbox product and follow its official docs/API/SDK links. A homepage is enough. If the link is inaccessible or ambiguous, explain the problem and request an accessible link or clarification. Record the starting URL in the issue.

## Establish scope and conventions

Read the [issue conventions](../../../.github/provider-research-conventions.md) and [label manifest](../../../.github/provider-research-labels.json). Use `[provider-candidate]: <Official product name>`, `provider-candidate`, and exactly one `target:builtin`, `target:external`, or `target:unknown`. Record the target rationale using the chosen implementation's dependencies/runtime; distinguish accepted policy from technical suitability and unused alternatives' costs.

Read supplied issues/discussion, preserve user decisions, and search the selected repository for prior research before proposing a duplicate. If instructed not to consult earlier research, state that limitation rather than claiming none exists.

Read current `packages/adapter/src/index.ts`, the [capability guide](../../../apps/docs/src/content/docs/docs/guides/adapter-capabilities.md), [package conventions](../../../specs/package-conventions.md), and [add-provider](../add-provider/SKILL.md). For state features, consult the relevant [state portability](../../../specs/provider-state-portability.md) sections and implemented types; [recovery DX](../../../specs/sdk-recovery-dx.md) is planned direction. Record the Sandbar revision. Native support, current exports and proposals are separate facts.

## Research to the needed depth

Browse official docs, API references, changelogs and the exact SDK/source version. Pin source evidence where it matters for identities, hidden retries, automatic effects and deletion. Cite consequential claims with version/date; distinguish documented support, source inspection and authorized live evidence. Missing or conflicting evidence stays unknown, not unsupported. Native support never implies a Sandbar implementation or live pass.

Classify all 11 capabilities in the single matrix. State important missing subfeatures even when the baseline is supported. Investigate the selected scope deeply enough for concrete native call sequences, completion evidence, authenticated identity/scope, retry behavior, bytes/bounds, network enforcement and recovery/cleanup. For deferred features, record native support, material constraints, sources and future questions briefly; do not design their implementations or qualification campaigns.

When state work is selected, research full capture/inspect/immutable restore/delete and volume create/mount/reopen/delete lifecycles, as applicable. Establish actual filesystem/memory/mount scope, source orchestration, retention, dependency checks and independent storage guarantees. No native feature means explicit unsupported, not an invented archive/emulation layer. Recovery uses bounded, credential-independent references; observation stays read-only. Link the current contract rather than reproducing it in every recipe.

## Write a concise handoff

Give each fact one primary home:

- Opening brief: roughly 200 words on the recommendation, useful user workflow, scope/defaults and next step. Reference decision IDs for blockers.
- Provider/target: identity, versions, environment and packaging/transport rationale.
- One capability matrix: short native status/evidence and Sandbar mapping, with links to detail.
- One decision table: material choices, contract conflicts and open work, with evidence, alternatives, next action and affected operation/stage.
- Initial recipes: concrete mechanics only for selected operations; shared recovery/cleanup once.
- Delivery/validation: ordered tasks and provider-specific proof, referencing decisions and recipes. Use [qualify-provider](../qualify-provider/SKILL.md) for standard acceptance rules rather than copying them.

Classify open items as **product decision**, **feasibility investigation**, **implementation task**, or **validation gate**. Ordinary schema mapping, response validation and fixtures belong to implementation unless evidence exposes a deeper problem. A test required before release does not itself block starting work. Research can be complete while a feasibility issue remains; optional absent capabilities need not block the useful slice. Highlight a product decision if essential execution or cleanup is omitted instead of silently shrinking the promised workflow.

Check proposed defaults and guarantees against Sandbar contracts, including orchestration beyond the native endpoint. Put a conflict and proposed resolution in the decision table, not a separate compatibility inventory. Do not weaken contracts, invent authority or treat a risk caveat as a fix. Examples must be labeled proposed/uncompiled unless validated; include concrete inputs such as an image selector where useful.

Avoid repeated API inventories and warnings across tables, prose, recipes and tests. Cross-reference a decision ID or recipe instead. Use a collapsed evidence appendix only when substantial supporting detail is necessary; remove duplicates rather than hide them. Stop broad research once the requested scope has evidence or specific actionable unknowns; do not expand it to resolve every deferred feature.

Before publication ask: **Can an implementer identify the scope, decisions and next steps quickly, and have we repeated anything unnecessarily?** Reconcile the summary, target rationale/label, matrix, decisions, recipes, readiness and acceptance scope. Preserve consequential evidence while cutting repetition.

## Save and hand off

When asked to file/update an issue, use GitHub tools or `gh` in the selected repository. For `gh`, render the body to a file and use `--body-file`, removing template frontmatter and instructions. Pass labels explicitly; the body-file flag does not apply template labels. Replace stale target or superseded research/capability labels, preserve unrelated labels and decisions, and create only missing convention labels from the manifest. Read back title/body/labels to verify. Do not create extra issues or milestones without a request.

Research alone does not authorize publication, live provider calls or billable resources. If filing is not requested, return the same brief as a draft; if access fails, retain the draft and explain. Propose a finite budget/cleanup plan only for live work relevant to selected scope, with authorization separate. Never publish secrets or private custody data. Return the issue URL or draft location, readiness and consequential unknowns; the brief does not override current contracts or authorize implementation.
