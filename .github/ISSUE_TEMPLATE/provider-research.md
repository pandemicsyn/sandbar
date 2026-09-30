---
name: Provider candidate
about: Research a sandbox provider and prepare an evidence-backed adapter implementation brief.
title: "[provider-candidate]: <Official product name>"
labels: "provider-candidate, target:unknown"
---

<!-- Use $provider-research. Follow .github/provider-research-conventions.md for naming, labels and status meanings. Replace the title placeholder. Give each fact one home; reference decision IDs and recipe names elsewhere. Remove instructional text when filing. -->

## Implementation brief

Keep this opening to roughly 200 words: recommendation and target, minimum useful end-to-end user workflow, initial defaults, selected/deferred scope, and the next actionable step. Link to decision IDs for consequential unknowns instead of restating their evidence. Highlight any proposed omission of an essential operation, such as execution or cleanup.

- Research completeness (`incomplete` / `complete`):
- Implementation readiness (`ready` / `conditional` / `blocked`) for the named scope; genuine prerequisites and what can start now:

## Provider and target

- Official product name, stable provider key, homepage and docs:
- Research date, Sandbar revision, native API/SDK version and source revision:
- Official TypeScript SDK package/repository; or evidence of absence/unknown availability:
- Researched configuration: account tier, region, image/runtime class, hosted/self-hosted:
- Target (`builtin` / `external` / `unknown`, matching the label) and proposed transport:
- Target rationale with sources: actual chosen dependencies/runtime, licensing, packaging and maintenance tradeoffs. Distinguish accepted project policy from technical suitability; unused SDK dependencies are only an alternative's cost:
- Related or superseded issues/PRs and accepted decisions:

## Capability matrix

Keep every row. Native status is `supported`, `unsupported`, `conditional`, or `unknown`; absent documentation means unknown. Use short cells with sources and references to recipes/decisions for detail. Sandbar mapping is `fits current API`, `contract extension needed`, or `out of scope`. Native support does not establish Sandbar implementation or live qualification.

| Capability       | Native status | Native API / key guarantee or limitation / source | Sandbar mapping; recipe or decision |
| ---------------- | ------------- | ------------------------------------------------- | ----------------------------------- |
| `lifecycle`      | unknown       | Not researched                                    |                                     |
| `exec`           | unknown       | Not researched                                    |                                     |
| `files`          | unknown       | Not researched                                    |                                     |
| `snapshots`      | unknown       | Not researched                                    |                                     |
| `volumes`        | unknown       | Not researched                                    |                                     |
| `egress`         | unknown       | Not researched                                    |                                     |
| `ingress`        | unknown       | Not researched                                    |                                     |
| `suspend-resume` | unknown       | Not researched                                    |                                     |
| `recovery`       | unknown       | Not researched                                    |                                     |
| `typescript-sdk` | unknown       | Not researched                                    |                                     |
| `observability`  | unknown       | Not researched                                    |                                     |

For deferred features, this row or a short linked note should cover native support, constraints, sources and the next question. Do not develop future implementation recipes or test budgets unless requested.

## Decisions and open work

Classify each open item as **product decision**, **feasibility investigation**, **implementation task**, or **validation gate**. Include only material choices/gaps; no placeholder decision per capability. Put contract conflicts here with the exact Sandbar contract/revision, the proposed resolution and the affected operation. Ordinary response validation, schema mapping and tests are implementation work unless specific evidence exposes a feasibility or contract problem.

| ID / class | Question or decision; evidence / relevant contract | Recommendation / alternatives | Next action | Blocks what, and when? |
| ---------- | -------------------------------------------------- | ----------------------------- | ----------- | ---------------------- |
| D1 /       |                                                    |                               |             |                        |

Accepted decisions may be noted as settled. A complete research brief can still identify implementation blockers. Validation required before release does not automatically block starting implementation. Optional unsupported features do not block the useful scope. Do not silently weaken a guarantee or treat documenting a risk as resolving it.

## Initial implementation recipes

Describe only the selected scope. Use short named call sequences or pseudocode covering:

- Connection/configuration: separate credentials, authenticated scope verification, actual options/defaults and selected native transport/retry behavior.
- Each proposed operation: concrete public input (one real image selector for create), exact native method/endpoint and request fields, completion/readiness evidence, identity/scope checks, and relevant failure/recovery/cleanup behavior.
- Shared recovery/cleanup rules once: persisted identity and dispatch evidence, fresh-process reopen, credential rotation, observation without mutation, unknown outcomes and retained resources. Operation recipes reference this rather than repeating it.

Label uncompiled examples and illustrative responses. Reference D-items for missing prerequisites rather than inventing calls or guarantees. Link current adapter contracts for general rules; keep provider-specific mechanics here. If snapshots or volumes are in scope, cover their complete usable lifecycle and actual guarantees, not capture/allocation alone.

## Delivery and validation

- Ordered next tasks, referencing decision IDs and recipes. State what can proceed and what awaits a product decision or feasibility result:
- Provider-specific deterministic assertions for the selected scope, including consequential identity, retry, byte-fidelity and recovery boundaries:
- Packed consumer/runtime and provider-documentation work; reference the existing add-provider/qualification workflows for standard gates rather than copying their full checklists:
- Selected-scope live scenarios, what they prove, and a finite proposed resource/time/cleanup budget if a run is proposed. Authorization status defaults to not requested. Do not plan paid runs for deferred features:
- Evidence actually obtained and what remains unverified:

Before filing, check that the summary, target label/rationale, capability matrix, decisions, recipes and acceptance scope agree. Can an implementer quickly identify the scope, decisions and next steps? Remove repeated explanations; reference their primary location.

## Sources

Cite sources beside claims. Prefer official documentation and pinned source. Record date/version and distinguish documentation, source inspection and authorized live observation; label inference or conflicting evidence. Keep credentials, private IDs, recovery references and raw logs out of the issue.

| ID  | Official URL / section or pinned source | Version / access date / provenance |
| --- | --------------------------------------- | ---------------------------------- |
| S1  |                                         |                                    |

<!-- Optional: add a collapsed <details> appendix for substantial evidence needed to assess a claim. Do not move duplicate prose there merely to hide it. -->
