---
name: provider-research
description: Research a sandbox provider and draft or update a GitHub issue that maps native APIs and guarantees to a Sandbar adapter implementation brief. Use before implementing a provider or investigating gaps in an existing adapter.
---

# Research a Sandbar provider

Produce a source-backed implementation brief using the repository's [provider research issue template](../../../.github/ISSUE_TEMPLATE/provider-research.md). That template is the canonical research checklist; do not maintain a second provider dossier in specs. Research can conclude that a useful partial adapter is feasible while snapshots or other native features are unavailable.

## Establish the target

Identify the provider's exact sandbox product, requested scope, repository and any supplied issue. Read an existing issue and its relevant discussion before updating it; preserve user decisions and unrelated content. Search that repository for prior provider research before proposing a duplicate.

Read the current public adapter exports in `packages/adapter/src/index.ts`, the [capability guide](../../../apps/docs/src/content/docs/docs/guides/adapter-capabilities.md), and [package conventions](../../../specs/package-conventions.md). For snapshots/volumes, read the relevant sections of [state portability](../../../specs/provider-state-portability.md) and check the actual implemented types. Consult [recovery DX](../../../specs/sdk-recovery-dx.md) when a mapping needs its planned capabilities. Record the Sandbar revision: proposals, current exports and native provider support are separate facts.

## Gather evidence

Browse current official documentation, API references, changelogs and the exact native SDK source/version. Prefer pinned source permalinks for identity, retry, idempotency and deletion behavior. Record access dates and version/tier/region restrictions. An SDK method name alone is not evidence of its semantics; inspect request construction and underlying endpoints where necessary.

Fill the template with concise implementation facts and sources near the claims. Mark undocumented behavior unknown, explicitly absent behavior unsupported, and conditional support with its prerequisites. Label inferences and contradictions; explain which source supports the proposed mapping and what still needs confirmation. Keep research status separate from Sandbar implementation and qualification status. Public documentation or source inspection is not a live pass.

For supported operations, specify exact methods/endpoints, identifiers, readiness/completion evidence, error/retry behavior and an implementable call sequence. Focus especially on:

- Authenticated scope verification and provider SDK retries: identify a real native read and a transport that can avoid hidden mutation replay.
- The complete snapshot capture/inspect/restore/delete path, immutable identity vs mutable aliases, filesystem/memory/mount scope, source lifecycle, and cleanup granularity. `box.snapshot()` should use the simplest native default; configuration exposes only actual choices. Do not invent a filesystem-only option for a memory-inclusive native snapshot or emulate missing snapshots with archives.
- Storage behavior and network enforcement as observable guarantees, not conclusions inferred from a product label or a requested policy flag.
- Recovery across a crash or fresh invocation: application-persistable, credential-independent references; distinguish never dispatched, uncertain dispatch and confirmed effects. Observation remains read-only. Unreconcilable operations stay explicit limitations.

For broad requests, prioritize the first useful adapter slice and mark remaining rows unknown/out of scope with a reason. Do not turn every optional feature into a prerequisite. If the native feature cannot fit today's contract, name the narrow contract gap rather than inventing a generic provider-options escape hatch.

## Make the issue actionable

Finish with proposed defaults and configuration signatures, an ordered implementation checklist, open design decisions and acceptance evidence. Label uncompiled API sketches; use real current exports for examples claimed to work. A useful handoff identifies the native calls and failure boundaries an implementer must test, not merely a list of documentation links.

Use [add-provider](../add-provider/SKILL.md) for implementation constraints and [qualify-provider](../qualify-provider/SKILL.md) for the acceptance plan when new guarantees are proposed. Plan deterministic fixtures, packed consumer examples and relevant live harness extensions separately. Research does not authorize live provider calls, billable resources or certification; propose a finite budget and cleanup plan when live evidence would resolve a blocker. Never include secrets or private recovery/custody data in a public issue.

Before handing off, check that every in-scope capability has native evidence or an explicit unknown, a proposed mapping, and a validation gap. Check that snapshot support means a usable restore and cleanup path, and that network claims state their exceptions. Unresolved required guarantees block only the affected implementation scope.

## Save and hand off

When the user asks to file or update a GitHub issue, use the selected repository's GitHub tools or `gh` to publish the brief. For `gh`, write the rendered Markdown body to a file and use `--body-file`; remove the template's YAML frontmatter and instructional HTML comments. Update an existing research issue when appropriate and preserve its unrelated decisions. Do not create labels, milestones or extra issues unless requested.

If the request is research-only or publishing is not authorized, deliver the same completed issue body as a draft. If GitHub access fails, retain that draft and report the limitation. Return the issue URL (or draft location), implementation readiness and consequential unknowns. Recheck time-sensitive or conflicting evidence when implementation starts; the issue is a guide, not authority to override current contracts or authorize extra work.
