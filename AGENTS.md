# Sandbar working agreements

## Current implementation

PRs #1–#8 are merged: fake-provider service and management UI, portable core, direct/remote TypeScript SDK, runtime qualification, and the public documentation source. Preserve current-version safety guarantees. The user-approved SDK-first refactor may replace unpublished APIs without compatibility layers. Provider implementation and isolated Effect research are coordinated by manager chat `01a0db94-f78d-70f3-83dd-106d28e38da3`; Effect research is parked: do not wake, monitor, repair or merge it as part of the active SDK and release work.

Follow the accepted [package and adapter conventions](specs/package-conventions.md) for public names, imports and provider scope. E2B and additional providers are plans, not new implementation authorization.

Read [specs/README.md](specs/README.md) for current contracts and clearly marked proposals, and [plans/implementation-plan.md](plans/implementation-plan.md) for sequencing. Public documentation lives in `apps/docs`. Historical drafts and completed handoffs live under `specs/archive` and `plans/archive`; they do not override current executable contracts or user decisions.

## Ownership and integration

Keep changes in the assigned checkout. Coordinate shared root files and final parent commits through the manager; do not rebase active author branches onto provisional work. Direct mode must not depend on the service, SQL storage or a hidden bridge. Service authentication, durable scheduling and credential custody remain outside the portable core.

The manager performs sequential implementation merges only after the authorized review, validation, CI and GitHub feedback gates clear. Authors do not merge independently. No package publication, production deployment or paid/live provider operation is authorized by these working agreements. Preserve user files and archive completed author chats after handoff.

## Mandatory PR review gate

Before creating **any** PR, including a draft, run an independent static code review using a subagent with model `gpt-6-luna` and `reasoning_effort: high`. Give the reviewer the spec, worktree paths, base ref and SHA, complete diff, validation results, and ask it to inspect the code independently. Review agents are read-only.

Address **every actionable finding**, regardless of severity, rerun relevant checks, and request another independent review of the complete resulting diff. Repeat until the final reviewer reports **zero remaining actionable findings**. Do not self-waive findings or create a PR if reviewer access or findings are unresolved. Any subsequent rebase, integration, or code change requires a fresh review of the changed result before PR creation.

Record each review round, reviewer model and effort, findings and fixes, test results, and final reviewed HEAD and base SHAs in a local review report. Summarize that provenance in the PR body. Commit and push are allowed before this gate; PR creation is not.
